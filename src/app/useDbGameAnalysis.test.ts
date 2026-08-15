// The whole-game pass over an imported game (#133).
//
// The rules it drives are covered in gameAnalysis.test.ts and the storage in
// persist/dbGames.analysis.test.ts, so what is worth pinning here is what only
// the hook can get wrong: that the game is replayed from the position the file
// recorded rather than from move 1, that work already stored is read before any
// is repeated, and that an engine that dies partway does not leave a game
// claiming to have been analysed.
//
// This import must run before ./db is reached: getDb() decides once, at first
// call, whether IndexedDB exists. Vitest hoists imports in source order.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import Dexie from 'dexie'
import type { Analyser } from '../engine/analyser'
import { getDbAnalysis, saveDbAnalysis } from '../persist/dbGames'
import type { AnalyserState } from './useAnalyser'
import { BATCH_NODES } from './gameAnalysis'
import { useDbGameAnalysis, type AnalysableDbGame } from './useDbGameAnalysis'

/** A study's position: four men, White to move — nothing like the standard start. */
const STUDY_FEN = '4k3/8/8/8/8/8/4P3/4K3 w - - 0 1'

/** Records every position it is asked about, so the test can see what was scored. */
function fakeEngine(seen: string[], evaluate?: Analyser['evaluate']): AnalyserState {
  const analyser: Analyser = {
    evaluate:
      evaluate ??
      (async (fen) => {
        seen.push(fen)
        return { score: { type: 'cp' as const, value: 30 }, bestMove: null }
      }),
    analyseLines: async () => [],
    dispose: () => {},
  }
  return { analyser, ready: true, error: null }
}

const game = (over: Partial<AnalysableDbGame> = {}): AnalysableDbGame => ({
  key: 'morphy-1858',
  movetext: 'e4 e5 Nf3',
  ...over,
})

beforeEach(async () => {
  const d = new Dexie('etude-chess')
  try {
    await d.open()
    await d.table('dbAnalysis').clear()
  } catch {
    // First run: db.ts hasn't created the database yet.
  } finally {
    d.close()
  }
})

/** Render and wait out the read of whatever was already stored. */
async function analysis(engine: AnalyserState, row = game()) {
  const { result } = renderHook(() => useDbGameAnalysis(engine, row))
  await waitFor(() => expect(result.current.available).toBe(true))
  return result
}

describe('analysing an imported game', () => {
  it('scores every position and stores the pass under the game’s key', async () => {
    const seen: string[] = []
    const result = await analysis(fakeEngine(seen))
    expect(result.current.analysed).toBe(false)

    act(() => result.current.start())
    await waitFor(() => expect(result.current.progress?.complete).toBe(true))

    // Three moves: the start position plus one after each of them.
    expect(seen).toHaveLength(4)
    expect(result.current.evalByPly).toHaveLength(3)
    expect(result.current.startEval).toBeDefined()
    expect(result.current.analysed).toBe(true)

    const stored = await getDbAnalysis({ key: 'morphy-1858' })
    expect(stored?.analysisNodes).toBe(BATCH_NODES)
    expect(stored?.analysedAt).toBeDefined()
    expect(stored?.evalByPly).toHaveLength(3)
  })

  it('replays from the position the file recorded, not from move 1', async () => {
    // The #128 shape: a study or an endgame collection carries `[FEN]`, and a
    // pass that ignored it would score positions the game was never in — for
    // exactly the games worth studying. Deriving the positions inside the hook
    // is what makes forgetting it impossible.
    const seen: string[] = []
    const result = await analysis(
      fakeEngine(seen),
      game({ key: 'study', movetext: 'e4 Kd7 e5', startFen: STUDY_FEN }),
    )

    act(() => result.current.start())
    await waitFor(() => expect(result.current.progress?.complete).toBe(true))

    expect(seen[0]).toContain('4k3/8/8/8/8/8/4P3/4K3')
    expect(seen.some((fen) => fen.startsWith('rnbqkbnr/'))).toBe(false)
    expect(result.current.positions).toHaveLength(4)
    // And it is filed against that position, so a re-import of the same moves
    // from move 1 cannot be served this pass.
    expect((await getDbAnalysis({ key: 'study', startFen: STUDY_FEN }))?.analysedAt).toBeDefined()
    expect(await getDbAnalysis({ key: 'study' })).toBeUndefined()
  })

  it('reads the stored pass and asks the engine for nothing', async () => {
    // The work happens once. A game re-opened a week later is instant, and the
    // read has to land before anything can start or it would redo the lot.
    await saveDbAnalysis({
      key: 'morphy-1858',
      evalByPly: [{ whitePct: 52, label: '+0.1' }],
      startEval: { whitePct: 50, label: '0.00' },
      analysedAt: 1,
      analysisNodes: BATCH_NODES,
    })
    const seen: string[] = []
    const result = await analysis(fakeEngine(seen))

    expect(result.current.analysed).toBe(true)
    expect(result.current.startEval?.whitePct).toBe(50)

    act(() => result.current.start())
    expect(seen).toEqual([])
  })

  it('redoes a game whose stored pass ran at a different budget', async () => {
    // Comparing evaluations taken at two node counts manufactures swings out of
    // nothing, which is what the glyphs would then be drawn from.
    await saveDbAnalysis({ key: 'morphy-1858', analysedAt: 1, analysisNodes: 40_000 })
    const seen: string[] = []
    const result = await analysis(fakeEngine(seen))

    expect(result.current.analysed).toBe(false)
    act(() => result.current.start())
    await waitFor(() => expect(result.current.progress?.complete).toBe(true))
    expect(seen).toHaveLength(4)
  })

  it('does not claim to have analysed a game the engine gave up on', async () => {
    // `evaluate` only rejects when the worker has gone, so gaps mean the engine
    // died partway. Stored as "analysed" with no evaluations in it, the game
    // would be indistinguishable downstream from one where nothing went wrong.
    const result = await analysis(fakeEngine([], () => Promise.reject(new Error('worker gone'))))

    act(() => result.current.start())
    await waitFor(() => expect(result.current.running).toBe(false))

    expect(result.current.analysed).toBe(false)
    // And nothing was stored: an empty record and no record say the same thing.
    expect(await getDbAnalysis({ key: 'morphy-1858' })).toBeUndefined()
  })

  it('has nothing to analyse when the movetext does not replay', async () => {
    // An import stores movetext without ever replaying it, so this is the first
    // code that tries. One position and no legal move out of it: the pass asks
    // for nothing rather than scoring a position the game was never in.
    const seen: string[] = []
    const result = await analysis(fakeEngine(seen), game({ key: 'broken', movetext: 'Qh8 Qa1' }))

    expect(result.current.positions).toHaveLength(1)
    act(() => result.current.start())
    expect(seen).toEqual([])
    expect(result.current.analysed).toBe(false)
  })

  it('offers nothing to start while the engine is unavailable', async () => {
    const { result } = renderHook(() =>
      useDbGameAnalysis({ analyser: null, ready: false, error: 'no engine' }, game()),
    )
    await waitFor(() => expect(result.current.positions).toHaveLength(4))

    expect(result.current.available).toBe(false)
    act(() => result.current.start())
    expect(result.current.running).toBe(false)
    expect(result.current.progress).toBeNull()
  })
})
