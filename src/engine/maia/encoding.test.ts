import { describe, it, expect } from 'vitest'
import { encodeFen, INPUT_SIZE, PLANE_SIZE } from './encoding'

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
const AFTER_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1'

function plane(data: Float32Array, p: number): Float32Array {
  return data.slice(p * PLANE_SIZE, (p + 1) * PLANE_SIZE)
}
const sum = (a: Float32Array) => a.reduce((s, v) => s + v, 0)

describe('encodeFen', () => {
  it('produces a 7168-float tensor', () => {
    expect(encodeFen(START)).toHaveLength(INPUT_SIZE)
  })

  it('sets the all-ones plane (111) and leaves the zeros plane (110) empty', () => {
    const d = encodeFen(START)
    expect(sum(plane(d, 111))).toBe(64)
    expect(sum(plane(d, 110))).toBe(0)
  })

  it('side-to-move plane (108) is 0 for white, filled for black', () => {
    expect(sum(plane(encodeFen(START), 108))).toBe(0)
    expect(sum(plane(encodeFen(AFTER_E4), 108))).toBe(64)
  })

  it('start position has 32 pieces across the 12 piece planes of frame 0', () => {
    const d = encodeFen(START)
    let total = 0
    for (let p = 0; p < 12; p++) total += sum(plane(d, p))
    expect(total).toBe(32)
  })

  it('white own pawns (plane 0) sit on the 2nd rank, squares 8..15', () => {
    const d = encodeFen(START)
    expect(sum(plane(d, 0))).toBe(8)
    for (let s = 8; s <= 15; s++) expect(d[0 * PLANE_SIZE + s]).toBe(1)
  })

  it("black to move: own pawns are mirrored to the mover's 2nd rank (squares 8..15)", () => {
    // After 1.e4 black is to move; its own pawns (plane 0) flip to squares 8..15,
    // except the e-pawn is still home (e7) so all 8 black pawns remain on rank 7 → mirror rank 2.
    const d = encodeFen(AFTER_E4)
    expect(sum(plane(d, 0))).toBe(8)
    for (let s = 8; s <= 15; s++) expect(d[0 * PLANE_SIZE + s]).toBe(1)
  })

  it('encodes castling rights into planes 104..107', () => {
    const full = encodeFen(START)
    expect(sum(plane(full, 104))).toBe(64) // our queenside
    expect(sum(plane(full, 105))).toBe(64) // our kingside
    const none = encodeFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w - - 0 1')
    for (const p of [104, 105, 106, 107]) expect(sum(plane(none, p))).toBe(0)
  })

  it('scales the rule50 counter into plane 109', () => {
    const d = encodeFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 99 60')
    expect(plane(d, 109)[0]).toBeCloseTo(1, 5)
  })
})
