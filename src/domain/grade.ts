import type { Score, Tier } from './types'
import { winPercent } from './winPercent'

// Tier boundaries in win-percentage points. Tuned so an engine-equal alternative
// earns full credit (Tier A) — the pillar that separates us from "match the
// master" graders (docs/decisions/0004-tier-not-rank, 0014-v0.1.0-guess-the-move).
export const TIER_A_MAX_SWING = 5 // "as good as best" — full credit
export const TIER_B_MAX_SWING = 15 // "a real concession"
// > TIER_B_MAX_SWING => Tier C, "a mistake or blunder"

export function tierForSwing(swing: number): Tier {
  if (swing <= TIER_A_MAX_SWING) return 'A'
  if (swing <= TIER_B_MAX_SWING) return 'B'
  return 'C'
}

export interface MoveGrade {
  bestWinPercent: number
  playedWinPercent: number
  /** Win% given up vs. the best move; never negative. */
  swing: number
  tier: Tier
}

/**
 * Grade a played move. Both evaluations must already be expressed from the
 * *mover's* perspective (the engine adapter negates the post-move eval before
 * calling this — see engine/grading.ts). A move as good as (or better than) the
 * engine's best is Tier A.
 */
export function gradeMove(bestEval: Score, playedEval: Score): MoveGrade {
  const bestWinPercent = winPercent(bestEval)
  const playedWinPercent = winPercent(playedEval)
  const swing = Math.max(0, bestWinPercent - playedWinPercent)
  return { bestWinPercent, playedWinPercent, swing, tier: tierForSwing(swing) }
}
