import { describe, it, expect } from 'vitest'
import type { CoachVerdict } from '../domain/coach'
import {
  playReducer,
  initialPlayState,
  currentFen,
  displayFen,
  historyForMaia,
  isLegalMove,
  type PlayState,
} from './playMachine'

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

/** Drive a full coached move of yours: move → coach verdict → continue. */
function yourMove(state: PlayState, from: string, to: string, v = verdict()): PlayState {
  let s = playReducer(state, { type: 'MOVE', from, to })
  s = playReducer(s, { type: 'COACH_RESULT', verdict: v, evalWhitePct: 50 })
  return playReducer(s, { type: 'CONTINUE' })
}

describe('NEW_GAME', () => {
  it('white to move → your turn; black → Maia thinks first', () => {
    expect(newGame('w').status).toBe('yourTurn')
    expect(newGame('b').status).toBe('thinking')
  })
})

describe('the coached move flow', () => {
  it('MOVE stages a pending move and asks for a grade (does not commit)', () => {
    const s = playReducer(newGame('w'), { type: 'MOVE', from: 'e2', to: 'e4' })
    expect(s.status).toBe('grading')
    expect(s.pending?.san).toBe('e4')
    expect(s.positions).toHaveLength(1) // not committed yet
    expect(displayFen(s)).toBe(s.pending?.afterFen) // board shows your pending move
    expect(currentFen(s)).toBe(s.positions[0]) // live position unchanged
  })

  it('COACH_RESULT reveals the verdict; CONTINUE commits and hands Maia the turn', () => {
    let s = playReducer(newGame('w'), { type: 'MOVE', from: 'e2', to: 'e4' })
    s = playReducer(s, { type: 'COACH_RESULT', verdict: verdict('B', 8), evalWhitePct: 55 })
    expect(s.status).toBe('coached')
    expect(s.verdict?.tier).toBe('B')
    expect(s.evalWhitePct).toBe(55)

    s = playReducer(s, { type: 'CONTINUE' })
    expect(s.status).toBe('thinking')
    expect(s.sanHistory).toEqual(['e4'])
    expect(s.positions).toHaveLength(2)
    expect(s.coachLog).toEqual([{ ply: 0, san: 'e4', tier: 'B', swing: 8 }])
    expect(s.pending).toBeNull()
  })

  it('TAKE_BACK reverts your move without committing it', () => {
    let s = playReducer(newGame('w'), { type: 'MOVE', from: 'e2', to: 'e4' })
    s = playReducer(s, { type: 'COACH_RESULT', verdict: verdict('C', 30), evalWhitePct: 20 })
    s = playReducer(s, { type: 'TAKE_BACK' })
    expect(s.status).toBe('yourTurn')
    expect(s.pending).toBeNull()
    expect(s.sanHistory).toEqual([])
    expect(s.coachLog).toEqual([])
  })

  it('GRADING_FAILED still lets you continue (engine hiccup never blocks play)', () => {
    let s = playReducer(newGame('w'), { type: 'MOVE', from: 'e2', to: 'e4' })
    s = playReducer(s, { type: 'GRADING_FAILED' })
    expect(s.status).toBe('coached')
    expect(s.verdict).toBeNull()
    s = playReducer(s, { type: 'CONTINUE' })
    expect(s.status).toBe('thinking')
    expect(s.sanHistory).toEqual(['e4'])
  })

  it('ignores an illegal move and a move out of turn', () => {
    const s = newGame('w')
    expect(playReducer(s, { type: 'MOVE', from: 'e2', to: 'e5' })).toBe(s)
    const grading = playReducer(s, { type: 'MOVE', from: 'e2', to: 'e4' })
    expect(playReducer(grading, { type: 'MOVE', from: 'd2', to: 'd4' })).toBe(grading)
  })

  it('auto-queens a promotion by default', () => {
    const fen = '8/P7/8/8/8/8/8/k6K w - - 0 1'
    const s: PlayState = { ...newGame('w'), positions: [fen], status: 'yourTurn' }
    const moved = playReducer(s, { type: 'MOVE', from: 'a7', to: 'a8' })
    expect(moved.pending?.san).toBe('a8=Q+')
  })
})

describe("Maia's move", () => {
  it('applies a UCI reply and returns the turn to you', () => {
    let s = yourMove(newGame('w'), 'e2', 'e4')
    s = playReducer(s, { type: 'MAIA_MOVED', uci: 'c7c5' })
    expect(s.sanHistory).toEqual(['e4', 'c5'])
    expect(s.status).toBe('yourTurn')
    expect(s.coachLog).toHaveLength(1) // Maia's move is not coached
  })

  it('ignores a Maia move when it is your turn', () => {
    const s = newGame('w')
    expect(playReducer(s, { type: 'MAIA_MOVED', uci: 'e2e4' })).toBe(s)
  })
})

describe('click-to-move', () => {
  it('selects your piece, then stages the move on the second click', () => {
    const sel = playReducer(newGame('w'), { type: 'SELECT_SQUARE', square: 'e2' })
    expect(sel.selected).toBe('e2')
    const moved = playReducer(sel, { type: 'SELECT_SQUARE', square: 'e4' })
    expect(moved.status).toBe('grading')
    expect(moved.pending?.san).toBe('e4')
  })

  it('reselects another of your pieces; deselects on the same square', () => {
    const sel = playReducer(newGame('w'), { type: 'SELECT_SQUARE', square: 'e2' })
    expect(playReducer(sel, { type: 'SELECT_SQUARE', square: 'd2' }).selected).toBe('d2')
    expect(playReducer(sel, { type: 'SELECT_SQUARE', square: 'e2' }).selected).toBeNull()
  })
})

describe('game end', () => {
  it('detects checkmate delivered by Maia (fools mate, you lose)', () => {
    let s = yourMove(newGame('w'), 'f2', 'f3')
    s = playReducer(s, { type: 'MAIA_MOVED', uci: 'e7e5' })
    s = yourMove(s, 'g2', 'g4')
    s = playReducer(s, { type: 'MAIA_MOVED', uci: 'd8h4' }) // Qh4#
    expect(s.status).toBe('over')
    expect(s.result).toEqual({ outcome: 'maia', reason: 'checkmate' })
  })

  it('detects checkmate delivered by you on CONTINUE (you win, playing black)', () => {
    let s = newGame('b')
    s = playReducer(s, { type: 'MAIA_MOVED', uci: 'f2f3' })
    s = yourMove(s, 'e7', 'e5')
    s = playReducer(s, { type: 'MAIA_MOVED', uci: 'g2g4' })
    s = yourMove(s, 'd8', 'h4') // Qh4#
    expect(s.status).toBe('over')
    expect(s.result).toEqual({ outcome: 'you', reason: 'checkmate' })
  })

  it('resigning loses the game', () => {
    const s = playReducer(newGame('w'), { type: 'RESIGN' })
    expect(s.status).toBe('over')
    expect(s.result).toEqual({ outcome: 'maia', reason: 'resignation' })
  })
})

describe('selectors', () => {
  it('historyForMaia is prior positions, most-recent-first, excluding current', () => {
    let s = yourMove(newGame('w'), 'e2', 'e4')
    s = playReducer(s, { type: 'MAIA_MOVED', uci: 'c7c5' })
    const hist = historyForMaia(s)
    expect(hist).toHaveLength(2)
    expect(hist[0]).toBe(s.positions[1])
  })

  it('SET_EVAL updates the who-is-ahead reading', () => {
    expect(playReducer(newGame('w'), { type: 'SET_EVAL', whitePct: 63 }).evalWhitePct).toBe(63)
  })

  it('isLegalMove validates for the side to move', () => {
    const fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
    expect(isLegalMove(fen, 'e2', 'e4')).toBe(true)
    expect(isLegalMove(fen, 'e2', 'e5')).toBe(false)
  })
})
