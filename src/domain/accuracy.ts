import { Chess } from 'chess.js'

// Per-game accuracy for play-vs-Maia (ADR 0017). Grounded in the same win%-swing the
// coach grades on — a measure of *this game's* move quality, not a skill rating or a
// claim of transfer (constitution §9, §12). The per-move formula is Lichess's accuracy
// model; the game figure is a plain mean of those (not Lichess's volatility-weighted /
// harmonic blend), so it will differ somewhat from Lichess/chess.com for the same game.

export type Phase = 'opening' | 'middlegame' | 'endgame'

/**
 * Accuracy (0–100) for a single move, from the win% it gave up (`grade.swing`).
 * Lichess's model: 103.1668·e^(−0.04354·loss) − 3.1669, clamped. 0 loss → 100%.
 */
export function moveAccuracy(winPercentLost: number): number {
  const a = 103.1668 * Math.exp(-0.04354 * Math.max(0, winPercentLost)) - 3.1669
  return Math.max(0, Math.min(100, a))
}

/** Mean accuracy over a set of moves (empty → 100). */
export function meanAccuracy(swings: readonly number[]): number {
  if (swings.length === 0) return 100
  return swings.reduce((sum, s) => sum + moveAccuracy(s), 0) / swings.length
}

/**
 * Rough game phase for a position — a heuristic, deliberately approximate:
 * endgame once few officers remain, opening for the first ten moves, else middlegame.
 */
export function phaseOf(fen: string): Phase {
  let officers = 0 // non-king, non-pawn pieces
  for (const row of new Chess(fen).board()) {
    for (const sq of row) if (sq && sq.type !== 'k' && sq.type !== 'p') officers += 1
  }
  if (officers <= 6) return 'endgame'
  const fullmove = Number(fen.split(' ')[5] ?? '1') || 1
  return fullmove <= 10 ? 'opening' : 'middlegame'
}

export interface PhaseStat {
  moves: number
  accuracy: number
}

/** Accuracy + move count per phase, for the post-game review. */
export function byPhase(attempts: readonly { fen: string; swing: number }[]): Record<Phase, PhaseStat> {
  const groups: Record<Phase, number[]> = { opening: [], middlegame: [], endgame: [] }
  for (const a of attempts) groups[phaseOf(a.fen)].push(a.swing)
  const stat = (swings: number[]): PhaseStat => ({ moves: swings.length, accuracy: meanAccuracy(swings) })
  return { opening: stat(groups.opening), middlegame: stat(groups.middlegame), endgame: stat(groups.endgame) }
}
