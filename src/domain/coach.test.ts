import { describe, it, expect } from 'vitest'
import { coachVerdict } from './coach'
import type { MoveGrade } from './grade'

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
const grade = (tier: 'A' | 'B' | 'C', swing: number): MoveGrade => ({
  tier,
  swing,
  bestWinPercent: 55,
  playedWinPercent: 55 - swing,
})

describe('coachVerdict', () => {
  it('praises a top move and notes the engine agrees', () => {
    const v = coachVerdict({ fen: START, userMoveSan: 'e4', grade: grade('A', 0), bestMoveUci: 'e2e4' })
    expect(v.headline).toBe('Good move.')
    expect(v.detail).toContain('top choice')
    expect(v.bestMoveSan).toBe('e4')
  })

  it('for a good move that is not the engine top, stays clean (no scolding)', () => {
    const v = coachVerdict({ fen: START, userMoveSan: 'd4', grade: grade('A', 3), bestMoveUci: 'e2e4' })
    expect(v.headline).toBe('Good move.')
    expect(v.detail).toBe('')
  })

  it('explains a mistake with the engine pick and the swing', () => {
    const v = coachVerdict({ fen: START, userMoveSan: 'a4', grade: grade('C', 22), bestMoveUci: 'e2e4' })
    expect(v.headline).toBe('Mistake.')
    expect(v.detail).toContain('engine prefers e4')
    expect(v.detail).toContain('22%')
  })

  it('reports a genuinely hanging piece', () => {
    // Black bishop on c7 rakes the a5-e5 diagonal; White plays Re5?? hanging the rook to ...Bxe5.
    const fen = '7k/2b5/8/8/8/8/4R3/7K w - - 0 1'
    const v = coachVerdict({ fen, userMoveSan: 'Re5', grade: grade('C', 30), bestMoveUci: 'e2e4' })
    const hitRook = v.hanging.some((h) => h.piece === 'r')
    expect(hitRook).toBe(true)
    expect(v.detail).toContain('hanging')
  })
})
