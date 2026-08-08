import { Chess } from 'chess.js'
import type { Color } from './types'
// Extensions deliberate — see the note in grade.ts. The review script loads this
// under Node's type stripping.
import { hangingAfterMove } from './factBundle.ts'
import { seeCaptureGain } from './see.ts'

// *Why* a move was a mistake, not just how much it cost.
//
// The engine's number says a move was worse. It does not say whether the player
// hung a piece, walked past material the engine's move would have won, or simply
// chose the worse plan — and those are three different things to work on. SEE
// answers the material half statically, which is all that is wanted: the search
// already knows the evaluation, so this exists purely to *explain* it.
//
// SEE's limits are real (no x-rays, no pinned defenders — see see.ts), so this
// is only ever a label on a finding the engine already made, never a finding of
// its own.

export type MistakeKind =
  /** The move left the player's own material en prise. */
  | 'hung-material'
  /** The engine's move wins material this one passed up. */
  | 'missed-material'
  /** No material changed hands either way — the move was simply worse. */
  | 'positional'

export interface MistakeDiagnosis {
  kind: MistakeKind
  /** Material left en prise by the played move, in pawns; 0 when none. */
  hangs: number
  /** Material the engine's move wins beyond what the played one did, in pawns; 0 when none. */
  missed: number
  /** The squares involved, for naming them in a sentence. */
  squares: string[]
}

const PIECE_VALUE: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 }

/**
 * What a move nets in material: what it captures, less what the opponent wins
 * back on that square. A capture that walks into a recapture nets nothing, which
 * is the whole reason this is not just "did it take something".
 *
 * Returns null when the move is not legal in the position.
 */
export function netCaptureGain(fen: string, san: string): number | null {
  const board = new Chess(fen)
  let move
  try {
    move = board.move(san)
  } catch {
    return null
  }
  if (!move.captured) return 0
  // `board` is now the position *after* the move, so this is the recapture.
  return (PIECE_VALUE[move.captured] ?? 0) - seeCaptureGain(board, move.to)
}

/**
 * Classify a move the engine has already judged a mistake.
 *
 * Falls back to `positional` — the commonest answer, and the honest one — when
 * neither material test finds anything, and when the SAN cannot be played.
 */
export function diagnoseMistake(
  fen: string,
  playedSan: string,
  bestSan: string | null,
): MistakeDiagnosis {
  const none: MistakeDiagnosis = { kind: 'positional', hangs: 0, missed: 0, squares: [] }

  const board = new Chess(fen)
  const mover = board.turn() as Color
  let applied
  try {
    applied = board.move(playedSan)
  } catch {
    return none
  }

  // What the move left en prise, net of what it captured — hangingAfterMove
  // already subtracts that, so an even trade does not read as a blunder.
  const hanging = hangingAfterMove(board, mover, applied)
  const hangs = hanging.reduce((total, h) => total + h.loss, 0)
  if (hangs > 0) {
    return { kind: 'hung-material', hangs, missed: 0, squares: hanging.map((h) => h.square) }
  }

  // Nothing hung. Did the engine's move win material this one did not?
  // Comparing against the engine's actual choice, rather than against every
  // capture on the board, keeps this tied to the mistake being explained.
  if (bestSan && bestSan !== playedSan) {
    const best = netCaptureGain(fen, bestSan)
    const played = netCaptureGain(fen, playedSan)
    if (best !== null && played !== null && best - played > 0) {
      const target = new Chess(fen)
      const bestMove = target.move(bestSan)
      return {
        kind: 'missed-material',
        hangs: 0,
        missed: best - played,
        squares: [bestMove.to],
      }
    }
  }

  return none
}
