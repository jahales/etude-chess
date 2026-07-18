import type { Color, Score } from './types'

// Lichess's win-percentage model. Grading by *win-percent swing* (not raw
// centipawns) is the load-bearing choice from docs/decisions/0010: a fixed
// centipawn loss means very different things in a balanced vs. decided position.
// See docs/research/engines.md §A3.
const CP_CLAMP = 1000
const LICHESS_K = 0.00368208

/** Win% (0–100) for a centipawn score, from the mover's perspective. */
export function winPercentFromCp(cp: number): number {
  const c = Math.max(-CP_CLAMP, Math.min(CP_CLAMP, cp))
  return 50 + 50 * (2 / (1 + Math.exp(-LICHESS_K * c)) - 1)
}

/**
 * Win% (0–100) for any score. A mate for the side to move is ~certainty (100);
 * being mated (or a negative mate distance) is ~0. We use hard 100/0 for mate so
 * that missing a forced mate produces a clean, large swing.
 */
export function winPercent(score: Score): number {
  if (score.type === 'mate') return score.value > 0 ? 100 : 0
  return winPercentFromCp(score.value)
}

/** White's win% (0–100) for a score given whose turn it is — drives the eval bar. */
export function whiteWinPercent(score: Score, sideToMove: Color): number {
  const stm = winPercent(score)
  return sideToMove === 'w' ? stm : 100 - stm
}

/** Flip a score to the opponent's perspective (used to normalise both sides of a move). */
export function negate(score: Score): Score {
  return score.type === 'cp'
    ? { type: 'cp', value: -score.value }
    : { type: 'mate', value: -score.value }
}
