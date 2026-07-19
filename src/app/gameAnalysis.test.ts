import { describe, it, expect } from 'vitest'
import {
  pliesNeedingAnalysis,
  isAnalysed,
  withEvalAt,
  progressOf,
  evalSwingAt,
  accuracyReport,
  BATCH_NODES,
} from './gameAnalysis'
import type { StoredGame } from '../persist/db'
import type { PositionEval } from '../domain/gameRecord'

const ev = (whitePct: number): PositionEval => ({ whitePct, label: `${whitePct}` })

function game(over: Partial<StoredGame> = {}): StoredGame {
  return {
    gameId: 'g',
    yourColor: 'w',
    level: 1500,
    sanHistory: ['e4', 'e5', 'Nf3'],
    outcome: 'you',
    reason: 'checkmate',
    accuracy: 90,
    takebacks: 0,
    createdAt: 0,
    ...over,
  }
}

describe('pliesNeedingAnalysis', () => {
  it('asks for every move of a game that was never analysed', () => {
    expect(pliesNeedingAnalysis(game())).toEqual([0, 1, 2])
  })

  it('asks for nothing once a pass at the same budget has completed', () => {
    const done = game({ analysedAt: 123, analysisNodes: BATCH_NODES })
    expect(pliesNeedingAnalysis(done)).toEqual([])
    expect(isAnalysed(done)).toBe(true)
  })

  it('redoes the game when the previous pass used a different budget', () => {
    // Mixing node counts within one game would make the scores — and the glyphs
    // derived from them — inconsistent for no reason the user could see.
    const stale = game({ analysedAt: 123, analysisNodes: 40_000 })
    expect(pliesNeedingAnalysis(stale)).toEqual([0, 1, 2])
    expect(isAnalysed(stale)).toBe(false)
  })

  it('redoes a game with live evals but no completed pass', () => {
    // Evals recorded during play are partial and at a different budget.
    expect(pliesNeedingAnalysis(game({ evalByPly: [ev(52), undefined, ev(48)] }))).toEqual([0, 1, 2])
  })

  it('asks for nothing on a game with no moves', () => {
    expect(pliesNeedingAnalysis(game({ sanHistory: [] }))).toEqual([])
  })
})

describe('withEvalAt', () => {
  it('fills a ply without mutating the original', () => {
    const before: (PositionEval | undefined)[] = [ev(50)]
    const after = withEvalAt(before, 2, ev(61))
    expect(before).toHaveLength(1) // untouched
    expect(after).toHaveLength(3)
    expect(after[1]).toBeUndefined() // gap preserved
    expect(after[2]?.whitePct).toBe(61)
  })

  it('starts from nothing when the game has no evals yet', () => {
    expect(withEvalAt(undefined, 0, ev(50))[0]?.whitePct).toBe(50)
  })
})

describe('progressOf', () => {
  it('is incomplete partway and complete at the end', () => {
    expect(progressOf(0, 3)).toMatchObject({ done: 0, total: 3, complete: false })
    expect(progressOf(3, 3).complete).toBe(true)
  })

  it('a game with nothing to analyse is not reported as a completed pass', () => {
    // Otherwise an empty game would claim to have been analysed.
    expect(progressOf(0, 0).complete).toBe(false)
  })
})

describe('evalSwingAt', () => {
  it('reports what your move cost you, in win%', () => {
    const evals = [ev(55), ev(40)] // your move at ply 0, opponent's at ply 1
    // As White, ply 1 dropped from 55 to 40 — but that's the opponent's move.
    // Your ply-1 swing isn't meaningful; test your own move instead.
    expect(evalSwingAt(evals, 1, 'b')).toBe(-15) // good for Black: White fell 15
  })

  it('is signed from your side, so the same drop reads oppositely by colour', () => {
    const evals = [ev(60), ev(45)]
    expect(evalSwingAt(evals, 1, 'w')).toBe(15) // White lost 15
    expect(evalSwingAt(evals, 1, 'b')).toBe(-15) // Black gained 15
  })

  it('has no swing for the first move, whose prior position is never stored', () => {
    // evalByPly[p] is the eval *after* move p, so nothing holds the start position.
    expect(evalSwingAt([ev(50)], 0, 'w')).toBeUndefined()
  })

  it('has no swing across a gap in the evaluations', () => {
    expect(evalSwingAt([ev(50), undefined, ev(30)], 2, 'w')).toBeUndefined()
  })
})

describe('accuracyReport — the figure, and how much of the game it covers', () => {
  const graded = (ply: number, swing: number) => ({
    ply, fen: `f${ply}`, san: 'x', tier: 'A' as const, swing, bestMoveSan: null,
  })

  it('reports coach coverage honestly when the game was never analysed', () => {
    // The bug behind #74: resigning leaves coachLog holding only the moves that
    // finished grading — here 1 of your 2 — and the mean over that subset reads
    // as if it described the whole game.
    const r = accuracyReport(game({ sanHistory: ['e4', 'e5', 'Ke2', 'Nf6'], coachLog: [graded(0, 0)] }))
    expect(r.source).toBe('coach')
    expect(r.covered).toBe(1)
    expect(r.total).toBe(2) // you played plies 0 and 2
    expect(r.complete).toBe(false)
    expect(r.accuracy).toBeCloseTo(100, 0)
  })

  it('uses the analysis once a pass has completed, covering every move', () => {
    const r = accuracyReport(
      game({
        sanHistory: ['e4', 'e5', 'Ke2', 'Nf6'],
        coachLog: [graded(0, 0)], // still partial — must be ignored in favour of the pass
        analysedAt: 1, analysisNodes: BATCH_NODES,
        startEval: ev(50),
        evalByPly: [ev(55), ev(52), ev(20), ev(22)],
      }),
    )
    expect(r.source).toBe('analysis')
    expect(r.covered).toBe(2)
    expect(r.complete).toBe(true)
    // Ply 2 gave up 32 win%, so the mean must be well below the coach's 100.
    expect(r.accuracy).toBeLessThan(80)
  })

  it('scores the first move, which needs the start position to be measurable', () => {
    const withStart = accuracyReport(
      game({ sanHistory: ['e4', 'e5'], analysedAt: 1, analysisNodes: BATCH_NODES,
             startEval: ev(50), evalByPly: [ev(20), ev(22)] }),
    )
    expect(withStart.covered).toBe(1)
    expect(withStart.complete).toBe(true)

    // Without it, move 1 has nothing to compare against and coverage is honest about that.
    const without = accuracyReport(
      game({ sanHistory: ['e4', 'e5'], analysedAt: 1, analysisNodes: BATCH_NODES,
             evalByPly: [ev(20), ev(22)] }),
    )
    expect(without.covered).toBe(0)
    expect(without.complete).toBe(false)
  })

  it('counts Black’s moves when you played Black', () => {
    const r = accuracyReport(
      game({ yourColor: 'b', sanHistory: ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5'] }),
    )
    expect(r.total).toBe(2) // plies 1 and 3
  })

  it('does not let a move that gained ground score better than perfect', () => {
    // A negative swing means the evaluation moved your way; clamping stops it
    // pulling the mean above what the worst moves justify.
    const r = accuracyReport(
      game({ sanHistory: ['e4', 'e5', 'Nf3', 'Nc6'], analysedAt: 1, analysisNodes: BATCH_NODES,
             startEval: ev(50), evalByPly: [ev(90), ev(88), ev(40), ev(38)] }),
    )
    expect(r.accuracy).toBeLessThanOrEqual(100)
    expect(r.accuracy).toBeLessThan(90) // the ply-2 collapse still dominates
  })

  it('is 100 with nothing measured, but says it covers nothing', () => {
    const r = accuracyReport(game({ sanHistory: [] }))
    expect(r.accuracy).toBe(100)
    expect(r.total).toBe(0)
  })
})
