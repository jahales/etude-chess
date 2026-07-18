import { describe, it, expect } from 'vitest'
import { materialBalance } from './material'
import { Chess } from 'chess.js'

const START = new Chess().fen()

describe('materialBalance', () => {
  it('is even with nothing captured at the start', () => {
    const m = materialBalance(START)
    expect(m.diff).toBe(0)
    expect(m.whiteValue).toBe(m.blackValue)
    expect(m.capturedByWhite).toEqual([])
    expect(m.capturedByBlack).toEqual([])
  })

  it('counts a pawn White captured', () => {
    // After 1.e4 d5 2.exd5 — White has taken Black's d-pawn.
    const c = new Chess()
    c.move('e4')
    c.move('d5')
    c.move('exd5')
    const m = materialBalance(c.fen())
    expect(m.diff).toBe(1)
    expect(m.capturedByWhite).toEqual(['p'])
    expect(m.capturedByBlack).toEqual([])
  })

  it('nets an uneven exchange (White wins a knight for nothing)', () => {
    // White knight on d5, no black pieces missing except one knight.
    const m = materialBalance('r1bqkbnr/pppppppp/8/3N4/8/8/PPPPPPPP/R1BQKBNR b KQkq - 0 1')
    expect(m.capturedByWhite).toEqual(['n'])
    expect(m.diff).toBe(3)
  })
})
