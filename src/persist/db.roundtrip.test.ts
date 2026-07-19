// Round-trip tests against a real IndexedDB implementation (fake-indexeddb).
// db.test.ts covers the opposite case — no IndexedDB at all — so between them
// both branches of `getDb()` are exercised.
//
// The import below must run before ./db is imported, because getDb() decides
// once, at first call, whether IndexedDB exists. Vitest hoists imports in source
// order, so keep this first.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import Dexie from 'dexie'
import type { PositionEval } from '../domain/gameRecord'
import { saveGame, listGames, getGame, lastGame, countGames, deleteGame, gameKind, type StoredGame } from './db'

function game(overrides: Partial<StoredGame> = {}): StoredGame {
  return {
    gameId: 'g1',
    yourColor: 'w',
    level: 1500,
    sanHistory: ['e4', 'e5', 'Nf3'],
    outcome: 'you',
    reason: 'checkmate',
    accuracy: 87.5,
    takebacks: 2,
    createdAt: 1000,
    ...overrides,
  }
}

// Start every test from an empty table. db.ts caches its Dexie instance for the
// module's lifetime, so we clear through a second connection rather than deleting
// the database out from under it. Opening with no declared schema puts Dexie in
// dynamic mode, which keeps the schema defined in exactly one place — db.ts.
beforeEach(async () => {
  const d = new Dexie('etude-chess')
  try {
    await d.open()
    await d.table('games').clear()
  } catch {
    // First run: db.ts hasn't created the database yet, so there is nothing to clear.
  } finally {
    d.close()
  }
})

describe('stored games (with IndexedDB)', () => {
  it('round-trips coach data with tiers and eval labels intact', async () => {
    await saveGame(
      game({
        gameId: 'coached',
        coachLog: [
          { ply: 0, fen: 'startpos', san: 'e4', tier: 'A', swing: 0.4, bestMoveSan: 'e4' },
          { ply: 2, fen: 'later', san: 'Nf3', tier: 'C', swing: 12.5, bestMoveSan: 'Bc4' },
        ],
        evalByPly: [
          { whitePct: 52.1, label: '+0.2' },
          undefined, // eval was toggled off for this ply — the gap must survive
          { whitePct: 41.0, label: '-0.6' },
        ],
        kind: 'playout',
      }),
    )

    const loaded = await getGame('coached')
    expect(loaded?.coachLog).toHaveLength(2)
    expect(loaded?.coachLog?.[1]).toMatchObject({ tier: 'C', swing: 12.5, bestMoveSan: 'Bc4' })
    expect(loaded?.evalByPly?.[0]?.label).toBe('+0.2')
    expect(loaded?.evalByPly?.[1]).toBeUndefined()
    expect(loaded?.evalByPly).toHaveLength(3)
    expect(gameKind(loaded!)).toBe('playout')
  })

  it('preserves a genuinely sparse evalByPly', async () => {
    // The reducer builds this by `slice()` + index assignment, so when an eval
    // lands for a later ply first the array has real holes, not `undefined`s.
    // Ply indexing only stays meaningful if the holes and the length survive.
    const sparse: (PositionEval | undefined)[] = []
    sparse[3] = { whitePct: 55, label: '+0.3' }
    expect(Object.keys(sparse)).toEqual(['3']) // holes at 0..2, not undefined values

    await saveGame(game({ gameId: 'sparse', evalByPly: sparse }))

    const loaded = await getGame('sparse')
    expect(loaded?.evalByPly).toHaveLength(4)
    expect(loaded?.evalByPly?.[0]).toBeUndefined()
    expect(loaded?.evalByPly?.[3]?.label).toBe('+0.3')
  })

  it('loads a v0.2 record that predates the coach fields', async () => {
    // Exactly what v0.2 wrote: no coachLog, no evalByPly, no kind.
    await saveGame(game({ gameId: 'legacy' }))

    const loaded = await getGame('legacy')
    expect(loaded).toBeDefined()
    expect(loaded?.coachLog).toBeUndefined()
    expect(loaded?.evalByPly).toBeUndefined()
    // The default is what stops every reader having to branch on undefined.
    expect(gameKind(loaded!)).toBe('game')
    expect(loaded?.accuracy).toBe(87.5)
  })

  it('upserts by gameId so a late final grade corrects the stored accuracy', async () => {
    await saveGame(game({ gameId: 'dup', accuracy: 50, coachLog: [] }))
    await saveGame(
      game({
        gameId: 'dup',
        accuracy: 91.25,
        coachLog: [{ ply: 0, fen: 'f', san: 'e4', tier: 'A', swing: 0, bestMoveSan: null }],
      }),
    )

    const all = await listGames()
    expect(all.filter((g) => g.gameId === 'dup')).toHaveLength(1)
    expect((await getGame('dup'))?.accuracy).toBe(91.25)
    expect((await getGame('dup'))?.coachLog).toHaveLength(1)
  })

  it('lists newest first and honours the limit', async () => {
    await saveGame(game({ gameId: 'old', createdAt: 100 }))
    await saveGame(game({ gameId: 'newest', createdAt: 300 }))
    await saveGame(game({ gameId: 'middle', createdAt: 200 }))

    expect((await listGames()).map((g) => g.gameId)).toEqual(['newest', 'middle', 'old'])
    expect(await listGames(2)).toHaveLength(2)
    expect((await lastGame())?.gameId).toBe('newest')
  })

  it('lastGame is undefined when nothing has been played', async () => {
    expect(await lastGame()).toBeUndefined()
  })

  it('keeps one row per gameId when two saves race', async () => {
    // A finished game is saved more than once: a trailing eval and a late
    // final-move grade both re-fire the persist effect. Without a transaction
    // both calls read "no existing row" and each insert one, and the game shows
    // up twice in the library.
    await Promise.all([
      saveGame(game({ gameId: 'racy', accuracy: 50 })),
      saveGame(game({ gameId: 'racy', accuracy: 91.25 })),
    ])

    expect(await countGames()).toBe(1)
    expect((await listGames()).filter((g) => g.gameId === 'racy')).toHaveLength(1)
  })

  it('deletes one game and leaves the rest alone', async () => {
    await saveGame(game({ gameId: 'keep' }))
    await saveGame(game({ gameId: 'drop' }))

    await deleteGame('drop')

    expect((await listGames()).map((g) => g.gameId)).toEqual(['keep'])
    expect(await getGame('drop')).toBeUndefined()
    expect(await countGames()).toBe(1)
  })

  it('deleting a game that is not there is not an error', async () => {
    await expect(deleteGame('never-existed')).resolves.toBeUndefined()
  })

  it('countGames matches what listGames returns', async () => {
    await saveGame(game({ gameId: 'a' }))
    await saveGame(game({ gameId: 'b' }))
    expect(await countGames()).toBe((await listGames()).length)
  })
})
