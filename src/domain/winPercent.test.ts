import { describe, it, expect } from 'vitest'
import { winPercent, winPercentFromCp, whiteWinPercent, negate } from './winPercent'

describe('winPercentFromCp', () => {
  it('is 50% at a dead-equal position', () => {
    expect(winPercentFromCp(0)).toBeCloseTo(50, 6)
  })

  it('is symmetric around 50% (a position is zero-sum)', () => {
    for (const cp of [37, 150, 640, 1000, 5000]) {
      expect(winPercentFromCp(cp) + winPercentFromCp(-cp)).toBeCloseTo(100, 6)
    }
  })

  it('increases monotonically with the score', () => {
    expect(winPercentFromCp(0)).toBeLessThan(winPercentFromCp(50))
    expect(winPercentFromCp(50)).toBeLessThan(winPercentFromCp(300))
    expect(winPercentFromCp(300)).toBeLessThan(winPercentFromCp(900))
  })

  it('clamps extreme scores (a +2000 and +1000 read the same)', () => {
    expect(winPercentFromCp(2000)).toBeCloseTo(winPercentFromCp(1000), 6)
  })

  it('stays within [0, 100]', () => {
    for (const cp of [-99999, -500, 0, 500, 99999]) {
      const w = winPercentFromCp(cp)
      expect(w).toBeGreaterThanOrEqual(0)
      expect(w).toBeLessThanOrEqual(100)
    }
  })
})

describe('winPercent (Score)', () => {
  it('treats a mate for the mover as certainty', () => {
    expect(winPercent({ type: 'mate', value: 3 })).toBe(100)
    expect(winPercent({ type: 'mate', value: 1 })).toBe(100)
  })

  it('treats being mated as a loss', () => {
    expect(winPercent({ type: 'mate', value: -2 })).toBe(0)
    expect(winPercent({ type: 'mate', value: 0 })).toBe(0)
  })

  it('delegates cp scores to the centipawn model', () => {
    expect(winPercent({ type: 'cp', value: 0 })).toBeCloseTo(50, 6)
  })
})

describe('whiteWinPercent', () => {
  it('passes the score straight through when White is to move', () => {
    expect(whiteWinPercent({ type: 'cp', value: 200 }, 'w')).toBeCloseTo(
      winPercentFromCp(200),
      6,
    )
  })
  it('flips to White\'s side when Black is to move', () => {
    // +200 for Black-to-move means White is worse: White% = 100 − Black%.
    expect(whiteWinPercent({ type: 'cp', value: 200 }, 'b')).toBeCloseTo(
      100 - winPercentFromCp(200),
      6,
    )
  })
  it('reads a mate for Black-to-move as 0% for White', () => {
    expect(whiteWinPercent({ type: 'mate', value: 1 }, 'b')).toBe(0)
  })
})

describe('negate', () => {
  it('flips cp scores', () => {
    expect(negate({ type: 'cp', value: 120 })).toEqual({ type: 'cp', value: -120 })
  })
  it('flips mate distance/sign', () => {
    expect(negate({ type: 'mate', value: 4 })).toEqual({ type: 'mate', value: -4 })
  })
})
