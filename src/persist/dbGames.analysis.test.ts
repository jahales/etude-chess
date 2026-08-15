// Keeping a whole-game analysis of an *imported* game (#133).
//
// The evaluations live in a table beside `dbGames` rather than on the row, and
// the reason is a property rather than a preference: an import re-writes every
// row it touches, blind, by primary key. So the tests that matter here are not
// "does a put come back out" but the two things that decision buys — that
// re-attaching a file leaves an analysis alone, and that an analysis of a
// *different* starting position is never served for the row that replaced it.
//
// This import must run before ./db is imported: getDb() decides once, at first
// call, whether IndexedDB exists. Vitest hoists imports in source order.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Dexie from 'dexie'
import type { PositionEval } from '../domain/gameRecord'
import { getDb } from './db'
import {
  deleteDbSource,
  getDbAnalysis,
  putDbGames,
  saveDbAnalysis,
  type DbGame,
} from './dbGames'

const ev = (whitePct: number): PositionEval => ({ whitePct, label: `${whitePct}` })

const row = (over: Partial<DbGame> = {}): DbGame => ({
  key: 'morphy-1858',
  white: 'Morphy, Paul',
  black: 'Anderssen, Adolf',
  result: '1-0',
  speed: 'classical',
  plies: 4,
  movetext: 'e4 e5 Nf3 Nc6',
  source: 'a.pgn',
  importedAt: 1,
  ...over,
})

beforeEach(async () => {
  const d = new Dexie('etude-chess')
  try {
    await d.open()
    await Promise.all([d.table('dbGames').clear(), d.table('dbAnalysis').clear()])
  } catch {
    // First run: db.ts hasn't created the database yet.
  } finally {
    d.close()
  }
})

afterEach(() => vi.restoreAllMocks())

describe('the analysis of an imported game', () => {
  it('round-trips the pass, gaps and all', async () => {
    // A gap is a position the pass could not score. It has to stay a gap: read
    // back as 0 it would be an evaluation, and a wrong one.
    const evalByPly: (PositionEval | undefined)[] = [ev(52), undefined, ev(48), ev(49)]
    await saveDbAnalysis({
      key: 'morphy-1858',
      evalByPly,
      startEval: ev(50),
      analysedAt: 1234,
      analysisNodes: 150_000,
    })

    const stored = await getDbAnalysis(row())
    expect(stored?.analysedAt).toBe(1234)
    expect(stored?.analysisNodes).toBe(150_000)
    expect(stored?.startEval?.whitePct).toBe(50)
    expect(stored?.evalByPly).toHaveLength(4)
    expect(stored?.evalByPly?.[1]).toBeUndefined()
    expect(stored?.evalByPly?.[2]?.label).toBe('48')
  })

  it('reads a game nobody has analysed as absent, not as an error', async () => {
    expect(await getDbAnalysis(row({ key: 'never-analysed' }))).toBeUndefined()
  })

  it('keeps an interrupted pass, without claiming it finished', async () => {
    // Worth keeping: the positions it did score are at the right budget. Marking
    // it complete would stop it ever being finished.
    await saveDbAnalysis({ key: 'morphy-1858', evalByPly: [ev(52)] })

    const stored = await getDbAnalysis(row())
    expect(stored?.evalByPly).toHaveLength(1)
    expect(stored?.analysedAt).toBeUndefined()
  })

  it('survives re-attaching the file — which is why it is not on the row', async () => {
    // The whole decision in one test. `putDbGames` writes rows built fresh from
    // the file over whatever was there, by primary key: an analysis stored on
    // the row would be gone here, and keeping it would mean reading every one of
    // a hundred thousand rows back before writing it.
    await putDbGames([row()])
    await saveDbAnalysis({ key: 'morphy-1858', evalByPly: [ev(52)], analysedAt: 1, analysisNodes: 150_000 })

    await putDbGames([row({ importedAt: 2, source: 'a.pgn' })])

    expect(await getDbAnalysis(row())).toMatchObject({ analysedAt: 1, analysisNodes: 150_000 })
  })

  it('outlives detaching the database, so re-attaching gives the engine time back', async () => {
    await putDbGames([row()])
    await saveDbAnalysis({ key: 'morphy-1858', analysedAt: 1, analysisNodes: 150_000 })

    expect(await deleteDbSource('a.pgn')).toBe(1)

    // The games are gone; the analysis is filed under a key derived from the
    // game itself, so re-importing the same file finds it again.
    await putDbGames([row({ importedAt: 3 })])
    expect(await getDbAnalysis(row())).toMatchObject({ analysedAt: 1 })
  })
})

describe('an analysis that is no longer of this game', () => {
  it('is discarded when the game starts from a different position', async () => {
    // The dedup key hashes the movetext but not the `[FEN]` tag, and rows
    // imported before #128 carry no start position at all — so re-attaching a
    // file can put a *study* under the key an analysis of the same moves from
    // move 1 is filed at. Every evaluation in it would be of a position this
    // game was never in.
    const study = '8/8/8/8/8/5k2/6p1/6K1 w - - 0 1'
    await saveDbAnalysis({ key: 'morphy-1858', analysedAt: 1, analysisNodes: 150_000 })

    expect(await getDbAnalysis(row({ startFen: study }))).toBeUndefined()
    // And the other way round: a pass over the study is not served for the
    // game that replays from move 1.
    await saveDbAnalysis({ key: 'k2', analysedAt: 1, analysisNodes: 150_000, startFen: study })
    expect(await getDbAnalysis(row({ key: 'k2' }))).toBeUndefined()
  })

  it('is served when both start where the pass started', async () => {
    // The check must not reject the ordinary case — a game from move 1 has no
    // `startFen` on either side, and neither does a study that has not moved.
    const study = '8/8/8/8/8/5k2/6p1/6K1 w - - 0 1'
    await saveDbAnalysis({ key: 'k3', analysedAt: 1, analysisNodes: 150_000, startFen: study })
    expect(await getDbAnalysis(row({ key: 'k3', startFen: study }))).toMatchObject({ analysedAt: 1 })
  })
})

describe('when storage fails', () => {
  /** The live tables, which is where a spy has to go: Dexie 4 has no `Table` class to patch. */
  const tables = () => {
    const d = getDb()
    if (!d) throw new Error('these tests need fake-indexeddb')
    return d
  }

  it('a pass that cannot be written is lost quietly rather than thrown', async () => {
    // Unlike an import, which reports a failed write: this is engine time the
    // user can spend again, not data of theirs we were entrusted with.
    vi.spyOn(tables().dbAnalysis, 'put').mockRejectedValue(new Error('QuotaExceededError'))
    await expect(saveDbAnalysis({ key: 'morphy-1858', analysedAt: 1 })).resolves.toBeUndefined()
  })

  it('a read that fails is an unanalysed game', async () => {
    vi.spyOn(tables().dbAnalysis, 'get').mockRejectedValue(new Error('nope'))
    expect(await getDbAnalysis(row())).toBeUndefined()
  })
})
