import { describe, it, expect } from 'vitest'
import {
  sessionReducer,
  initialState,
  currentItem,
  displayFen,
  isLast,
  nextImportant,
  resolveMove,
  OPENING_CUTOFF_PLY,
  type SessionAnalysis,
  type SessionState,
} from './sessionMachine'
import { DEFAULT_START_PLY } from '../domain/harness'
import { GAMES } from '../content/games'
import type { PositionEval } from '../domain/gameRecord'
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
  afterPv: ['g2f3', 'b8c6'],
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

  // #55: an imported game may be a draw or unfinished, and then there is no
  // winner to derive a side from — the caller chose one and it must be honoured.
  it('takes the side the game names, over the one its result implies', () => {
    const asBlack = sessionReducer(initialState, {
      type: 'START_GAME',
      game: { ...opera, heroColor: 'b' },
      sessionId: 's2',
    })
    expect(asBlack.session?.heroColor).toBe('b')
    expect(asBlack.session!.quiz.every((q) => q.sideToMove === 'b')).toBe(true)
  })

  it('still derives the winner’s side when the game names none', () => {
    expect(started().session?.heroColor).toBe('w')
  })

  it('quizzes from the same ply the study planner counted from', () => {
    // The database screen promises "N positions to guess" from
    // `domain/studyGame.planStudy`, which counts with the harness default. If
    // these two ever drift, that promise is quietly wrong on every imported game.
    expect(OPENING_CUTOFF_PLY).toBe(DEFAULT_START_PLY)
  })
})

// #144: a review session over only the moments that decided the game.
describe('START_GAME with focusPlies', () => {
  const focused = (focusPlies: readonly number[]) =>
    sessionReducer(initialState, {
      type: 'START_GAME',
      game: opera,
      sessionId: 's3',
      focusPlies,
    })

  it('asks about exactly the plies given, in playing order', () => {
    const s = focused([10, 16])
    expect(s.session!.quiz.map((q) => q.ply)).toEqual([10, 16])
    expect(isLast(s)).toBe(false)
  })

  it('reaches past the opening cutoff, because a selected moment was measured', () => {
    // Ply 4 is White's third move — inside the cutoff, and unreachable in a
    // whole-game session. A blunder there is exactly what a review is for.
    expect(focused([4]).session!.quiz.map((q) => q.ply)).toEqual([4])
    expect(started().session!.quiz.some((q) => q.ply < OPENING_CUTOFF_PLY)).toBe(false)
  })

  it('never widens the session — a ply that is not the hero’s is simply not asked', () => {
    // Ply 11 is Black's; the hero is White. The guard that matters is that this
    // does not fall back to the whole game, which is the "silent degradation"
    // #144 is written against.
    expect(focused([11]).session!.quiz).toHaveLength(0)
  })

  it('leaves every other caller on the whole game', () => {
    expect(started().session!.quiz.length).toBeGreaterThan(2)
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
      session: { game: opera, quiz: [promoItem], heroColor: 'w', opening: null, focused: false },
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

  // #151: the second search's answer used to stop at the reducer's door. The
  // score stays on the *mover's* perspective here — turning it into White's is
  // the screen's job, and doing it twice is how a sign gets flipped.
  it('carries the played move, its score and the engine answer to the reveal', () => {
    let s = started()
    s = sessionReducer(s, { type: 'TRY_MOVE', from: 'd1', to: 'f3' })
    s = sessionReducer(s, { type: 'GRADE_RESULT', graded: gradeA, lines: [], whitePct: 80 })
    expect(s.result?.played).toEqual({
      san: 'Qxf3',
      score: { type: 'cp', value: 300 },
      pv: ['g2f3', 'b8c6'],
    })
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

// ---------- the result picture at the reveal (#161) ----------

describe('the result either side of your move', () => {
  /** `gradeA` plus the two WDL readings a WDL-capable adapter supplies. */
  const withWdl = (best: [number, number, number], played: [number, number, number]): GradedMove => ({
    ...gradeA,
    bestWdl: { win: best[0], draw: best[1], loss: best[2] },
    playedWdlMover: { win: played[0], draw: played[1], loss: played[2] },
  })

  it('puts both readings in White’s perspective when the hero is White', () => {
    let s = started()
    expect(currentItem(s)!.sideToMove).toBe('w')
    s = sessionReducer(s, { type: 'TRY_MOVE', from: 'd1', to: 'f3' })
    s = sessionReducer(s, {
      type: 'GRADE_RESULT',
      graded: withWdl([900, 90, 10], [200, 500, 300]),
      lines: [],
      whitePct: 80,
    })
    // White to move, so both are already White's and neither is flipped.
    expect(s.result?.resultShift).toEqual({
      before: { win: 900, draw: 90, loss: 10 },
      after: { win: 200, draw: 500, loss: 300 },
    })
  })

  it('flips both readings together when the hero is Black', () => {
    // The bug this pins: `playedWdlMover` is already the mover's, so it takes
    // the *same* side as `bestWdl`. Flipping only one of them would report a
    // reversal of the result on every single move, and look entirely plausible.
    let s = sessionReducer(initialState, {
      type: 'START_GAME',
      game: { ...opera, heroColor: 'b' },
      sessionId: 'sb',
    })
    const item = currentItem(s)!
    expect(item.sideToMove).toBe('b')
    const [from, to] = [item.masterMoveUci.slice(0, 2), item.masterMoveUci.slice(2, 4)]
    s = sessionReducer(s, { type: 'TRY_MOVE', from, to })
    s = sessionReducer(s, {
      type: 'GRADE_RESULT',
      graded: withWdl([900, 90, 10], [800, 150, 50]),
      lines: [],
      whitePct: 20,
    })
    // Black was winning both before and after; read as White's, that is a loss
    // both times — and, crucially, still the *same* category either side.
    expect(s.result?.resultShift).toEqual({
      before: { win: 10, draw: 90, loss: 900 },
      after: { win: 50, draw: 150, loss: 800 },
    })
  })

  it('says nothing at all when the engine reported no WDL', () => {
    let s = started()
    s = sessionReducer(s, { type: 'TRY_MOVE', from: 'd1', to: 'f3' })
    s = sessionReducer(s, { type: 'GRADE_RESULT', graded: gradeA, lines: [], whitePct: 80 })
    expect(s.result?.resultShift).toBeUndefined()
  })

  it('says nothing when only one of the two readings came back', () => {
    // Half a comparison is not a comparison, and a lone "1000/0/0 before" would
    // invite exactly the reading the pair exists to prevent.
    let s = started()
    s = sessionReducer(s, { type: 'TRY_MOVE', from: 'd1', to: 'f3' })
    s = sessionReducer(s, {
      type: 'GRADE_RESULT',
      graded: { ...gradeA, bestWdl: { win: 900, draw: 90, loss: 10 } },
      lines: [],
      whitePct: 80,
    })
    expect(s.result?.resultShift).toBeUndefined()
  })

  it('clears it with the rest of the reveal on NEXT', () => {
    // Engine/board sync: the reading belongs to the position it was computed
    // for, and must never survive onto the next one.
    let s = started()
    s = sessionReducer(s, { type: 'TRY_MOVE', from: 'd1', to: 'f3' })
    s = sessionReducer(s, {
      type: 'GRADE_RESULT',
      graded: withWdl([900, 90, 10], [200, 500, 300]),
      lines: [],
      whitePct: 80,
    })
    expect(sessionReducer(s, { type: 'NEXT' }).result).toBeNull()
  })
})

// ---------- skipping to the next important move (#161) ----------

describe('skipping ahead to the next move that changed the result', () => {
  /**
   * A pass over the opera game where exactly one of the hero's moves turns a
   * win into a draw. Built off the real quiz so the plies are the ones the
   * session actually asks about.
   */
  function analysed(target: number, opts: { wdl?: boolean } = {}) {
    const base = started()
    const plies = base.session!.quiz.map((q) => q.ply)
    const last = plies[plies.length - 1]!
    const evalByPly: (PositionEval | undefined)[] = []
    for (let ply = 0; ply <= last; ply++) {
      // Winning for White until the target move, a dead draw after it.
      const won = ply < target
      evalByPly[ply] = {
        whitePct: won ? 92 : 50,
        label: won ? '+4.0' : '0.0',
        ...(opts.wdl === false
          ? {}
          : { wdl: won ? { win: 900, draw: 90, loss: 10 } : { win: 20, draw: 960, loss: 20 } }),
      }
    }
    const startEval: PositionEval = {
      whitePct: 92,
      label: '+4.0',
      ...(opts.wdl === false ? {} : { wdl: { win: 900, draw: 90, loss: 10 } }),
    }
    return { plies, analysis: { evalByPly, startEval } }
  }

  const sessionWith = (analysis: SessionAnalysis, focusPlies?: readonly number[]): SessionState =>
    sessionReducer(initialState, {
      type: 'START_GAME',
      game: opera,
      sessionId: 's',
      analysis,
      ...(focusPlies ? { focusPlies } : {}),
    })

  it('jumps to the question whose move changed the result', () => {
    const quiz = started().session!.quiz
    const { plies, analysis } = analysed(quiz[2]!.ply)
    const s = sessionWith(analysis)
    const jumped = sessionReducer(s, { type: 'SKIP_TO_IMPORTANT' })
    // Straight past questions 1 and 2, which cost win% but left the result
    // where it was — the whole point of the control.
    expect(jumped.index).toBe(2)
    expect(currentItem(jumped)!.ply).toBe(plies[2])
    expect(jumped.phase).toBe('guess')
  })

  it('clears the reveal it is leaving behind', () => {
    // Engine/board sync: every one of these was computed for the position being
    // jumped away from, and `positionWhitePct` is an engine reading of a board
    // that is about to change.
    const quiz = started().session!.quiz
    const { analysis } = analysed(quiz[2]!.ply)
    let s = sessionWith(analysis)
    s = sessionReducer(s, { type: 'TRY_MOVE', from: 'd1', to: 'f3' })
    s = sessionReducer(s, { type: 'SET_REASON', reason: 'a thought' })
    s = sessionReducer(s, { type: 'GRADE_RESULT', graded: gradeA, lines: [], whitePct: 80 })
    const jumped = sessionReducer(s, { type: 'SKIP_TO_IMPORTANT' })
    expect(jumped.result).toBeNull()
    expect(jumped.pending).toBeNull()
    expect(jumped.reason).toBe('')
    expect(jumped.lines).toEqual([])
    expect(jumped.positionWhitePct).toBeNull()
  })

  it('is not offered at all on the critical-positions path', () => {
    // Every position there was selected for costing win%; offering to skip past
    // them implies some are filler (#132, #144).
    const quiz = started().session!.quiz
    const { analysis } = analysed(quiz[2]!.ply)
    const focused = sessionWith(analysis, [quiz[0]!.ply, quiz[2]!.ply])
    expect(focused.session!.focused).toBe(true)
    expect(nextImportant(focused)).toBeNull()
  })

  it('is not offered on a game with no pass behind it', () => {
    // The curated pack. Nothing has ever computed a WDL for these positions, so
    // there is no question to answer and no sentence to say.
    expect(nextImportant(started())).toBeNull()
  })

  it('reports "we could not measure it" rather than "nothing left" for an old pass', () => {
    // A stored analysis that predates WDL being recorded. The distinction #132
    // was careful about: this is not a game where nothing changed the result.
    const quiz = started().session!.quiz
    const { analysis } = analysed(quiz[2]!.ply, { wdl: false })
    const s = sessionWith(analysis)
    const next = nextImportant(s)!
    expect(next.target).toBeNull()
    expect(next.measured).toBe(0)
    expect(next.unmeasured).toBeGreaterThan(0)
  })

  it('leaves the learner where they are when there is nowhere to jump', () => {
    // A stray dispatch must not end the session or move the board.
    const s = started()
    expect(sessionReducer(s, { type: 'SKIP_TO_IMPORTANT' })).toBe(s)
  })
})
