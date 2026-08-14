/**
 * The attached game database — storage for imported PGN (#53, ADR 0018).
 *
 * Deliberately a **separate table** from `games` in db.ts. Those are games *you
 * played*, carrying the coach's verdict on each of your moves; these are games
 * you *imported*, carrying whatever annotations came with the file. They share
 * almost no fields and nothing sensible reads both at once, so keeping them
 * apart means neither has to grow an "is this actually mine?" column.
 *
 * Two decisions worth not re-deriving:
 *
 * - **Movetext is stored as text.** One byte per move (an index into the legal
 *   moves) is 5× smaller, but producing it needs legal-move generation at every
 *   ply — measured at ~12 games/sec, over two hours for a 100k-game import.
 *   CPU is the binding constraint, not storage: 100k games of raw PGN is ~76 MB,
 *   well inside Chrome's and Firefox's quotas. The byte encoding stays a
 *   documented escape hatch (docs/spikes/games-corpus.md §5).
 * - **The dedup key is the primary key.** Importing the same file twice
 *   overwrites row for row instead of doubling the database, which is what makes
 *   re-attaching after an eviction free rather than a merge problem.
 *
 * Everything here is best-effort in the same sense as db.ts — the app keeps
 * running when storage is unavailable — but an import reports its failures
 * rather than swallowing them: a quota error mid-import is something the user
 * has to know about.
 */

import { dedupKey, type GameFacts, type GameResult, type ImportedGame, type Speed } from '../domain/pgnImport'
import { getDb } from './db'

/** One imported game. Field names match `GameFacts` so the mapping stays boring. */
export interface DbGame {
  /** Primary key: White+Black+Date+Result+opening (`domain/pgnImport.dedupKey`). */
  key: string
  white: string
  black: string
  event?: string
  site?: string
  date?: string
  year?: number
  result: GameResult
  eco?: string
  whiteElo?: number
  blackElo?: number
  /** The lower of the two ratings. Absent when either is unknown — never a zero. */
  minElo?: number
  speed: Speed
  /** The `[TimeControl]` tag verbatim, so the UI can show what the file said. */
  timeControl?: string
  plies: number
  /** Mainline SAN, space-separated. Text, not a move encoding — see above. */
  movetext: string
  /** The file's own comments, by ply. Item 11 shows these at the reveal. */
  comments?: Record<number, string>
  nags?: Record<number, number[]>
  /** Provenance: the file this came from, and when it was attached. */
  source: string
  importedAt: number
}

/** One attached file, so the UI can list what is attached and offer to re-attach. */
export interface DbSource {
  /** Primary key: the file's name. Re-importing it updates this row. */
  name: string
  importedAt: number
  /** Games kept. */
  games: number
  /** Games the parser produced, kept or not. */
  parsed: number
  skipped: number
  sizeBytes?: number
}

/**
 * Rows per transaction. §9's guidance is 500–1000: Dexie sustains ~3k rec/s, so
 * a chunk is roughly a fifth of a second — small enough that progress moves and
 * large enough that per-transaction overhead stays in the noise.
 */
export const BULK_CHUNK = 500

/** Drop keys whose value is `undefined` so Dexie stores absent rather than `undefined`. */
function defined<T extends object>(record: T): T {
  return Object.fromEntries(Object.entries(record).filter(([, v]) => v !== undefined)) as T
}

/** An imported game plus its provenance → the row we store. */
export function toDbGame(
  game: ImportedGame,
  facts: GameFacts,
  provenance: { source: string; importedAt: number },
): DbGame {
  return defined<DbGame>({
    key: dedupKey(game),
    white: facts.white,
    black: facts.black,
    event: facts.event,
    site: facts.site,
    date: facts.date,
    year: facts.year,
    result: facts.result,
    eco: facts.eco,
    whiteElo: facts.whiteElo,
    blackElo: facts.blackElo,
    minElo: facts.minElo,
    speed: facts.timeControl.speed,
    timeControl: facts.timeControl.raw,
    plies: facts.plies,
    movetext: game.sanMoves.join(' '),
    comments: game.comments,
    nags: game.nags,
    source: provenance.source,
    importedAt: provenance.importedAt,
  })
}

export interface BulkPutResult {
  written: number
  /** Set when a chunk failed — a full quota, most likely. Earlier chunks stand. */
  error?: string
}

/**
 * Write games in chunked transactions.
 *
 * Reports rather than throws: an import that hits the storage quota has still
 * written everything before that point, and the caller needs to say so instead
 * of losing the whole run.
 */
export async function putDbGames(games: DbGame[], chunkSize = BULK_CHUNK): Promise<BulkPutResult> {
  const d = getDb()
  if (!d || games.length === 0) return { written: 0 }

  let written = 0
  for (let i = 0; i < games.length; i += chunkSize) {
    const chunk = games.slice(i, i + chunkSize)
    try {
      await d.dbGames.bulkPut(chunk)
      written += chunk.length
    } catch (e) {
      console.warn('etude-chess: could not store imported games', e)
      return { written, error: e instanceof Error ? e.message : 'could not store games' }
    }
  }
  return { written }
}

/** How many imported games are stored. Counts the index; loads no rows. */
export async function countDbGames(): Promise<number> {
  const d = getDb()
  if (!d) return 0
  try {
    return await d.dbGames.count()
  } catch {
    return 0
  }
}

/** Attached files, most recently attached first. */
export async function listDbSources(): Promise<DbSource[]> {
  const d = getDb()
  if (!d) return []
  try {
    return await d.dbSources.orderBy('importedAt').reverse().toArray()
  } catch (e) {
    console.warn('etude-chess: could not list attached databases', e)
    return []
  }
}

/** Record an attachment. Re-importing the same filename updates its row. */
export async function recordDbSource(source: DbSource): Promise<void> {
  const d = getDb()
  if (!d) return
  try {
    await d.dbSources.put(defined(source))
  } catch (e) {
    console.warn('etude-chess: could not record the attached database', e)
  }
}

/** Detach a file: remove its games and its record. Returns how many games went. */
export async function deleteDbSource(name: string): Promise<number> {
  const d = getDb()
  if (!d) return 0
  try {
    const removed = await d.dbGames.where('source').equals(name).delete()
    await d.dbSources.delete(name)
    return removed
  } catch (e) {
    console.warn('etude-chess: could not detach the database', e)
    return 0
  }
}
