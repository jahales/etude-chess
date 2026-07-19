import Dexie, { type Table } from 'dexie'
import type { Attempt } from '../domain/session'

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
}

class EtudeDb extends Dexie {
  attempts!: Table<StoredAttempt, number>
  games!: Table<StoredGame, number>
  constructor() {
    super('etude-chess')
    this.version(1).stores({ attempts: '++id, gameId, sessionId, tier, createdAt' })
    this.version(2).stores({ games: '++id, gameId, outcome, level, createdAt' })
  }
}

let db: EtudeDb | null | undefined

function getDb(): EtudeDb | null {
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

export async function saveGame(g: StoredGame): Promise<void> {
  const d = getDb()
  if (!d) return
  try {
    // Upsert by gameId so a late final-move grade can correct the stored accuracy.
    const existing = await d.games.where('gameId').equals(g.gameId).first()
    await d.games.put(existing?.id != null ? { ...g, id: existing.id } : g)
  } catch (e) {
    console.warn('etude-chess: could not persist game', e)
  }
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
