import { describe, expect, it } from 'vitest'
import { diagnoseMistake, netCaptureGain } from './mistakeKind'

// Sparse positions, so the exchange on each square can be checked by hand.
const QUEEN_VS_ROOK = '4k3/8/8/3r4/8/8/8/3Q1K2 w - - 0 1' // Qd1, Kf1 · rd5, ke8
const AFTER_1_E4_D5 = 'rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 2'
const BARE_ROOK = '4k3/8/8/8/8/8/8/4K2R w K - 0 1'

describe('what a move actually nets in material', () => {
  it('gives the full value of a capture nothing can answer', () => {
    // Black's rook takes the queen on d1; the king on f1 is two squares away.
    expect(netCaptureGain('4k3/8/8/3r4/8/8/8/3Q1K2 b - - 0 1', 'Rxd1+')).toBe(9)
  })

  it('nets a recapture out, so an even trade is worth nothing', () => {
    // exd5 wins a pawn and Qxd5 takes it straight back.
    expect(netCaptureGain(AFTER_1_E4_D5, 'exd5')).toBe(0)
  })

  it('goes negative when the capture loses material outright', () => {
    // The queen takes a defended pawn and is lost for it.
    expect(netCaptureGain('4k3/3p4/4p3/8/8/8/8/3QK3 w - - 0 1', 'Qxd7+')).toBeLessThan(0)
  })

  it('is zero for a move that captures nothing', () => {
    expect(netCaptureGain(BARE_ROOK, 'Rh8+')).toBe(0)
  })

  it('reports null for a move that is not legal here', () => {
    // Never throw mid-review over one bad SAN.
    expect(netCaptureGain(BARE_ROOK, 'Qxf7')).toBeNull()
  })
})

describe('classifying why a move was a mistake', () => {
  it('names material left en prise', () => {
    // Qd4?? walks in front of the rook on d5, undefended.
    const d = diagnoseMistake(QUEEN_VS_ROOK, 'Qd4', 'Qd2')
    expect(d.kind).toBe('hung-material')
    expect(d.hangs).toBe(9)
    expect(d.squares).toEqual(['d4'])
  })

  it('does not call an even trade a hung piece', () => {
    // The recapture is the other half of a trade the player chose. This is the
    // exact case hangingAfterMove was written for; without it, 2.exd5 in the
    // Scandinavian reads as hanging a pawn.
    expect(diagnoseMistake(AFTER_1_E4_D5, 'exd5', 'exd5').kind).toBe('positional')
  })

  it('names material the engine would have won and this move passed up', () => {
    const d = diagnoseMistake('4k3/8/8/3r4/8/8/8/3Q1K2 b - - 0 1', 'Ra5', 'Rxd1+')
    expect(d.kind).toBe('missed-material')
    expect(d.missed).toBe(9)
    expect(d.squares).toEqual(['d1'])
  })

  it('does not claim missed material when the move took as much as the best one', () => {
    // Both capture the same pawn; the mistake is elsewhere and saying otherwise
    // would send the owner hunting for a tactic that is not there.
    const d = diagnoseMistake(AFTER_1_E4_D5, 'exd5', 'Nc3')
    expect(d.kind).toBe('positional')
    expect(d.missed).toBe(0)
  })

  it('falls back to positional when no material changes hands either way', () => {
    const d = diagnoseMistake(BARE_ROOK, 'Kd1', 'Rh8+')
    expect(d).toEqual({ kind: 'positional', hangs: 0, missed: 0, squares: [] })
  })

  it('prefers the hung piece when a move both hangs and misses', () => {
    // Losing your own queen is the thing to say first.
    const d = diagnoseMistake(QUEEN_VS_ROOK, 'Qd4', 'Qxd5')
    expect(d.kind).toBe('hung-material')
  })

  it('survives a SAN it cannot play rather than throwing', () => {
    expect(diagnoseMistake(BARE_ROOK, 'Qxf7', 'Rh8+').kind).toBe('positional')
    expect(diagnoseMistake(BARE_ROOK, 'Kd1', 'Qxf7').kind).toBe('positional')
  })
})
