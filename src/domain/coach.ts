import { Chess } from 'chess.js'
import type { Color, Tier } from './types'
import type { MoveGrade } from './grade'
import { findHangingPieces, uciToSan, PIECE_NAME, type HangingPiece } from './factBundle'

// The in-game coach's verdict on one of *your* moves (ADR 0017). Like the fact
// bundle, but engine-based (there is no master move in a live game vs Maia): it
// compares your move to Stockfish's best and to what it leaves hanging. Pure.

export interface CoachVerdict {
  tier: Tier
  swing: number
  /** Short verdict, e.g. "Good move." / "Slightly inaccurate." / "Mistake." */
  headline: string
  /** Engine-based "why", or '' when there's nothing to add (a clean best move). */
  detail: string
  /** Stockfish's preferred move in SAN, if known. */
  bestMoveSan: string | null
  /** Your pieces left hanging after the move (heuristic, SEE). */
  hanging: HangingPiece[]
}

const HEADLINE: Record<Tier, string> = {
  A: 'Good move.',
  B: 'Slightly inaccurate.',
  C: 'Mistake.',
}

export interface CoachInput {
  /** Position you moved from. */
  fen: string
  /** Your move (SAN), already legal. */
  userMoveSan: string
  grade: MoveGrade
  /** Stockfish's best move (UCI/LAN), or null. */
  bestMoveUci: string | null
}

export function coachVerdict(input: CoachInput): CoachVerdict {
  const chess = new Chess(input.fen)
  const mover = chess.turn() as Color
  const applied = chess.move(input.userMoveSan) // legal by contract
  const hanging = findHangingPieces(chess, mover)
  const bestMoveSan = input.bestMoveUci ? uciToSan(input.fen, input.bestMoveUci) : null
  const matchedBest = !!bestMoveSan && bestMoveSan === applied.san

  const parts: string[] = []
  if (input.grade.tier === 'A') {
    if (matchedBest) parts.push("That's the engine's top choice.")
  } else {
    const h = hanging[0]
    if (h) {
      const name = PIECE_NAME[h.piece] ?? 'piece'
      parts.push(`It leaves your ${name} on ${h.square} hanging (about ${h.loss} point${h.loss === 1 ? '' : 's'}).`)
    }
    if (bestMoveSan) parts.push(`The engine prefers ${bestMoveSan}.`)
    parts.push(`That's about ${Math.round(input.grade.swing)}% of your winning chances.`)
  }

  return {
    tier: input.grade.tier,
    swing: input.grade.swing,
    headline: HEADLINE[input.grade.tier],
    detail: parts.join(' '),
    bestMoveSan,
    hanging,
  }
}
