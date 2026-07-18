import { describe, it, expect } from 'vitest'
import {
  playReducer,
  initialPlayState,
  currentFen,
  sideToMove,
  historyForMaia,
  isLegalMove,
  type PlayState,
  type PlayAction,
} from './playMachine'

const newGame = (yourColor: 'w' | 'b' = 'w'): PlayState =>
  playReducer(initialPlayState, { type: 'NEW_GAME', yourColor, level: 1300, gameId: 'g1' })

const run = (state: PlayState, actions: PlayAction[]): PlayState =>
  actions.reduce(playReducer, state)

describe('NEW_GAME', () => {
  it('white to move → your turn; black → Maia thinks first', () => {
    expect(newGame('w').status).toBe('yourTurn')
    expect(newGame('b').status).toBe('thinking')
    expect(newGame('w').screen).toBe('play')
  })
})

describe('your move', () => {
  it('applies a legal move and hands the turn to Maia', () => {
    const s = playReducer(newGame('w'), { type: 'MOVE', from: 'e2', to: 'e4' })
    expect(s.sanHistory).toEqual(['e4'])
    expect(s.status).toBe('thinking')
    expect(s.positions).toHaveLength(2)
    expect(sideToMove(s)).toBe('b')
    expect(s.ply).toBe(1)
  })

  it('ignores an illegal move', () => {
    const s = newGame('w')
    expect(playReducer(s, { type: 'MOVE', from: 'e2', to: 'e5' })).toBe(s)
  })

  it("ignores a move when it is Maia's turn", () => {
    const thinking = playReducer(newGame('w'), { type: 'MOVE', from: 'e2', to: 'e4' })
    expect(playReducer(thinking, { type: 'MOVE', from: 'd7', to: 'd5' })).toBe(thinking)
  })

  it('auto-queens a promotion by default', () => {
    // white pawn on a7, black king tucked away; a7a8 is a legal promotion
    const fen = '8/P7/8/8/8/8/8/k6K w - - 0 1'
    const s: PlayState = { ...newGame('w'), positions: [fen], status: 'yourTurn' }
    const moved = playReducer(s, { type: 'MOVE', from: 'a7', to: 'a8' })
    expect(moved.sanHistory).toEqual(['a8=Q+'])
  })
})

describe("Maia's move", () => {
  it('applies a UCI move and returns the turn to you', () => {
    const thinking = playReducer(newGame('w'), { type: 'MOVE', from: 'e2', to: 'e4' })
    const s = playReducer(thinking, { type: 'MAIA_MOVED', uci: 'c7c5' })
    expect(s.sanHistory).toEqual(['e4', 'c5'])
    expect(s.status).toBe('yourTurn')
  })

  it('ignores a Maia move when it is your turn', () => {
    const s = newGame('w')
    expect(playReducer(s, { type: 'MAIA_MOVED', uci: 'e2e4' })).toBe(s)
  })
})

describe('click-to-move', () => {
  it('selects your piece, then completes the move on the second click', () => {
    const sel = playReducer(newGame('w'), { type: 'SELECT_SQUARE', square: 'e2' })
    expect(sel.selected).toBe('e2')
    const moved = playReducer(sel, { type: 'SELECT_SQUARE', square: 'e4' })
    expect(moved.selected).toBeNull()
    expect(moved.sanHistory).toEqual(['e4'])
    expect(moved.status).toBe('thinking')
  })

  it('reselects when you click another of your pieces; deselects on the same square', () => {
    const sel = playReducer(newGame('w'), { type: 'SELECT_SQUARE', square: 'e2' })
    expect(playReducer(sel, { type: 'SELECT_SQUARE', square: 'd2' }).selected).toBe('d2')
    expect(playReducer(sel, { type: 'SELECT_SQUARE', square: 'e2' }).selected).toBeNull()
  })

  it('ignores selecting an empty or enemy square', () => {
    const s = newGame('w')
    expect(playReducer(s, { type: 'SELECT_SQUARE', square: 'e4' }).selected).toBeNull()
    expect(playReducer(s, { type: 'SELECT_SQUARE', square: 'e7' }).selected).toBeNull()
  })
})

describe('game end', () => {
  it('detects checkmate delivered by Maia (you lose) — fools mate', () => {
    const end = run(newGame('w'), [
      { type: 'MOVE', from: 'f2', to: 'f3' },
      { type: 'MAIA_MOVED', uci: 'e7e5' },
      { type: 'MOVE', from: 'g2', to: 'g4' },
      { type: 'MAIA_MOVED', uci: 'd8h4' }, // Qh4#
    ])
    expect(end.status).toBe('over')
    expect(end.result).toEqual({ outcome: 'maia', reason: 'checkmate' })
  })

  it('detects checkmate delivered by you (you win) when playing black', () => {
    const end = run(newGame('b'), [
      { type: 'MAIA_MOVED', uci: 'f2f3' },
      { type: 'MOVE', from: 'e7', to: 'e5' },
      { type: 'MAIA_MOVED', uci: 'g2g4' },
      { type: 'MOVE', from: 'd8', to: 'h4' }, // Qh4#
    ])
    expect(end.status).toBe('over')
    expect(end.result).toEqual({ outcome: 'you', reason: 'checkmate' })
  })

  it('resigning loses the game', () => {
    const s = playReducer(newGame('w'), { type: 'RESIGN' })
    expect(s.status).toBe('over')
    expect(s.result).toEqual({ outcome: 'maia', reason: 'resignation' })
  })

  it('does not accept moves after the game is over', () => {
    const over = playReducer(newGame('w'), { type: 'RESIGN' })
    expect(playReducer(over, { type: 'MOVE', from: 'e2', to: 'e4' })).toBe(over)
  })
})

describe('selectors', () => {
  it('historyForMaia is prior positions, most-recent-first, excluding current', () => {
    const s = run(newGame('w'), [
      { type: 'MOVE', from: 'e2', to: 'e4' },
      { type: 'MAIA_MOVED', uci: 'c7c5' },
    ])
    const hist = historyForMaia(s)
    expect(hist).toHaveLength(2)
    expect(hist[0]).toBe(s.positions[1]) // most recent prior position first
    expect(currentFen(s)).toBe(s.positions[2])
  })

  it('isLegalMove validates for the side to move', () => {
    const fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
    expect(isLegalMove(fen, 'e2', 'e4')).toBe(true)
    expect(isLegalMove(fen, 'e2', 'e5')).toBe(false)
  })
})
