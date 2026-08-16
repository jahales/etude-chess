import { describe, it, expect } from 'vitest'
import { Chess } from 'chess.js'
import { pvToSan, formatScore, playedLineToSan, whiteScoreLabel } from './notation'

describe('pvToSan', () => {
  it('renders a UCI line as SAN from the position', () => {
    expect(pvToSan(new Chess().fen(), ['e2e4', 'e7e5', 'g1f3'])).toEqual(['e4', 'e5', 'Nf3'])
  })
  it('caps the number of plies', () => {
    expect(pvToSan(new Chess().fen(), ['e2e4', 'e7e5', 'g1f3', 'b8c6'], 2)).toEqual(['e4', 'e5'])
  })
  it('stops cleanly if a move is illegal', () => {
    expect(pvToSan(new Chess().fen(), ['e2e4', 'e2e4'])).toEqual(['e4'])
  })
})

describe('playedLineToSan (#151)', () => {
  const START = new Chess().fen()

  it('puts your move at the head of the line, then the engine answer', () => {
    // 1.a3 played; the engine's reply and continuation come from *after* it.
    expect(playedLineToSan(START, 'a3', ['e7e5', 'e2e4', 'g8f6'])).toEqual(['a3', 'e5', 'e4', 'Nf6'])
  })

  it('counts your move against the ply cap, so it is as long as an engine line', () => {
    expect(playedLineToSan(START, 'a3', ['e7e5', 'e2e4', 'g8f6'], 2)).toEqual(['a3', 'e5'])
  })

  it('is just your move when the position after it is terminal', () => {
    expect(playedLineToSan(START, 'a3', [])).toEqual(['a3'])
  })

  it('is empty when the move does not replay, rather than throwing in a render', () => {
    expect(playedLineToSan(START, 'Qxh7', ['e7e5'])).toEqual([])
  })

  it('renders the continuation against the position your move left', () => {
    // e7e5 is only legal *after* White has moved; rendering it from the root
    // would drop it, which is the bug this pins.
    expect(playedLineToSan(START, 'e4', ['e7e5'])).toEqual(['e4', 'e5'])
  })
})

describe('the played move keeps White-perspective scores (#151)', () => {
  // The score the engine hands back for a played move is normalised to the
  // *mover*; the UI states everything from White. With Black to move those are
  // opposite signs, which is the whole trap.
  it('reads as-is for White and flips for Black', () => {
    expect(whiteScoreLabel({ type: 'cp', value: 31 }, 'w')).toBe('+0.31')
    expect(whiteScoreLabel({ type: 'cp', value: 31 }, 'b')).toBe('−0.31')
  })
})

describe('formatScore', () => {
  it('formats centipawns with sign and two decimals', () => {
    expect(formatScore({ type: 'cp', value: 124 })).toBe('+1.24')
    expect(formatScore({ type: 'cp', value: -30 })).toBe('−0.30')
    expect(formatScore({ type: 'cp', value: 0 })).toBe('+0.00')
  })
  it('formats mate distances', () => {
    expect(formatScore({ type: 'mate', value: 3 })).toBe('M3')
    expect(formatScore({ type: 'mate', value: -2 })).toBe('−M2') // U+2212, matches cp negatives
    expect(formatScore({ type: 'mate', value: 0 })).toBe('#')
  })
})
