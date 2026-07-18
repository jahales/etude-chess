import { describe, it, expect } from 'vitest'
import { Chess } from 'chess.js'
import { pvToSan, formatScore } from './notation'

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
