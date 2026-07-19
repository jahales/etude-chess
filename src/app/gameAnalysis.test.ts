import { describe, it, expect } from 'vitest'
import {
  pliesNeedingAnalysis,
  isAnalysed,
  withEvalAt,
  progressOf,
  evalSwingAt,
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
