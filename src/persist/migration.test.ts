// Upgrading an existing library to the schema #53 introduces.
//
// `dbGames` arrives as `version(3)`, and Dexie's rule is that a version
// declares only what *changes* — tables from earlier versions are inherited.
// So adding two tables should leave `games` and `attempts` untouched.
//
// "Should, per the documentation" is the reason this file exists. Every e2e
// spec builds its database from empty, so nothing else here opens a store that
// already has games in it, and the failure being guarded against is the worst
// one this app has: the owner opens the app after an update and their game
// library is gone. That is unrecoverable and silent — an empty library looks
// exactly like a new install.
//
// This import must run before ./db is imported: getDb() decides once, at first
// call, whether IndexedDB exists. Vitest hoists imports in source order.
import 'fake-indexeddb/auto'
import { describe, it, expect } from 'vitest'
import Dexie from 'dexie'

const DB = 'etude-chess'

/** The schema exactly as v0.2.0 shipped it, before #53 existed. */
async function openAsShippedBefore() {
  const old = new Dexie(DB)
  old.version(1).stores({ attempts: '++id, gameId, sessionId, tier, createdAt' })
  old.version(2).stores({ games: '++id, gameId, outcome, level, createdAt' })
  await old.open()
  return old
}

describe('upgrading a library written before the attached database existed', () => {
  it('keeps every played game and attempt across the version bump', async () => {
    const before = await openAsShippedBefore()
    await before.table('games').add({
      gameId: 'g-1',
      outcome: 'resign',
      level: 1500,
      createdAt: 1,
      sanHistory: ['e4', 'e5'],
      yourColor: 'w',
    })
    await before.table('attempts').add({
      gameId: 'g-1',
      sessionId: 's-1',
      tier: 'B',
      createdAt: 1,
    })
    before.close()

    // Re-open through the app's own class, which is what an update does.
    const { EtudeDb } = await import('./db')
    const db = new EtudeDb()
    await db.open()

    expect(await db.games.count()).toBe(1)
    expect(await db.attempts.count()).toBe(1)
    // Not just the row count — the fields the replay screen reads back.
    const game = await db.games.toCollection().first()
    expect(game?.gameId).toBe('g-1')
    expect(game?.sanHistory).toEqual(['e4', 'e5'])

    // And the new tables are live in the same connection, empty rather than absent.
    expect(await db.dbGames.count()).toBe(0)
    expect(await db.dbSources.count()).toBe(0)
    db.close()
  })
})
