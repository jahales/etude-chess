import { Chess } from 'chess.js'
import type { Color, Score } from './types'
import { negate } from './winPercent'

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
