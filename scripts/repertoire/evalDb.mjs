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
  bucketOf,
  bucketPath,
  compareKeys,
  evalFen,
  keyFor,
  unpackRecord,
} from './evalKey.mjs'

/** Flip a score to the other side's point of view. */
const negate = (s) => ({ type: s.type, value: -s.value })

/**
 * Binary-search one sorted bucket for a key.
 * @returns {number|null} byte offset of the record, or null
 */
export function findInBucket(fd, size, key) {
  let lo = 0
  let hi = Math.floor(size / RECORD_BYTES) - 1
  const probe = Buffer.allocUnsafe(RECORD_BYTES)

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
      const at = findInBucket(openBucket(i), sizes[i], key)
      if (at === null) {
        counters.misses++
        return null
      }
      counters.hits++

      const buf = Buffer.allocUnsafe(RECORD_BYTES)
      readSync(fds[i], buf, 0, RECORD_BYTES, at)
      const rec = unpackRecord(buf, 0)

      // Stored White-relative (see evalKey.mjs); callers want the mover's view.
      const whiteToMove = normalised.split(' ')[1] === 'w'
      const lines = rec.pvs.map((pv, n) => ({
        multipv: n + 1,
        score: whiteToMove ? pv.score : negate(pv.score),
        pv: [pv.uci],
      }))

      return {
        lines,
        bestMove: lines[0]?.pv[0] ?? null,
        depth: rec.depth,
        knodes: rec.knodes,
        source: 'cloud',
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
