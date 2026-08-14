// Keys and record packing for the local Lichess evaluation index.
//
// Pure functions only — the IO lives in buildEvalIndex.mjs and evalDb.mjs. Two
// conventions in here were *measured against the dump*, not assumed, because
// getting either wrong produces a plausible-looking result rather than an error:
// a sign flip silently inverts every soundness verdict, and a key mismatch reads
// as "the position is not in the database" when in fact it is.
//
// ## 1. Scores are from WHITE's point of view
//
// `database.lichess.org` does not document this, and issue #106 assumed the
// opposite ("both scores come from the side to move, so they subtract directly
// with no negation"). Measured over the first 400,082 positions of the dump,
// restricted to Black-to-move positions where material is lopsided:
//
//     White up >= 3 pawns, Black to move   n=14788   mean cp  +857
//     Black up >= 3 pawns, Black to move   n= 5556   mean cp  -356
//
// Under a side-to-move convention the first row would be strongly *negative*.
// It is strongly positive, and the sign tracks White's material rather than the
// mover's, so the dump is White-relative. We store it exactly as the source
// gives it — the reader converts — so the index stays checkable against the
// raw file.
//
// ## 2. The en-passant square is recorded only when a capture is legal
//
// Lichess FENs have four fields (board, side, castling, ep). In the same sample
// the ep square was present in 665 of 400,082 positions — 0.17%, far below the
// rate at which double pawn pushes occur. So the dump follows the "legal ep
// only" convention, while chess.js emits the square after *every* double push.
// Normalising is therefore mandatory: without it, every position reached by a
// double pawn push misses, and openings are full of them.

import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { Chess } from 'chess.js'

/** Bytes per packed record: 16 key + 1 depth + 3 knodes + 5 × 4 pv. */
export const RECORD_BYTES = 40

/**
 * How many bucket files the index is split across — one per value of the key's
 * first byte.
 *
 * The layout lives here, in the module with no dependencies, rather than beside
 * the builder: the reader needs it too, and having the reader import the
 * builder put `build.mjs -> evalDb -> buildEvalIndex -> build.mjs` in a cycle
 * that left `DEFAULTS` undefined at import time.
 */
export const BUCKETS = 256

export const bucketPath = (dir, i, ext) => join(dir, `b${String(i).padStart(3, '0')}.${ext}`)
export const KEY_BYTES = 16
export const MAX_PVS = 5

const KNODES_MAX = 0xffffff
const DEPTH_MAX = 0xff
/** Scores at or beyond this magnitude encode a mate distance, not centipawns. */
const MATE_FLOOR = 30_000
const MATE_ZERO = 32_767
const CP_LIMIT = MATE_FLOOR - 1

const PROMO_CODES = { n: 1, b: 2, r: 3, q: 4 }
const PROMO_CHARS = ['', 'n', 'b', 'r', 'q']

/**
 * The four-field FEN in the dump's own convention, which is the key we hash.
 *
 * Drops the halfmove/fullmove counters (the dump has none) and clears the ep
 * square unless an en-passant capture is actually available — see the note at
 * the top of this file.
 *
 * @param {string} fen  any FEN, four fields or six
 * @returns {string}
 */
export function evalFen(fen) {
  const parts = fen.trim().split(/\s+/)
  if (parts.length < 4) throw new Error(`not a FEN: ${fen}`)
  const [board, side, castling, ep] = parts

  if (ep === '-') return `${board} ${side} ${castling} -`

  // A recorded ep square that no pawn can actually use is not part of the key.
  const full = parts.length >= 6 ? parts.join(' ') : `${board} ${side} ${castling} ${ep} 0 1`
  let capturable
  try {
    capturable = new Chess(full).moves({ verbose: true }).some((m) => m.flags.includes('e'))
  } catch {
    // An unparseable position cannot be normalised; keep the square as given
    // rather than inventing a different key.
    capturable = true
  }
  return `${board} ${side} ${castling} ${capturable ? ep : '-'}`
}

/**
 * 128-bit key for a normalised FEN.
 *
 * MD5 is used for its width and speed, not its security: nothing here is
 * adversarial, and 128 random bits put the chance of *any* accidental collision
 * across the dump's 401,283,893 positions at roughly 1e-22.
 *
 * @param {string} normalisedFen  output of {@link evalFen}
 * @returns {Buffer} 16 bytes
 */
export function keyFor(normalisedFen) {
  return createHash('md5').update(normalisedFen, 'utf8').digest()
}

/** Convenience: normalise then hash. */
export function keyForFen(fen) {
  return keyFor(evalFen(fen))
}

/** Square index from a name, a1 = 0 … h8 = 63. */
export const squareIndex = (name) =>
  name.charCodeAt(0) - 97 + (name.charCodeAt(1) - 49) * 8

/** Inverse of {@link squareIndex}. */
export const squareName = (s) =>
  String.fromCharCode(97 + (s % 8)) + String.fromCharCode(49 + Math.floor(s / 8))

/**
 * Pack a UCI move into 16 bits: from | to << 6 | promo << 12.
 * `0` is the sentinel for "no move" — a1a1 is never legal.
 * @param {string} uci
 */
export function packMove(uci) {
  if (!uci || uci.length < 4) return 0
  const from = squareIndex(uci.slice(0, 2))
  const to = squareIndex(uci.slice(2, 4))
  if (from < 0 || from > 63 || to < 0 || to > 63) return 0
  const promo = PROMO_CODES[uci[4]] ?? 0
  return from | (to << 6) | (promo << 12)
}

/** Inverse of {@link packMove}; `null` for the sentinel. */
export function unpackMove(packed) {
  if (!packed) return null
  const promo = PROMO_CHARS[(packed >> 12) & 7] ?? ''
  return squareName(packed & 63) + squareName((packed >> 6) & 63) + promo
}

/** Squares a1…h8 as a flat 64-entry array of FEN characters ('' when empty). */
export function boardArray(boardField) {
  const board = new Array(64).fill('')
  const ranks = boardField.split('/')
  for (let r = 0; r < ranks.length && r < 8; r++) {
    const rank = 7 - r // ranks[0] is rank 8
    let file = 0
    for (const ch of ranks[r]) {
      if (ch >= '1' && ch <= '8') file += Number(ch)
      else if (file < 8) board[rank * 8 + file++] = ch
    }
  }
  return board
}

/**
 * Rewrite a castling move from the dump's convention into the standard one.
 *
 * **Measured, and it silently degraded the gate before it was found.** Lichess
 * writes principal variations in UCI *Chess960* notation, where castling is
 * king-takes-rook: for `e4 e5 Nf3 Nc6 Bc4 f5 d3 Nf6` the index's best move
 * comes back as `e1h1`. chess.js `lan` and Stockfish both say `e1g1`. Nothing
 * threw — the move simply never matched, so every castling candidate skipped
 * the same-search multi-pv comparison and fell through to the weaker
 * after-move lookup, or all the way back to the local engine.
 *
 * Detected structurally rather than by square, so it holds for either colour
 * and either side of the board: a king "moving onto" a friendly rook is not a
 * legal move in standard chess, so there are no false positives.
 *
 * @param {string[]} board  from {@link boardArray}
 * @param {string} uci
 */
export function standardiseCastling(board, uci) {
  if (!uci || uci.length < 4) return uci
  const from = squareIndex(uci.slice(0, 2))
  const to = squareIndex(uci.slice(2, 4))
  const king = board[from]
  if (king !== 'K' && king !== 'k') return uci
  if (board[to] !== (king === 'K' ? 'R' : 'r')) return uci

  const rank = Math.floor(from / 8)
  const kingside = to % 8 > from % 8
  return squareName(from) + squareName(rank * 8 + (kingside ? 6 : 2))
}

/**
 * Pack a score into int16. Centipawns pass through clamped; mates are pushed
 * above {@link MATE_FLOOR} so the two are distinguishable without a flag bit.
 * @param {{cp?: number, mate?: number}} pv
 */
export function packScore(pv) {
  if (typeof pv.mate === 'number') {
    const n = Math.max(-2000, Math.min(2000, pv.mate))
    return n >= 0 ? MATE_ZERO - n : -MATE_ZERO - n
  }
  const cp = Math.round(pv.cp ?? 0)
  return Math.max(-CP_LIMIT, Math.min(CP_LIMIT, cp))
}

/**
 * Inverse of {@link packScore}, in the domain's `Score` shape.
 * @returns {{type: 'cp'|'mate', value: number}}
 */
export function unpackScore(v) {
  if (v > MATE_FLOOR) return { type: 'mate', value: MATE_ZERO - v }
  if (v < -MATE_FLOOR) return { type: 'mate', value: -MATE_ZERO - v }
  return { type: 'cp', value: v }
}

/**
 * Write one position's entry into `buf` at `offset`.
 *
 * @param {Buffer} buf
 * @param {number} offset
 * @param {Buffer} key      16 bytes from {@link keyFor}
 * @param {{depth: number, knodes: number, pvs: {cp?: number, mate?: number, line?: string}[]}} evl
 */
export function packRecord(buf, offset, key, evl) {
  key.copy(buf, offset, 0, KEY_BYTES)
  buf.writeUInt8(Math.min(DEPTH_MAX, Math.max(0, evl.depth | 0)), offset + 16)

  const kn = Math.min(KNODES_MAX, Math.max(0, evl.knodes | 0))
  buf.writeUInt8((kn >> 16) & 0xff, offset + 17)
  buf.writeUInt8((kn >> 8) & 0xff, offset + 18)
  buf.writeUInt8(kn & 0xff, offset + 19)

  for (let i = 0; i < MAX_PVS; i++) {
    const at = offset + 20 + i * 4
    const pv = evl.pvs?.[i]
    if (!pv) {
      buf.writeInt16LE(0, at)
      buf.writeUInt16LE(0, at + 2)
      continue
    }
    buf.writeInt16LE(packScore(pv), at)
    buf.writeUInt16LE(packMove(pv.line ? pv.line.split(' ')[0] : ''), at + 2)
  }
}

/**
 * Read a record back.
 *
 * Scores come out **as stored, from White's point of view**. Converting to the
 * mover's view is the reader's job (evalDb.mjs) because only it knows the FEN.
 *
 * @returns {{depth: number, knodes: number, pvs: {score: {type:'cp'|'mate',value:number}, uci: string}[]}}
 */
export function unpackRecord(buf, offset) {
  const depth = buf.readUInt8(offset + 16)
  const knodes =
    (buf.readUInt8(offset + 17) << 16) | (buf.readUInt8(offset + 18) << 8) | buf.readUInt8(offset + 19)

  const pvs = []
  for (let i = 0; i < MAX_PVS; i++) {
    const at = offset + 20 + i * 4
    const packed = buf.readUInt16LE(at + 2)
    const raw = buf.readInt16LE(at)
    // An unused slot is both fields zero. A slot carrying a score but no move
    // is a real evaluation whose line we could not pack, and dropping it would
    // silently promote the second-best move into `lines[0]` — understating
    // every swing measured at that position, with nothing recording why.
    if (!packed && raw === 0) continue
    pvs.push({ score: unpackScore(raw), uci: unpackMove(packed) })
  }
  return { depth, knodes, pvs }
}

/**
 * Compare two 16-byte keys held in buffers, as unsigned big-endian.
 * Used both to sort a bucket and to binary-search it.
 */
export function compareKeys(a, aOff, b, bOff) {
  for (let i = 0; i < KEY_BYTES; i++) {
    const d = a[aOff + i] - b[bOff + i]
    if (d !== 0) return d
  }
  return 0
}

/** Which of the 256 buckets a key belongs to. */
export function bucketOf(key) {
  return key[0]
}
