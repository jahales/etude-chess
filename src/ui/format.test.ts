import { describe, it, expect } from 'vitest'
import type { QuizItem } from '../domain/harness'
import { LAST_MOVE_MARK, lastMoveSquareStyles, priorMoveLabel } from './format'

const item = (over: Partial<QuizItem>): QuizItem => ({
  fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  ply: 8,
  moveNumber: 5,
  sideToMove: 'w',
  masterMoveSan: 'Qxf3',
  masterMoveUci: 'd1f3',
  ...over,
})

describe('lastMoveSquareStyles', () => {
  it('marks the two squares the move touched', () => {
    expect(lastMoveSquareStyles('g4f3')).toEqual({ g4: LAST_MOVE_MARK, f3: LAST_MOVE_MARK })
  })

  it('marks the same square once for a move that ends where it began', () => {
    // Not legal chess — but a map with one key is what a caller must get,
    // rather than two entries fighting over one square.
    expect(Object.keys(lastMoveSquareStyles('e2e2'))).toEqual(['e2'])
  })

  it('marks nothing at all when there is no move', () => {
    // The first position of a session, and of a SetUp/FEN game (#128): absent
    // has to be *nothing*, never a mark on an empty square name.
    expect(lastMoveSquareStyles(undefined)).toEqual({})
    expect(lastMoveSquareStyles(null)).toEqual({})
    expect(lastMoveSquareStyles('')).toEqual({})
    expect(lastMoveSquareStyles('e2')).toEqual({})
  })

  it('ignores a promotion suffix, which names no third square', () => {
    expect(lastMoveSquareStyles('b7b8q')).toEqual({ b7: LAST_MOVE_MARK, b8: LAST_MOVE_MARK })
  })
})

describe('priorMoveLabel', () => {
  it('numbers the move one ply back, played by the other side', () => {
    // Ply 8 is White's 5th move, so the move into it is Black's 4th.
    expect(priorMoveLabel(item({ ply: 8, sideToMove: 'w', priorMoveSan: 'Bxf3' }))).toBe('4…Bxf3')
  })

  it('numbers a White move that led into a Black position', () => {
    expect(priorMoveLabel(item({ ply: 9, sideToMove: 'b', priorMoveSan: 'Qxf3' }))).toBe('5.Qxf3')
  })

  it('is null when nothing was played into the position', () => {
    expect(priorMoveLabel(item({ ply: 0, sideToMove: 'w' }))).toBeNull()
  })
})
