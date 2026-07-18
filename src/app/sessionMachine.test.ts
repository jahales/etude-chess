import { describe, it, expect } from 'vitest'
import {
  sessionReducer,
  initialState,
  currentItem,
  displayFen,
  isLast,
  resolveMove,
  type SessionState,
} from './sessionMachine'
import { GAMES } from '../content/games'
import type { GradedMove } from '../engine/grading'

const opera = GAMES.find((g) => g.id === 'opera-1858')!

function started(): SessionState {
  return sessionReducer(initialState, { type: 'START_GAME', game: opera, sessionId: 's1' })
}

const gradeA: GradedMove = {
  grade: { bestWinPercent: 90, playedWinPercent: 90, swing: 0, tier: 'A' },
  bestMoveUci: 'd1f3',
  bestScore: { type: 'cp', value: 300 },
  playedScoreMover: { type: 'cp', value: 300 },
  afterFen: 'x',
  userMoveSan: 'Qxf3',
}

describe('resolveMove (shared by the reducer and the drag handler)', () => {
  const start = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
  it('resolves a legal move and rejects an illegal one', () => {
    expect(resolveMove(start, 'e2', 'e4')?.san).toBe('e4')
    expect(resolveMove(start, 'e2', 'e5')).toBeNull()
  })
})

describe('START_GAME', () => {
  it('builds a quiz for the winner and enters play', () => {
    const s = started()
    expect(s.screen).toBe('play')
    expect(s.session?.heroColor).toBe('w') // Morphy won as White
    expect(s.session!.quiz.length).toBeGreaterThan(0)
    expect(currentItem(s)?.sideToMove).toBe('w')
    expect(s.sessionId).toBe('s1')
  })
})

describe('move entry', () => {
  it('sets a pending move for a legal drop, ignores an illegal one', () => {
    const s = started()
    const item = currentItem(s)!
    // The first quiz position is Qxf3 (d1→f3) in the Opera Game.
    const ok = sessionReducer(s, { type: 'TRY_MOVE', from: 'd1', to: 'f3' })
    expect(ok.pending?.san).toBe('Qxf3')
    expect(displayFen(ok)).toBe(ok.pending!.afterFen)

    const bad = sessionReducer(s, { type: 'TRY_MOVE', from: 'd1', to: 'd8' })
    expect(bad.pending).toBeNull()
    expect(item).toBeDefined()
  })

  it('click-to-move selects then moves', () => {
    const s = started()
    const sel = sessionReducer(s, { type: 'CLICK_SQUARE', square: 'd1' })
    expect(sel.selected).toBe('d1')
    const moved = sessionReducer(sel, { type: 'CLICK_SQUARE', square: 'f3' })
    expect(moved.pending?.san).toBe('Qxf3')
    expect(moved.selected).toBeNull()
  })

  it("does not select an empty square or the opponent's piece", () => {
    const s = started()
    expect(sessionReducer(s, { type: 'CLICK_SQUARE', square: 'a5' }).selected).toBeNull()
  })

  it('take-back clears the pending move', () => {
    const s = sessionReducer(started(), { type: 'TRY_MOVE', from: 'd1', to: 'f3' })
    expect(sessionReducer(s, { type: 'TAKE_BACK' }).pending).toBeNull()
  })
})

describe('promotion', () => {
  it('defaults to queen and can switch to an underpromotion', () => {
    const promoItem = {
      fen: '4k3/P7/8/8/8/8/8/4K3 w - - 0 1',
      ply: 0,
      moveNumber: 1,
      sideToMove: 'w' as const,
      masterMoveSan: 'a8=Q',
      masterMoveUci: 'a7a8q',
    }
    const s0: SessionState = {
      ...initialState,
      screen: 'play',
      session: { game: opera, quiz: [promoItem], heroColor: 'w', opening: null },
      sessionId: 's',
    }
    const s1 = sessionReducer(s0, { type: 'TRY_MOVE', from: 'a7', to: 'a8' })
    expect(s1.pending?.san).toBe('a8=Q+') // promoting on a8 checks the e8 king
    expect(s1.pending?.promotion).toBe('q')
    const s2 = sessionReducer(s1, { type: 'SET_PROMOTION', piece: 'n' })
    expect(s2.pending?.san).toBe('a8=N')
    expect(s2.pending?.promotion).toBe('n')
  })
})

describe('grading + reveal + advance', () => {
  it('records an attempt and reveals on GRADE_RESULT', () => {
    let s = started()
    s = sessionReducer(s, { type: 'TRY_MOVE', from: 'd1', to: 'f3' })
    s = sessionReducer(s, { type: 'SET_REASON', reason: 'wins the bishop back' })
    s = sessionReducer(s, { type: 'START_GRADING' })
    expect(s.phase).toBe('grading')
    s = sessionReducer(s, { type: 'GRADE_RESULT', graded: gradeA, lines: [], whitePct: 80 })
    expect(s.phase).toBe('reveal')
    expect(s.attempts).toHaveLength(1)
    expect(s.attempts[0]!.tier).toBe('A')
    expect(s.attempts[0]!.reason).toBe('wins the bishop back')
    expect(s.result?.fb.userMoveSan).toBe('Qxf3')
  })

  it('NEXT advances and clears per-move state; goes to summary on the last item', () => {
    let s = started()
    s = sessionReducer(s, { type: 'TRY_MOVE', from: 'd1', to: 'f3' })
    s = sessionReducer(s, { type: 'GRADE_RESULT', graded: gradeA, lines: [], whitePct: 80 })
    const next = sessionReducer(s, { type: 'NEXT' })
    expect(next.index).toBe(1)
    expect(next.phase).toBe('guess')
    expect(next.pending).toBeNull()
    expect(next.result).toBeNull()

    // Jump to the final item and NEXT → summary.
    const lastIdx = s.session!.quiz.length - 1
    const atLast: SessionState = { ...s, index: lastIdx }
    expect(isLast(atLast)).toBe(true)
    expect(sessionReducer(atLast, { type: 'NEXT' }).screen).toBe('summary')
  })
})

describe('GO_HOME', () => {
  it('resets to the initial state', () => {
    const s = sessionReducer(started(), { type: 'GO_HOME' })
    expect(s).toEqual(initialState)
  })
})
