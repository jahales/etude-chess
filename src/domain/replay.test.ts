import { describe, it, expect } from 'vitest'
import { Chess } from 'chess.js'
import { replayPositions } from './replay'

const START = new Chess().fen()

describe('replayPositions', () => {
  it('returns just the start position for an empty game', () => {
    expect(replayPositions([])).toEqual([START])
  })

  it('returns one more position than moves, before-move indexed', () => {
    const positions = replayPositions(['e4', 'e5', 'Nf3'])
    expect(positions).toHaveLength(4)
    expect(positions[0]).toBe(START) // before move 0
    expect(positions[1]).toContain(' b ') // Black to move after 1.e4
    expect(positions[3]).toContain('N') // knight developed
  })

  it('honours a start FEN so play-outs replay from where they began', () => {
    const fen = 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 4 3'
    const positions = replayPositions(['Bb5'], fen)
    expect(positions[0]).toBe(fen)
    expect(positions).toHaveLength(2)
  })

  it('stops at a move it cannot replay instead of throwing', () => {
    // Stored data can outlive the code that wrote it. Showing the part of the
    // game we can reconstruct beats losing the whole record.
    const positions = replayPositions(['e4', 'Qh5xz', 'Nf3'])
    expect(positions).toHaveLength(2)
    expect(positions[1]).toContain(' b ')
  })
})
