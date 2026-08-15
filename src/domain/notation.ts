import { Chess } from 'chess.js'
import type { Color, Score } from './types'
import { negate } from './winPercent.ts'

/** Render a UCI principal variation as SAN moves, from the given position. */
export function pvToSan(fen: string, pv: string[], maxPlies = 6): string[] {
  const chess = new Chess(fen)
  const out: string[] = []
  for (const uci of pv.slice(0, maxPlies)) {
    try {
      const mv = chess.move({
        from: uci.slice(0, 2),
        to: uci.slice(2, 4),
        promotion: uci.length > 4 ? uci[4] : undefined,
      })
      out.push(mv.san)
    } catch {
      break
    }
  }
  return out
}

/**
 * The line that starts with the move *you* played: your move, then the engine's
 * answer to it (#151).
 *
 * One line and not two halves, because that is what makes it walkable — the
 * exploration reducer replays SAN from a single root position, so the played
 * move has to be the first move of the line rather than a caption on it. It
 * roots at the same FEN the engine's ranked lines do, which is what lets one
 * click move between them.
 *
 * `continuation` is UCI **from the position after your move** (`GradedMove.afterPv`).
 * An empty result means the move itself would not replay — a caller's cue that
 * there is nothing to show, rather than a claim that the game ends here.
 */
export function playedLineToSan(
  fen: string,
  playedSan: string,
  continuation: readonly string[],
  maxPlies = 6,
): string[] {
  const chess = new Chess(fen)
  let played
  try {
    played = chess.move(playedSan)
  } catch {
    return []
  }
  // Your move spends one of the plies, so the line is the same length as an
  // engine line beside it and the two stay comparable at a glance.
  return [played.san, ...pvToSan(chess.fen(), [...continuation], Math.max(0, maxPlies - 1))]
}

/** Display a score from the side-to-move's perspective, e.g. "+1.24", "-0.30", "M3", "-M2". */
export function formatScore(score: Score): string {
  if (score.type === 'mate') {
    if (score.value === 0) return '#'
    return score.value > 0 ? `M${score.value}` : `−M${Math.abs(score.value)}`
  }
  const pawns = score.value / 100
  return `${pawns >= 0 ? '+' : '−'}${Math.abs(pawns).toFixed(2)}`
}

/** Score label from White's perspective (+ = White better), e.g. "+0.80", "−1.20", "M3". */
export function whiteScoreLabel(score: Score, sideToMove: Color): string {
  return formatScore(sideToMove === 'w' ? score : negate(score))
}
