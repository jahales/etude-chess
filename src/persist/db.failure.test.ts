// Failure paths for persistence (#80). db.ts is best-effort by contract — the app
// must keep running when storage misbehaves — but only the "no IndexedDB at all"
// branch was ever tested. These cover storage that exists and then fails, which is
// the realistic case: quota exceeded, a blocked origin, a browser in a odd state.
import 'fake-indexeddb/auto'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Dexie from 'dexie'
import { saveGame, listGames, getGame, countGames, deleteGame, type StoredGame } from './db'

function game(over: Partial<StoredGame> = {}): StoredGame {
  return {
    gameId: 'g', yourColor: 'w', level: 1500, sanHistory: ['e4'],
    outcome: 'you', reason: 'checkmate', accuracy: 90, takebacks: 0, createdAt: 0, ...over,
  }
}

beforeEach(async () => {
  const d = new Dexie('etude-chess')
  try {
    await d.open()
    await d.table('games').clear()
  } catch {
    // First run: nothing to clear.
  } finally {
    d.close()
  }
})

afterEach(() => vi.restoreAllMocks())

/** Make every Dexie transaction reject, as a quota or blocked-origin error would. */
function breakStorage(message = 'QuotaExceededError') {
  vi.spyOn(Dexie.prototype, 'transaction').mockImplementation(() => {
    return Promise.reject(new Error(message)) as never
  })
}

describe('persistence when storage fails', () => {
  it('saveGame resolves instead of throwing when the write fails', async () => {
    // A failed save must never take the app down mid-game — losing the record is
    // bad, losing the session is worse.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    breakStorage()
    await expect(saveGame(game({ gameId: 'doomed' }))).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalled() // and it is reported, not swallowed silently
  })

  it('a failed save leaves no half-written record behind', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    breakStorage()
    await saveGame(game({ gameId: 'doomed' }))
    vi.restoreAllMocks()
    expect(await getGame('doomed')).toBeUndefined()
    expect(await countGames()).toBe(0)
  })

  it('reads degrade to empty rather than throwing', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(Dexie.prototype, 'table').mockImplementation(() => {
      throw new Error('storage unavailable')
    })
    await expect(listGames()).resolves.toEqual([])
    await expect(getGame('anything')).resolves.toBeUndefined()
    await expect(countGames()).resolves.toBe(0)
  })

  it('delete failing is not an error the caller has to handle', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(Dexie.prototype, 'table').mockImplementation(() => {
      throw new Error('storage unavailable')
    })
    await expect(deleteGame('whatever')).resolves.toBeUndefined()
  })

  it('recovers once storage works again', async () => {
    // The failure is not sticky: a transient quota error must not poison the
    // cached connection for the rest of the session.
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    breakStorage()
    await saveGame(game({ gameId: 'during-outage' }))
    vi.restoreAllMocks()

    await saveGame(game({ gameId: 'after-outage' }))
    expect((await listGames()).map((g) => g.gameId)).toEqual(['after-outage'])
  })
})
