import { describe, it, expect } from 'vitest'
import { Chess } from 'chess.js'
import { seeCaptureGain } from './see'

describe('seeCaptureGain', () => {
  it('is 0 for a piece that is not attacked', () => {
    expect(seeCaptureGain(new Chess(), 'e1')).toBe(0) // white king, start position
    expect(seeCaptureGain(new Chess(), 'd2')).toBe(0) // a defended, unattacked pawn
  })

  it('wins the full value of an undefended piece', () => {
    // White queen on d5, attacked only by the black e6 pawn, no defenders.
    const c = new Chess('rnbqkbnr/pppp1ppp/4p3/3Q4/8/8/PPPP1PPP/RNB1KBNR b KQkq - 0 1')
    expect(seeCaptureGain(c, 'd5')).toBe(9)
  })

  it('nets the exchange when the piece is defended (PxN, NxP style)', () => {
    // White knight d5 attacked by black e6 pawn, defended by the white c4 pawn.
    // Black wins knight (3) but loses the capturing pawn (1) → net +2.
    const c = new Chess('rnbqkbnr/pppp1ppp/4p3/3N4/2P5/8/PP1P1PPP/RNBQKB1R b KQkq - 0 1')
    expect(seeCaptureGain(c, 'd5')).toBe(2)
  })

  it("is 0 when only an over-valuable attacker exists (a rook won't take a defended knight)", () => {
    // White knight d5 defended by the white c4 pawn; the only black attacker is the d8 rook.
    const c = new Chess('3r4/8/8/3N4/2P5/8/8/4K2k b - - 0 1')
    expect(seeCaptureGain(c, 'd5')).toBe(0)
  })
})
