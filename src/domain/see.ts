import { Chess, type Square } from 'chess.js'
import type { Color } from './types'

// Static Exchange Evaluation (SEE) on a square: the material the side NOT owning
// the piece can win by initiating captures, assuming each side always recaptures
// with its least valuable attacker. This is *value-ordered* — the real fix for
// the earlier attacker/defender-count heuristic (docs/decisions/0012, issue #7).
//
// Recursive form: capture value − (best the opponent can do back), floored at 0
// (a side won't enter a losing exchange).
//
// Known limitations (chess.js can't cheaply express them): ignores x-ray/battery
// attackers and pinned defenders. Much better than counting; not engine-exact.

const SEE_VALUE: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 1000 }

function seeRec(target: number, myVals: number[], oppVals: number[]): number {
  if (myVals.length === 0) return 0
  return Math.max(0, target - seeRec(myVals[0]!, oppVals, myVals.slice(1)))
}

function attackerValues(chess: Chess, square: string, color: Color): number[] {
  return chess
    .attackers(square as Square, color)
    .map((s) => SEE_VALUE[chess.get(s)!.type] ?? 0)
    .sort((a, b) => a - b)
}

/**
 * Material the opponent of the piece on `square` can win by capturing it, per SEE.
 * 0 if the piece is safe (unattacked, or defended well enough that capturing loses).
 */
export function seeCaptureGain(chess: Chess, square: string): number {
  const piece = chess.get(square as Square)
  if (!piece) return 0
  const opp: Color = piece.color === 'w' ? 'b' : 'w'
  const oppVals = attackerValues(chess, square, opp)
  if (oppVals.length === 0) return 0
  const ownVals = attackerValues(chess, square, piece.color)
  return seeRec(SEE_VALUE[piece.type] ?? 0, oppVals, ownVals)
}
