// Failure paths for the attached game database.
//
// An import is the one place in this app where a *large* amount of data is
// written at once, so hitting the storage quota is a realistic outcome rather
// than a theoretical one. The rule that follows: reads degrade silently like the
// rest of persistence, but a failed **write** is reported — a user whose import
// stopped at 40k of 100k games needs to be told.
import 'fake-indexeddb/auto'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Dexie from 'dexie'
import { getDb } from './db'
import {
  countDbGames,
  deleteDbSource,
  listDbSources,
  putDbGames,
  recordDbSource,
  type DbGame,
} from './dbGames'

const row = (key: string): DbGame => ({
  key,
  white: 'A',
  black: 'B',
  result: '1-0',
  speed: 'classical',
  plies: 20,
  movetext: 'e4 e5',
  source: 'f.pgn',
  importedAt: 0,
})

beforeEach(async () => {
  const d = new Dexie('etude-chess')
  try {
    await d.open()
    await Promise.all([d.table('dbGames').clear(), d.table('dbSources').clear()])
  } catch {
    // First run: nothing to clear.
  } finally {
    d.close()
  }
})

afterEach(() => vi.restoreAllMocks())

/** The live tables, which is where a spy has to go: Dexie 4 has no `Table` class to patch. */
const tables = () => {
  const d = getDb()
  if (!d) throw new Error('these tests need fake-indexeddb')
  return d
}

describe('the attached database when storage fails', () => {
  it('reports a failed write instead of throwing', async () => {
    vi.spyOn(tables().dbGames, 'bulkPut').mockRejectedValue(new Error('QuotaExceededError'))
    expect(await putDbGames([row('a')])).toEqual({ written: 0, error: 'QuotaExceededError' })
  })

  it('keeps the chunks it already wrote and stops at the one that failed', async () => {
    // Half an import is worth keeping: the alternative is discarding 40k games
    // because the 41st chunk hit the quota.
    const real = tables().dbGames.bulkPut.bind(tables().dbGames)
    let calls = 0
    vi.spyOn(tables().dbGames, 'bulkPut').mockImplementation(((items: DbGame[]) => {
      calls++
      return calls > 1 ? Promise.reject(new Error('QuotaExceededError')) : real(items)
    }) as never)

    const result = await putDbGames([row('a'), row('b'), row('c'), row('d')], 2)

    expect(result.written).toBe(2)
    expect(result.error).toBe('QuotaExceededError')
    vi.restoreAllMocks()
    expect(await countDbGames()).toBe(2)
  })

  it('reads degrade quietly rather than failing the screen', async () => {
    vi.spyOn(tables().dbGames, 'count').mockRejectedValue(new Error('nope'))
    vi.spyOn(tables().dbSources, 'orderBy').mockImplementation(() => {
      throw new Error('nope')
    })

    expect(await countDbGames()).toBe(0)
    expect(await listDbSources()).toEqual([])
  })

  it('detaching a database survives a broken delete', async () => {
    vi.spyOn(tables().dbGames, 'where').mockImplementation(() => {
      throw new Error('nope')
    })
    expect(await deleteDbSource('f.pgn')).toBe(0)
  })

  it('recording a source never throws', async () => {
    vi.spyOn(tables().dbSources, 'put').mockRejectedValue(new Error('nope'))
    await expect(
      recordDbSource({ name: 'f.pgn', importedAt: 1, games: 1, parsed: 1, skipped: 0 }),
    ).resolves.toBeUndefined()
  })
})
