import { describe, expect, it } from 'vitest'
import {
  judgeTablebase,
  pieceCount,
  resultForMover,
  tablebaseEligible,
  type TablebaseMove,
  type TablebaseResult,
} from './tablebase'

const move = (san: string, category: TablebaseMove['category'], dtz: number | null): TablebaseMove => ({
  uci: san.toLowerCase(),
  san,
  category,
  dtz,
  dtm: null,
})

describe('deciding whether a position is solved at all', () => {
  it('counts the pieces and ignores the rest of the FEN', () => {
    // Digits are empty squares; the 'b', 'w' and castling fields are not pieces.
    expect(pieceCount('8/8/8/8/8/8/4K3/4k3 w - - 0 1')).toBe(2)
    expect(pieceCount('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1')).toBe(32)
  })

  it('is eligible at seven pieces and not at eight', () => {
    expect(tablebaseEligible('8/8/8/8/1r6/4k3/4P3/4K3 w - - 0 1')).toBe(true) // 5
    expect(tablebaseEligible('6k1/5ppp/8/8/8/7R/7P/6K1 w - - 0 1')).toBe(true) // 7
    expect(tablebaseEligible('6k1/p4pp1/8/8/5P2/7R/7P/6K1 w - - 0 1')).toBe(false) // 8
    expect(tablebaseEligible('6k1/p4ppn/8/4P3/1r3PK1/7R/7P/8 b - - 0 1')).toBe(false) // 9
  })
})

describe('reading a move result from the right side of the board', () => {
  it('flips it, because the API reports the position *after* the move', () => {
    // The single most dangerous thing in this module: a move that leaves the
    // opponent lost is a winning move, and the raw category says 'loss'.
    expect(resultForMover(move('a5', 'loss', -11))).toBe('win')
    expect(resultForMover(move('Rb8', 'win', 11))).toBe('loss')
    expect(resultForMover(move('Kg2', 'draw', 0))).toBe('draw')
  })

  it('keeps the fifty-move-rule cases distinct rather than rounding them off', () => {
    expect(resultForMover(move('a5', 'blessed-loss', -101))).toBe('cursed-win')
    expect(resultForMover(move('a5', 'cursed-win', 101))).toBe('blessed-loss')
  })
})

describe('judging the position and the move played in it', () => {
  const winning: TablebaseResult = {
    category: 'win',
    dtz: 12,
    dtm: 25,
    moves: [
      move('a5', 'loss', -11), // wins, and fastest
      move('g5', 'loss', -17), // also wins, slower
      move('Rb8', 'draw', 0), // throws it
      move('Rxf4', 'win', 5), // loses outright
    ],
  }

  it('picks every move that keeps the best result, fastest first', () => {
    const verdict = judgeTablebase(winning)
    expect(verdict.category).toBe('win')
    expect(verdict.best.map((m) => m.san)).toEqual(['a5', 'g5'])
  })

  it('says plainly when the move played threw the win away, and to what', () => {
    const verdict = judgeTablebase(winning, 'Rb8')
    expect(verdict.playedHolds).toBe(false)
    expect(verdict.threwAwayTo).toBe('draw')
  })

  it('credits a move that holds the win even when it is not the fastest', () => {
    // Slower is not wrong. Grading by DTZ would invent mistakes that are not there.
    const verdict = judgeTablebase(winning, 'g5')
    expect(verdict.playedHolds).toBe(true)
    expect(verdict.threwAwayTo).toBeNull()
  })

  it('reports nothing about a move it was not given data for', () => {
    const verdict = judgeTablebase(winning, 'Kh8')
    expect(verdict.played).toBeNull()
    expect(verdict.playedHolds).toBeNull()
  })

  it('in a lost position, treats the moves that merely survive as the best ones', () => {
    // Everything loses, so "holds the result" must mean the least bad, not a win.
    const lost: TablebaseResult = {
      category: 'loss',
      dtz: -8,
      dtm: -15,
      moves: [move('Kg1', 'win', 7), move('Kh1', 'win', 3)],
    }
    const verdict = judgeTablebase(lost, 'Kg1')
    expect(verdict.best.map((m) => m.san)).toEqual(['Kh1', 'Kg1'])
    expect(verdict.playedHolds).toBe(true)
  })

  it('prefers a draw over a loss when no win is available', () => {
    const drawable: TablebaseResult = {
      category: 'draw',
      dtz: 0,
      dtm: null,
      moves: [move('Kf2', 'draw', 0), move('Kf1', 'win', 9)],
    }
    const verdict = judgeTablebase(drawable, 'Kf1')
    expect(verdict.best.map((m) => m.san)).toEqual(['Kf2'])
    expect(verdict.playedHolds).toBe(false)
    expect(verdict.threwAwayTo).toBe('loss')
  })

  it('copes with a position that has no moves listed', () => {
    const verdict = judgeTablebase({ category: 'loss', dtz: null, dtm: null, moves: [] }, 'Kg1')
    expect(verdict.best).toEqual([])
    expect(verdict.playedHolds).toBeNull()
  })
})
