import { describe, it, expect } from 'vitest'
import {
  gradeMove,
  tierForSwing,
  TIER_A_MAX_SWING,
  TIER_B_MAX_SWING,
} from './grade'
import type { Score } from './types'

const cp = (value: number): Score => ({ type: 'cp', value })

describe('tierForSwing', () => {
  it('gives Tier A up to and including the A boundary', () => {
    expect(tierForSwing(0)).toBe('A')
    expect(tierForSwing(TIER_A_MAX_SWING)).toBe('A')
  })
  it('gives Tier B just past A, up to the B boundary', () => {
    expect(tierForSwing(TIER_A_MAX_SWING + 0.01)).toBe('B')
    expect(tierForSwing(TIER_B_MAX_SWING)).toBe('B')
  })
  it('gives Tier C past the B boundary', () => {
    expect(tierForSwing(TIER_B_MAX_SWING + 0.01)).toBe('C')
    expect(tierForSwing(80)).toBe('C')
  })
})

describe('gradeMove', () => {
  it('gives full credit (A, swing 0) to the engine-best move', () => {
    const g = gradeMove(cp(40), cp(40))
    expect(g.swing).toBe(0)
    expect(g.tier).toBe('A')
  })

  it('gives full credit to an engine-equal alternative (the master-match fix)', () => {
    // Master/best read +0.40; the user chose a different move worth +0.36 — same tier.
    const g = gradeMove(cp(40), cp(36))
    expect(g.tier).toBe('A')
  })

  it('never reports a negative swing when the played move looks better than best', () => {
    const g = gradeMove(cp(30), cp(45)) // search noise: played eval slightly higher
    expect(g.swing).toBe(0)
    expect(g.tier).toBe('A')
  })

  it('flags a clear blunder as Tier C', () => {
    // From winning (+300, ~79%) to losing (-300, ~21%): ~58-point swing.
    const g = gradeMove(cp(300), cp(-300))
    expect(g.tier).toBe('C')
    expect(g.swing).toBeGreaterThan(40)
  })

  it('flags a quiet concession as Tier B', () => {
    // +20 (~52.7%) down to -260 (~22.9%): ~30-point swing → wait, tune below.
    const g = gradeMove(cp(20), cp(-90))
    expect(['B', 'C']).toContain(g.tier)
    expect(g.tier).not.toBe('A')
  })

  it('treats missing a forced mate as a large swing', () => {
    const g = gradeMove({ type: 'mate', value: 2 }, cp(50))
    expect(g.bestWinPercent).toBe(100)
    expect(g.swing).toBeGreaterThan(40)
    expect(g.tier).toBe('C')
  })
})
