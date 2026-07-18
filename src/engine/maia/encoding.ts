// Board → Maia-1 / Lc0 input tensor (112 planes × 8×8 = 7168 floats).
//
// Part of the GPL-licensed Maia adapter (derived from the Lc0 input spec), kept
// arm's-length behind the MaiaOpponent port. Pure: no engine/IO/React. See
// public/models/NOTICE.md.
//
// Plane layout (INPUT_CLASSICAL_112_PLANE), always from the side-to-move's view:
//   0..103  : 8 history frames × 13 planes, most-recent-first. Each frame =
//             6 own-piece planes (P N B R Q K) + 6 opponent-piece planes + 1 repetition.
//   104     : our queenside castling      105 : our kingside castling
//   106     : opp queenside castling      107 : opp kingside castling
//   108     : side-to-move (1 if black)   109 : rule50 / 99 (capped 1)
//   110     : all zeros (legacy)          111 : all ones
// For black to move: ranks are mirrored (r → 7−r) and own/opp piece sets swap.
//
// SPIKE NOTE: Maia was trained with real move history. When only a FEN is given we
// repeat the current position across all 8 frames (repetition planes left 0). This is
// the documented single-position fallback; fidelity vs. true history is a v0.2 follow-up.

import { Chess } from 'chess.js'

export const PLANES = 112
export const PLANE_SIZE = 64
export const INPUT_SIZE = PLANES * PLANE_SIZE // 7168
export const INPUT_SHAPE = [1, 112, 8, 8] as const

const PIECE_ORDER = ['p', 'n', 'b', 'r', 'q', 'k'] as const // chess.js piece types

function fillPlane(data: Float32Array, plane: number, value: number): void {
  if (value === 0) return
  const base = plane * PLANE_SIZE
  for (let i = 0; i < PLANE_SIZE; i++) data[base + i] = value
}

/** Write the 12 piece planes of one history frame starting at `planeBase`. */
function fillPieceFrame(data: Float32Array, planeBase: number, fen: string, blackToMove: boolean): void {
  const board = new Chess(fen).board() // board[0] = rank 8, col 0 = file a
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const piece = board[row]?.[col]
      if (!piece) continue
      const rankFromWhite = 7 - row // 0 = rank 1
      const rankIdx = blackToMove ? 7 - rankFromWhite : rankFromWhite
      const square = rankIdx * 8 + col
      const isOwn = blackToMove ? piece.color === 'b' : piece.color === 'w'
      const typeIdx = PIECE_ORDER.indexOf(piece.type)
      const plane = planeBase + (isOwn ? 0 : 6) + typeIdx
      data[plane * PLANE_SIZE + square] = 1
    }
  }
}

/**
 * Encode a FEN (optionally with prior positions, most-recent-first) into the
 * 7168-float Lc0 input tensor for Maia-1.
 */
export function encodeFen(fen: string, historyFens: readonly string[] = []): Float32Array {
  const data = new Float32Array(INPUT_SIZE)
  const parts = fen.split(' ')
  const blackToMove = parts[1] === 'b'
  const castling = parts[2] ?? '-'
  const rule50 = Number.parseInt(parts[4] ?? '0', 10) || 0

  const frames = [fen, ...historyFens].slice(0, 8)
  while (frames.length < 8) frames.push(frames[frames.length - 1] ?? fen)
  for (let f = 0; f < 8; f++) fillPieceFrame(data, f * 13, frames[f] ?? fen, blackToMove)

  const ourK = blackToMove ? castling.includes('k') : castling.includes('K')
  const ourQ = blackToMove ? castling.includes('q') : castling.includes('Q')
  const oppK = blackToMove ? castling.includes('K') : castling.includes('k')
  const oppQ = blackToMove ? castling.includes('Q') : castling.includes('q')
  fillPlane(data, 104, ourQ ? 1 : 0)
  fillPlane(data, 105, ourK ? 1 : 0)
  fillPlane(data, 106, oppQ ? 1 : 0)
  fillPlane(data, 107, oppK ? 1 : 0)
  fillPlane(data, 108, blackToMove ? 1 : 0)
  fillPlane(data, 109, Math.min(rule50 / 99, 1))
  // 110 stays zero
  fillPlane(data, 111, 1)
  return data
}
