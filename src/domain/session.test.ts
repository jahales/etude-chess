import { describe, it, expect } from 'vitest'
import { summarize, type Attempt } from './session'
import type { Tier } from './types'

let seq = 0
function attempt(tier: Tier, swing: number): Attempt {
  seq += 1
  return {
    itemIndex: seq,
    moveNumber: seq,
    sideToMove: 'w',
    fen: 'x',
    userMoveSan: 'e4',
    masterMoveSan: 'e4',
    reason: '',
    tier,
    swing,
  }
}

describe('summarize', () => {
  it('handles an empty session without dividing by zero', () => {
    const s = summarize([])
    expect(s.total).toBe(0)
    expect(s.aRate).toBe(0)
    expect(s.averageSwing).toBe(0)
    expect(s.biggestMisses).toEqual([])
  })

  it('counts tiers, A-rate, and average swing', () => {
    const s = summarize([attempt('A', 0), attempt('A', 2), attempt('B', 10), attempt('C', 40)])
    expect(s.tierCounts).toEqual({ A: 2, B: 1, C: 1 })
    expect(s.aRate).toBe(0.5)
    expect(s.averageSwing).toBeCloseTo((0 + 2 + 10 + 40) / 4, 6)
  })

  it('lists the biggest non-A misses worst-first, capped', () => {
    const s = summarize(
      [attempt('A', 1), attempt('C', 50), attempt('B', 12), attempt('C', 30)],
      2,
    )
    expect(s.biggestMisses.map((m) => m.swing)).toEqual([50, 30])
    expect(s.biggestMisses.every((m) => m.tier !== 'A')).toBe(true)
  })
})
