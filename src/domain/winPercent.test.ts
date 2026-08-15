import { describe, it, expect } from 'vitest'
import {
  winPercent,
  winPercentFromCp,
  whiteWinPercent,
  negate,
  swingFromWhitePercent,
} from './winPercent'

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

describe('swingFromWhitePercent', () => {
  it('is what White gave up when White moved', () => {
    expect(swingFromWhitePercent(70, 45, 'w')).toBe(25)
  })

  it('is what Black gave up when Black moved — the same drop, mirrored', () => {
    // White's win% *rising* is Black losing ground.
    expect(swingFromWhitePercent(45, 70, 'b')).toBe(25)
  })

  it('is negative for a move that gained ground, rather than clamped here', () => {
    // Whether a gain counts as 0 or as a gain is the caller's decision:
    // accuracy clamps it, a ranking of mistakes just sorts it to the bottom.
    expect(swingFromWhitePercent(45, 70, 'w')).toBe(-25)
  })

  it('is 0 across a move that changed nothing', () => {
    expect(swingFromWhitePercent(52, 52, 'w')).toBe(0)
    expect(swingFromWhitePercent(52, 52, 'b')).toBe(0)
  })

  it('bounds a swing into mate at 100, because the inputs are already win%', () => {
    // A mate reaches here as 100/0 (see `winPercent`), so the worst move in
    // chess costs 100 points and not the 32000-odd of a raw mate score.
    expect(swingFromWhitePercent(100, 0, 'w')).toBe(100)
    expect(swingFromWhitePercent(0, 100, 'b')).toBe(100)
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
