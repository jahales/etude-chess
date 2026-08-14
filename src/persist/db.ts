import Dexie, { type Table } from 'dexie'
import type { Attempt } from '../domain/session'
import type { CoachEntry, PositionEval } from '../domain/gameRecord'
// Type-only, so this stays a one-way runtime dependency: dbGames.ts imports
// `getDb` from here, and nothing here imports it back.
import type { DbGame, DbSource } from './dbGames'
import { ensurePersistence } from './storage'

// Local-first persistence (constitution: no backend/accounts in v0.1.0). Every
// committed guess is stored as telemetry for later phases. All access is
// best-effort: if IndexedDB is unavailable, the app runs from memory and never
// throws (docs/decisions/0011).

export interface StoredAttempt extends Attempt {
  id?: number
  gameId: string
  sessionId: string
  createdAt: number
}

/** A finished play-vs-Maia game (v0.2), stored for later review + leak analytics. */
export interface StoredGame {
  id?: number
  gameId: string
  yourColor: 'w' | 'b'
  level: number
  sanHistory: string[]
  outcome: 'you' | 'maia' | 'draw'
  reason: string
  /** This game's accuracy (0–100), over the moves as played. */
  accuracy: number
  /** How many moves were taken back. */
  takebacks: number
  createdAt: number
  // --- v0.3 (#46): the coach's knowledge, stored so replay never re-analyses. ---
  // All three are optional because records written by v0.2 don't have them; readers
  // must tolerate `undefined` rather than assuming a shape (docs/v0.3.0-plan.md §1).
  /** Coach verdict per move of yours, in the final line. */
  coachLog?: CoachEntry[]
  /** Eval after each ply, White's perspective. Sparse: gaps where eval was off. */
  evalByPly?: (PositionEval | undefined)[]
  /** How the game started. Absent ⇒ `'game'`; see `gameKind()`. */
  kind?: StoredGameKind
  /** When a full-game analysis pass last completed. Absent ⇒ never analysed (#68). */
  analysedAt?: number
  /** Nodes per position that pass used, so a later pass can tell if it must redo the work. */
  analysisNodes?: number
  /**
   * Evaluation of the position *before* move 0. `evalByPly` is indexed by the
   * move it follows, so without this the first move of a game has nothing to be
   * measured against and can never be scored (#74).
   */
  startEval?: PositionEval
}

/** A full game from move 1, or a position played out from somewhere else (#48). */
export type StoredGameKind = 'game' | 'playout'

/** `kind` with the default applied, so callers never branch on `undefined`. */
export function gameKind(g: StoredGame): StoredGameKind {
  return g.kind ?? 'game'
}

export class EtudeDb extends Dexie {
  attempts!: Table<StoredAttempt, number>
  games!: Table<StoredGame, number>
  // v0.3 (#53): an attached PGN database, kept deliberately apart from `games`
  // above. Those are games *you played* and carry the coach's verdicts; these
  // are games you *imported* and carry someone else's annotations. Declared
  // here because the schema for the whole database lives in one place.
  dbGames!: Table<DbGame, string>
  dbSources!: Table<DbSource, string>
  constructor() {
    super('etude-chess')
    this.version(1).stores({ attempts: '++id, gameId, sessionId, tier, createdAt' })
    this.version(2).stores({ games: '++id, gameId, outcome, level, createdAt' })
    // `key` is the primary key — the dedup key of docs/v0.3.0-plan.md §9 — so a
    // re-import overwrites rather than duplicates. The rest are the filters item
    // 10 will query on; adding one later is a version bump, not a rewrite.
    // Fields are documented on `DbGame` in dbGames.ts.
    this.version(3).stores({
      dbGames: 'key, white, black, year, eco, result, speed, minElo, source, [white+year], [black+year]',
      dbSources: 'name, importedAt',
    })
  }
}

let db: EtudeDb | null | undefined

/**
 * The one Dexie connection, or `null` where IndexedDB isn't available.
 *
 * Exported for the rest of `persist/` — `dbGames.ts` is a second adapter over
 * the same database, and two connections to one IndexedDB is a way to get two
 * schemas. Nothing outside this directory should call it.
 */
export function getDb(): EtudeDb | null {
  if (db !== undefined) return db
  if (typeof indexedDB === 'undefined') {
    db = null
    return db
  }
  try {
    db = new EtudeDb()
  } catch {
    db = null
  }
  return db
}

export async function saveAttempt(a: StoredAttempt): Promise<void> {
  const d = getDb()
  if (!d) return
  try {
    await d.attempts.add(a)
  } catch (e) {
    console.warn('etude-chess: could not persist attempt', e)
  }
}

// Persistence is requested once per session, on the first game saved — after the
// user has created something worth keeping, not on load (see storage.ts).
let persistenceRequested = false

export async function saveGame(g: StoredGame): Promise<void> {
  const d = getDb()
  if (!d) return
  if (!persistenceRequested) {
    persistenceRequested = true
    void ensurePersistence()
  }
  try {
    // Upsert by gameId so a late final-move grade can correct the stored accuracy.
    //
    // One transaction: a finished game is saved more than once (a trailing eval
    // and a late final-move grade each re-fire the persist effect), and
    // read-then-write without one lets two calls both see "no existing row" and
    // each insert.
    //
    // And a **merge**, not a replace. Two independent writers touch this row —
    // the play session and the analysis pass — from separate snapshots. A full
    // `put` meant each silently reverted the other's fields: finish a pass, let a
    // late grade land, and `analysedAt` vanished so the game offered to analyse
    // itself again.
    await d.transaction('rw', d.games, async () => {
      const existing = await d.games.where('gameId').equals(g.gameId).first()
      if (!existing) {
        await d.games.put(g)
        return
      }
      // Live evals are recorded at two different node budgets (your moves at the
      // grading budget, the opponent's at the cheaper display one). A completed
      // pass is uniform, and must not be overwritten by them.
      const analysed = existing.analysedAt != null
      const { evalByPly, ...rest } = g
      await d.games.put({
        ...existing,
        ...rest,
        ...(analysed ? {} : { evalByPly }),
        id: existing.id,
      })
    })
  } catch (e) {
    console.warn('etude-chess: could not persist game', e)
  }
}

/** Finished games, newest first. Best-effort: `[]` if IndexedDB is unavailable. */
export async function listGames(limit = 50): Promise<StoredGame[]> {
  const d = getDb()
  if (!d) return []
  try {
    // `createdAt` is indexed, so this sorts in the store rather than in memory.
    return await d.games.orderBy('createdAt').reverse().limit(limit).toArray()
  } catch (e) {
    console.warn('etude-chess: could not list games', e)
    return []
  }
}

/**
 * Write the result of a whole-game analysis pass, re-reading the record inside
 * the transaction so nothing the play session wrote in the meantime is lost.
 * The caller's copy of the game may be minutes old.
 */
export async function saveAnalysis(
  gameId: string,
  analysis: Pick<StoredGame, 'evalByPly' | 'startEval' | 'analysedAt' | 'analysisNodes'>,
): Promise<void> {
  const d = getDb()
  if (!d) return
  try {
    await d.transaction('rw', d.games, async () => {
      const existing = await d.games.where('gameId').equals(gameId).first()
      if (!existing) return
      await d.games.put({ ...existing, ...analysis, id: existing.id })
    })
  } catch (e) {
    console.warn('etude-chess: could not persist analysis', e)
  }
}

/** Remove one stored game. Not recoverable — callers confirm first. */
export async function deleteGame(gameId: string): Promise<void> {
  const d = getDb()
  if (!d) return
  try {
    await d.games.where('gameId').equals(gameId).delete()
  } catch (e) {
    console.warn('etude-chess: could not delete game', e)
  }
}

/** How many finished games are stored. Cheap: counts the index, loads no records. */
export async function countGames(): Promise<number> {
  const d = getDb()
  if (!d) return 0
  try {
    return await d.games.count()
  } catch {
    return 0
  }
}

/** One finished game by its app-level `gameId` (not the Dexie `id`). */
export async function getGame(gameId: string): Promise<StoredGame | undefined> {
  const d = getDb()
  if (!d) return undefined
  try {
    return await d.games.where('gameId').equals(gameId).first()
  } catch (e) {
    console.warn('etude-chess: could not load game', e)
    return undefined
  }
}

/** The most recently finished game, for "pick up where you left off". */
export async function lastGame(): Promise<StoredGame | undefined> {
  return (await listGames(1))[0]
}

export async function countAttempts(): Promise<number> {
  const d = getDb()
  if (!d) return 0
  try {
    return await d.attempts.count()
  } catch {
    return 0
  }
}
