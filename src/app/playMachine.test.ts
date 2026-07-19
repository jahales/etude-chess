import { describe, it, expect } from 'vitest'
import type { CoachVerdict } from '../domain/coach'
import {
  playReducer,
  initialPlayState,
  currentFen,
  currentEval,
  canTakeBack,
  openingName,
  gameAccuracy,
  historyForMaia,
  isLegalMove,
  type PlayState,
  type PositionEval,
} from './playMachine'
import { moveAccuracy } from '../domain/accuracy'

const newGame = (yourColor: 'w' | 'b' = 'w'): PlayState =>
  playReducer(initialPlayState, { type: 'NEW_GAME', yourColor, level: 1300, gameId: 'g1' })

const verdict = (tier: 'A' | 'B' | 'C' = 'A', swing = 0): CoachVerdict => ({
  tier,
  swing,
  headline: '',
  detail: '',
  bestMoveSan: null,
  hanging: [],
})
const ev = (whitePct: number): PositionEval => ({ whitePct, label: `${whitePct}` })

/** Your move + Maia's reply (the ambient flow: no acknowledge gate). */
function pair(state: PlayState, from: string, to: string, maiaUci: string): PlayState {
  const thinking = playReducer(state, { type: 'MOVE', from, to })
  return playReducer(thinking, { type: 'MAIA_MOVED', uci: maiaUci })
}

describe('NEW_GAME', () => {
  it('white to move → your turn; black → Maia thinks first', () => {
    expect(newGame('w').status).toBe('yourTurn')
    expect(newGame('b').status).toBe('thinking')
  })
})

describe('ambient move flow (no acknowledge gate)', () => {
  it('your move applies immediately and hands the turn to Maia', () => {
    const s = playReducer(newGame('w'), { type: 'MOVE', from: 'e2', to: 'e4' })
    expect(s.status).toBe('thinking')
    expect(s.sanHistory).toEqual(['e4']) // committed right away — no pending
    expect(s.positions).toHaveLength(2)
  })

  it('Maia replies and it becomes your turn again', () => {
    const s = pair(newGame('w'), 'e2', 'e4', 'c7c5')
    expect(s.sanHistory).toEqual(['e4', 'c5'])
    expect(s.status).toBe('yourTurn')
  })

  it('ignores an illegal or out-of-turn move', () => {
    const s = newGame('w')
    expect(playReducer(s, { type: 'MOVE', from: 'e2', to: 'e5' })).toBe(s)
    const thinking = playReducer(s, { type: 'MOVE', from: 'e2', to: 'e4' })
    expect(playReducer(thinking, { type: 'MOVE', from: 'd7', to: 'd5' })).toBe(thinking)
  })

  it('click-to-move applies immediately on the second click', () => {
    const sel = playReducer(newGame('w'), { type: 'SELECT_SQUARE', square: 'e2' })
    expect(sel.selected).toBe('e2')
    const moved = playReducer(sel, { type: 'SELECT_SQUARE', square: 'e4' })
    expect(moved.status).toBe('thinking')
    expect(moved.sanHistory).toEqual(['e4'])
  })
})

describe('coach feedback', () => {
  it('COACH_RESULT records the verdict and logs the move', () => {
    const thinking = playReducer(newGame('w'), { type: 'MOVE', from: 'e2', to: 'e4' })
    const s = playReducer(thinking, {
      type: 'COACH_RESULT',
      ply: 0,
      fenBefore: initialPlayState.positions[0]!,
      yourMoveSan: 'e4',
      verdict: verdict('B', 8),
    })
    expect(s.lastCoach?.verdict.tier).toBe('B')
    expect(s.lastCoach?.fenBefore).toBe(initialPlayState.positions[0])
    expect(s.coachLog).toEqual([
      { ply: 0, fen: initialPlayState.positions[0], san: 'e4', tier: 'B', swing: 8, bestMoveSan: null },
    ])
  })

  it('ignores a stale grade for a move no longer at that ply', () => {
    const s = pair(newGame('w'), 'e2', 'e4', 'c7c5')
    const taken = playReducer(s, { type: 'TAKE_BACK' }) // removes e4 + c5
    const late = playReducer(taken, {
      type: 'COACH_RESULT',
      ply: 0,
      fenBefore: 'x',
      yourMoveSan: 'e4',
      verdict: verdict('C', 30),
    })
    expect(late).toBe(taken) // no stale coach applied
  })

  it('SET_LINES reveals engine lines; HIDE_LINES collapses them', () => {
    const thinking = playReducer(newGame('w'), { type: 'MOVE', from: 'e2', to: 'e4' })
    const shown = playReducer(thinking, { type: 'SET_LINES', lines: [{ multipv: 1, score: { type: 'cp', value: 20 }, pv: ['e2e4'] }] })
    expect(shown.showMe).toBe(true)
    expect(shown.lines).toHaveLength(1)
    expect(playReducer(shown, { type: 'HIDE_LINES' }).showMe).toBe(false)
  })

  it('a new move clears stale coach + revealed lines', () => {
    let s = playReducer(newGame('w'), { type: 'MOVE', from: 'e2', to: 'e4' })
    s = playReducer(s, { type: 'SET_LINES', lines: [{ multipv: 1, score: { type: 'cp', value: 0 }, pv: [] }] })
    s = playReducer(s, { type: 'MAIA_MOVED', uci: 'c7c5' })
    s = playReducer(s, { type: 'MOVE', from: 'd2', to: 'd4' })
    expect(s.showMe).toBe(false)
    expect(s.lines).toEqual([])
    expect(s.lastCoach).toBeNull()
  })
})

describe('accuracy (final line) and take-backs', () => {
  const coach = (state: PlayState, san: string, tier: 'A' | 'B' | 'C', swing: number, best: string | null = null) =>
    playReducer(state, {
      type: 'COACH_RESULT',
      ply: state.sanHistory.length - 1,
      fenBefore: state.positions[state.sanHistory.length - 1]!,
      yourMoveSan: san,
      verdict: { ...verdict(tier, swing), bestMoveSan: best },
    })

  it('scores accuracy from your graded move', () => {
    let s = playReducer(newGame('w'), { type: 'MOVE', from: 'e2', to: 'e4' })
    s = coach(s, 'e4', 'B', 8)
    expect(s.coachLog).toHaveLength(1)
    expect(gameAccuracy(s)).toBeCloseTo(moveAccuracy(8), 5)
    expect(s.takebacks).toBe(0)
  })

  it('accuracy tracks the final line — take back a mistake, replay a good move, count the take-back', () => {
    let s = pair(newGame('w'), 'e2', 'e4', 'c7c5')
    s = coach(s, 'e4', 'C', 30) // your kept move so far is a mistake
    s = playReducer(s, { type: 'TAKE_BACK' })
    expect(s.coachLog).toEqual([]) // final line no longer contains it
    expect(s.takebacks).toBe(1)
    // replay a good move from the same position
    s = playReducer(s, { type: 'MOVE', from: 'd2', to: 'd4' })
    s = coach(s, 'd4', 'A', 0)
    expect(s.coachLog).toHaveLength(1)
    expect(gameAccuracy(s)).toBeCloseTo(moveAccuracy(0), 5) // reflects the kept move
    expect(s.takebacks).toBe(1) // but the take-back is still counted
  })

  it('accuracy is 100 with no moves yet', () => {
    expect(gameAccuracy(newGame('w'))).toBe(100)
  })
})

describe('position eval', () => {
  it('SET_EVAL stores by ply and currentEval reads the latest', () => {
    let s = pair(newGame('w'), 'e2', 'e4', 'c7c5')
    s = playReducer(s, { type: 'SET_EVAL', ply: 0, eval: ev(56) })
    s = playReducer(s, { type: 'SET_EVAL', ply: 1, eval: ev(52) })
    expect(s.evalByPly[0]).toEqual(ev(56))
    expect(currentEval(s)).toEqual(ev(52))
  })

  it('ignores a stale eval for a ply beyond the game', () => {
    const s = playReducer(newGame('w'), { type: 'SET_EVAL', ply: 5, eval: ev(50) })
    expect(s.evalByPly[5]).toBeUndefined()
  })
})

describe('take back', () => {
  it('undoes your move + Maia’s reply and clears their coach/eval', () => {
    let s = pair(newGame('w'), 'e2', 'e4', 'c7c5')
    s = playReducer(s, { type: 'COACH_RESULT', ply: 0, fenBefore: 'x', yourMoveSan: 'e4', verdict: verdict('C', 30) })
    s = playReducer(s, { type: 'SET_EVAL', ply: 0, eval: ev(40) })
    s = playReducer(s, { type: 'SET_EVAL', ply: 1, eval: ev(45) })
    const back = playReducer(s, { type: 'TAKE_BACK' })
    expect(back.sanHistory).toEqual([])
    expect(back.positions).toHaveLength(1)
    expect(back.coachLog).toEqual([])
    expect(back.evalByPly).toEqual([])
    expect(back.lastCoach).toBeNull()
    expect(back.status).toBe('yourTurn')
  })

  it('canTakeBack only once a full pair exists', () => {
    expect(canTakeBack(newGame('w'))).toBe(false)
    const thinking = playReducer(newGame('w'), { type: 'MOVE', from: 'e2', to: 'e4' })
    expect(canTakeBack(thinking)).toBe(false) // Maia hasn't replied
    expect(canTakeBack(pair(newGame('w'), 'e2', 'e4', 'c7c5'))).toBe(true)
  })
})

describe('game end', () => {
  it('detects checkmate delivered by Maia (fools mate, you lose)', () => {
    let s = pair(newGame('w'), 'f2', 'f3', 'e7e5')
    s = playReducer(s, { type: 'MOVE', from: 'g2', to: 'g4' })
    s = playReducer(s, { type: 'MAIA_MOVED', uci: 'd8h4' }) // Qh4#
    expect(s.status).toBe('over')
    expect(s.result).toEqual({ outcome: 'maia', reason: 'checkmate' })
  })

  it('detects checkmate delivered by you (playing black)', () => {
    let s = newGame('b')
    s = playReducer(s, { type: 'MAIA_MOVED', uci: 'f2f3' })
    s = pair(s, 'e7', 'e5', 'g2g4')
    s = playReducer(s, { type: 'MOVE', from: 'd8', to: 'h4' }) // Qh4#
    expect(s.status).toBe('over')
    expect(s.result).toEqual({ outcome: 'you', reason: 'checkmate' })
  })

  it('resign loses; draw is agreed', () => {
    expect(playReducer(newGame('w'), { type: 'RESIGN' }).result).toEqual({ outcome: 'maia', reason: 'resignation' })
    expect(playReducer(newGame('w'), { type: 'DRAW_GAME' }).result).toEqual({ outcome: 'draw', reason: 'agreement' })
  })
})

describe('selectors', () => {
  it('names the opening from the moves played', () => {
    const s = pair(newGame('w'), 'e2', 'e4', 'c7c5')
    expect(openingName(s)).toBe('Sicilian Defense')
  })

  it('historyForMaia is capped at 7 prior positions, most-recent-first', () => {
    const positions = Array.from({ length: 10 }, (_, i) => `fen${i}`)
    const hist = historyForMaia({ ...newGame('w'), positions })
    expect(hist).toHaveLength(7)
    expect(hist[0]).toBe('fen8')
    expect(hist).not.toContain('fen9')
  })

  it('isLegalMove validates for the side to move', () => {
    const fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
    expect(isLegalMove(fen, 'e2', 'e4')).toBe(true)
    expect(isLegalMove(fen, 'e2', 'e5')).toBe(false)
  })

  it('currentFen tracks the latest position', () => {
    const s = pair(newGame('w'), 'e2', 'e4', 'c7c5')
    expect(currentFen(s)).toBe(s.positions[2])
  })
})
