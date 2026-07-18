import type { Color, Tier } from './types'

// A single committed guess and its grade, plus the pure logic that turns a
// session's attempts into an honest summary (no speed metric — constitution §9).

export interface Attempt {
  itemIndex: number
  moveNumber: number
  sideToMove: Color
  fen: string
  userMoveSan: string
  masterMoveSan: string
  reason: string
  tier: Tier
  swing: number
}

export interface SessionSummary {
  total: number
  tierCounts: Record<Tier, number>
  /** Fraction of moves graded Tier A (as good as best), 0–1. */
  aRate: number
  /** Mean win% given up across all moves. */
  averageSwing: number
  /** The costliest non-A moves, worst first (up to `limit`). */
  biggestMisses: Attempt[]
}

export function summarize(attempts: Attempt[], missLimit = 3): SessionSummary {
  const tierCounts: Record<Tier, number> = { A: 0, B: 0, C: 0 }
  let swingTotal = 0
  for (const a of attempts) {
    tierCounts[a.tier] += 1
    swingTotal += a.swing
  }
  const total = attempts.length
  const biggestMisses = attempts
    .filter((a) => a.tier !== 'A')
    .sort((x, y) => y.swing - x.swing)
    .slice(0, missLimit)
  return {
    total,
    tierCounts,
    aRate: total === 0 ? 0 : tierCounts.A / total,
    averageSwing: total === 0 ? 0 : swingTotal / total,
    biggestMisses,
  }
}
