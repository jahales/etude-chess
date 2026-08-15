import { describe, it, expect } from 'vitest'
import {
  pliesNeedingAnalysis,
  isAnalysed,
  withEvalAt,
  progressOf,
  evalSwingAt,
  accuracyReport,
  BATCH_NODES,
  REFERENCE_NODES,
  supersedes,
  trustworthyAbsences,
  ANALYSIS_BUDGETS,
  budgetForNodes,
  type AnalysableGame,
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

describe('the same pass over a game that was imported rather than played (#133)', () => {
  // The widening. This module was typed against `StoredGame` throughout, and an
  // imported row has none of a played game's fields — no colour of yours, no
  // coach log, no `gameId`. What the pass actually needs is the move list plus
  // whatever an earlier pass recorded, so that is what it asks for now, taken
  // structurally the way `domain/studyGame.DatabaseGame` is.
  const imported = (over: Partial<AnalysableGame> = {}): AnalysableGame => ({
    sanHistory: ['d4', 'd5', 'c4'],
    ...over,
  })

  it('asks for every move of an imported game', () => {
    expect(pliesNeedingAnalysis(imported())).toEqual([0, 1, 2])
  })

  it('reads a pass recorded away from the game, since that is where an import keeps it', () => {
    // An imported game's evaluations live in a table beside it rather than on
    // the row (db.ts's v7 comment says why), so what reaches `isAnalysed` here
    // is the two fields and nothing else.
    expect(isAnalysed({ analysedAt: 5, analysisNodes: BATCH_NODES })).toBe(true)
    expect(isAnalysed({ analysedAt: 5, analysisNodes: 40_000 })).toBe(false)
    expect(pliesNeedingAnalysis(imported({ analysedAt: 5, analysisNodes: BATCH_NODES }))).toEqual([])
  })

  it('measures only the moves that replay, so a truncated game can still finish', () => {
    // Far likelier here than for a game you played: an import stores movetext
    // as text and never replays it, so this pass is the first thing that tries.
    // Asking for plies past the break would leave it permanently short of 100%,
    // never marked complete, and redoing every position on each attempt.
    expect(
      pliesNeedingAnalysis(imported({ sanHistory: ['d4', 'd5', 'c4', 'Nf6'] }), BATCH_NODES, 3),
    ).toEqual([0, 1])
  })

  it('measures nothing when only the starting position could be rebuilt', () => {
    // The #128 shape: a study whose `[FEN]` was dropped at import replays
    // nothing legal from move 1. Analysing no positions beats scoring positions
    // the game was never in.
    expect(pliesNeedingAnalysis(imported(), BATCH_NODES, 1)).toEqual([])
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

/**
 * The budget a pass ran at, and what that entitles the app to say (#144).
 *
 * Two separate questions, deliberately two functions. `supersedes` asks whether
 * the work is *done to at least this depth*, which is what decides whether the
 * engine runs. `trustworthyAbsences` asks whether a *missing* finding means
 * anything, which is what decides what the screen is allowed to claim — and no
 * budget a browser can afford makes it true.
 */
describe('what a pass budget entitles us to say', () => {
  it('lets a completed deeper pass answer a request for a shallower one', () => {
    // The seam an off-app pass arrives through: deeper work already in the table
    // must not be redone with worse searches on top of it.
    const deep = { analysedAt: 1, analysisNodes: REFERENCE_NODES }
    expect(supersedes(deep, BATCH_NODES)).toBe(true)
    expect(isAnalysed(deep, BATCH_NODES)).toBe(true)
    expect(pliesNeedingAnalysis({ sanHistory: ['e4', 'e5'], ...deep }, BATCH_NODES)).toEqual([])
  })

  it('does not let a shallower pass answer a request for a deeper one', () => {
    // What invalidates the old 150k work rather than serving it at a depth the
    // selection in domain/keyMoments.ts will no longer rest on.
    expect(supersedes({ analysedAt: 1, analysisNodes: 150_000 }, BATCH_NODES)).toBe(false)
    expect(isAnalysed({ analysedAt: 1, analysisNodes: 150_000 }, BATCH_NODES)).toBe(false)
  })

  it('does not let an unfinished pass answer anything, however deep', () => {
    // A partial deeper pass topped up with cheaper searches would leave one game
    // holding evaluations from two budgets.
    expect(supersedes({ analysisNodes: REFERENCE_NODES }, BATCH_NODES)).toBe(false)
    // Nor a record from before budgets were written down at all.
    expect(supersedes({ analysedAt: 1 }, BATCH_NODES)).toBe(false)
  })

  it('trusts an absence only at the budget the measurements were made at', () => {
    // 800k — twice the in-app default — is the budget measured to lose a real
    // Tier B move. Every option this app offers is at or below it, so every one
    // of them leaves the claim hedged.
    expect(trustworthyAbsences(REFERENCE_NODES)).toBe(true)
    expect(ANALYSIS_BUDGETS.every((b) => !trustworthyAbsences(b.nodes))).toBe(true)
    expect(ANALYSIS_BUDGETS.every((b) => b.nodes <= 800_000)).toBe(true)
  })

  it('offers the default as one of the budgets, and describes every one it offers', () => {
    expect(budgetForNodes(BATCH_NODES)).toBeDefined()
    for (const b of ANALYSIS_BUDGETS) expect(b.note.length).toBeGreaterThan(40)
    // The setting this project's own measurement condemns most directly is not
    // on the menu to be picked out of habit.
    expect(ANALYSIS_BUDGETS.every((b) => b.nodes > 150_000)).toBe(true)
  })
})
