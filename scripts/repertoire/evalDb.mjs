// Reader for the local Lichess evaluation index built by buildEvalIndex.mjs.
//
// Deliberately shaped like `createEngine().analyse(fen)` rather than like the
// explorer: it answers "how good is this position and what are the best moves",
// which is the engine's question, not the book's. So `lines` come out ordered
// best-first and **expressed from the side to move**, exactly as engine.mjs
// documents its own return — which is what lets the crawler's soundness gate
// take either one without knowing the difference.
//
// The conversion from the dump's White-relative scores happens here, in one
// place, because this is the only layer that has both the score and the FEN.

import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  RECORD_BYTES,
  boardArray,
  bucketOf,
  bucketPath,
  compareKeys,
  evalFen,
  keyFor,
  standardiseCastling,
  unpackRecord,
} from './evalKey.mjs'

/** Flip a score to the other side's point of view. */
const negate = (s) => ({ type: s.type, value: -s.value })

/**
 * Binary-search one sorted bucket for a key, leaving the record in `probe`.
 *
 * The found record is left in the caller's buffer rather than re-read from the
 * offset: the last comparison already had those 40 bytes in hand, so fetching
 * them again is a wasted syscall on every successful lookup.
 *
 * @param {Buffer} probe  scratch of RECORD_BYTES; holds the record on a hit
 * @returns {number|null} byte offset of the record, or null
 */
export function findInBucket(fd, size, key, probe = Buffer.allocUnsafe(RECORD_BYTES)) {
  let lo = 0
  let hi = Math.floor(size / RECORD_BYTES) - 1

  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    readSync(fd, probe, 0, RECORD_BYTES, mid * RECORD_BYTES)
    const cmp = compareKeys(probe, 0, key, 0)
    if (cmp === 0) return mid * RECORD_BYTES
    if (cmp < 0) lo = mid + 1
    else hi = mid - 1
  }
  return null
}

/**
 * @param {object} opts
 * @param {string} opts.dir  the index directory (holds manifest.json + b000..b255.bin)
 */
export function createEvalDb({ dir }) {
  const manifestPath = join(dir, 'manifest.json')
  if (!existsSync(manifestPath)) {
    throw new Error(
      `no evaluation index at ${dir} — run: node scripts/repertoire/buildEvalIndex.mjs --out ${dir}`,
    )
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))

  // Buckets are opened lazily and kept open; a crawl touches all 256 quickly
  // and 256 file descriptors is nothing, but a one-position lookup opens one.
  const fds = new Array(256).fill(null)
  const sizes = new Array(256).fill(0)
  const counters = { hits: 0, misses: 0 }
  // One scratch record per reader, refilled by each search. Everything is read
  // out of it before the next query, so there is nothing to alias.
  const probe = Buffer.allocUnsafe(RECORD_BYTES)

  const openBucket = (i) => {
    if (fds[i] === null) {
      const path = bucketPath(dir, i, 'bin')
      if (!existsSync(path)) throw new Error(`evaluation index is incomplete: ${path} is missing`)
      fds[i] = openSync(path, 'r')
      sizes[i] = statSync(path).size
    }
    return fds[i]
  }

  return {
    manifest,

    /**
     * Evaluation for one position, or `null` if the dump has never seen it.
     *
     * @param {string} fen
     * @returns {{lines: {multipv: number, score: {type:'cp'|'mate',value:number}, pv: string[]}[],
     *            bestMove: string|null, depth: number, knodes: number, source: 'cloud'}|null}
     *   `lines` are ordered best-first and expressed from the side to move.
     */
    query(fen) {
      const normalised = evalFen(fen)
      const key = keyFor(normalised)
      const i = bucketOf(key)
      if (findInBucket(openBucket(i), sizes[i], key, probe) === null) {
        counters.misses++
        return null
      }
      counters.hits++
      const rec = unpackRecord(probe, 0)

      // Stored White-relative (see evalKey.mjs); callers want the mover's view.
      // Castling is rewritten out of the dump's Chess960 form here, in the one
      // place that has the board, so no caller has to know the dump says
      // `e1h1` where chess.js and Stockfish both say `e1g1`.
      const [boardField, side] = normalised.split(' ')
      const board = boardArray(boardField)
      const whiteToMove = side === 'w'
      const lines = rec.pvs.map((pv, n) => ({
        multipv: n + 1,
        score: whiteToMove ? pv.score : negate(pv.score),
        pv: pv.uci ? [standardiseCastling(board, pv.uci)] : [],
      }))

      return {
        lines,
        bestMove: lines[0]?.pv?.[0] ?? null,
        depth: rec.depth,
        knodes: rec.knodes,
        // Named for what it is. This said `'cloud'` — the shape it imitates —
        // so every counter downstream attributed hundreds of thousands of local
        // reads to a service that was never contacted, and `stats()` on this
        // same object disagreed by reporting `'eval-index'`.
        source: 'eval-index',
      }
    },

    stats: () => ({ ...counters, source: 'eval-index' }),

    close() {
      for (let i = 0; i < fds.length; i++) {
        if (fds[i] !== null) closeSync(fds[i])
        fds[i] = null
      }
    },
  }
}
