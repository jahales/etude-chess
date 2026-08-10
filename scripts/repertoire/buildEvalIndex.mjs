// Build a local, queryable index of the Lichess evaluation dump.
//
//   node scripts/repertoire/buildEvalIndex.mjs --in db/lichess_db_eval.jsonl.zst \
//        --out db/eval-index
//
// ## Why not a database
//
// The dump is 394.7M positions. Loading that into SQLite means 394.7M random
// B-tree inserts, which is where the six-to-twelve hours of such a build goes —
// the parsing is not the expensive part, the index maintenance is. Filtering to
// opening positions dodges the cost only by throwing away data we would rather
// keep.
//
// So: no B-tree. One streaming pass writes fixed-width 40-byte records into 256
// bucket files chosen by the first byte of the key — **append-only, sequential
// writes**, which cost nothing. Then each bucket (~62 MB) is sorted in memory on
// its own. A lookup hashes the FEN, opens one bucket, and binary-searches it.
//
// Result: ~16 GB, roughly an hour, sub-millisecond lookups, and every position
// kept. The buckets are never concatenated, so the build is restartable a bucket
// at a time and each one can be verified independently.
//
// The record layout and the two measured conventions of the dump (White-relative
// scores, ep square only when capturable) live in evalKey.mjs.

import {
  closeSync,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { decompressZstd } from './decompress.mjs'
import { RECORD_BYTES, bucketOf, compareKeys, keyFor, packRecord } from './evalKey.mjs'
import { parseArgs, numberFlag, stringFlag } from './build.mjs'

export const BUCKETS = 256
/** Per-bucket write buffer. 256 × 1 MB = 256 MB resident, 16k writes for 16 GB. */
const BUCKET_BUF = 1 << 20
const NEWLINE = 0x0a

export const bucketPath = (dir, i, ext) => join(dir, `b${String(i).padStart(3, '0')}.${ext}`)

/**
 * Pick the entry to keep when a position was analysed more than once.
 * Deepest wins; knodes breaks a tie, because at equal depth the wider search is
 * the better-supported number.
 */
export function deepest(evals) {
  let best = null
  for (const e of evals) {
    if (!e?.pvs?.length) continue
    if (!best || e.depth > best.depth || (e.depth === best.depth && e.knodes > best.knodes)) best = e
  }
  return best
}

/** Sort one bucket file in place and rename it to its final name. */
export function sortBucket(dir, i) {
  const part = bucketPath(dir, i, 'part')
  const final = bucketPath(dir, i, 'bin')
  if (!existsSync(part)) {
    writeFileSync(final, Buffer.alloc(0))
    return 0
  }

  const buf = readFileSync(part)
  const n = Math.floor(buf.length / RECORD_BYTES)

  const order = new Uint32Array(n)
  for (let k = 0; k < n; k++) order[k] = k
  order.sort((a, b) => compareKeys(buf, a * RECORD_BYTES, buf, b * RECORD_BYTES))

  const out = Buffer.allocUnsafe(n * RECORD_BYTES)
  for (let k = 0; k < n; k++) {
    buf.copy(out, k * RECORD_BYTES, order[k] * RECORD_BYTES, order[k] * RECORD_BYTES + RECORD_BYTES)
  }
  writeFileSync(final, out)
  unlinkSync(part)
  return n
}

/**
 * Stream the dump into unsorted bucket files.
 * @returns {Promise<{records: number, unparseable: number, empty: number}>}
 */
export async function scatter(source, dir, { limit = Infinity, onProgress } = {}) {
  const fds = []
  const bufs = []
  const used = new Int32Array(BUCKETS)
  for (let i = 0; i < BUCKETS; i++) {
    fds.push(openSync(bucketPath(dir, i, 'part'), 'w'))
    bufs.push(Buffer.allocUnsafe(BUCKET_BUF))
  }

  const flush = (i) => {
    if (used[i] > 0) writeSync(fds[i], bufs[i], 0, used[i])
    used[i] = 0
  }

  const scratch = Buffer.alloc(RECORD_BYTES)
  let records = 0
  let unparseable = 0
  let empty = 0
  let leftover = Buffer.alloc(0)

  const handleLine = (buf, start, end) => {
    if (end <= start) return
    let o
    try {
      o = JSON.parse(buf.toString('utf8', start, end))
    } catch {
      unparseable++
      return
    }
    const evl = o?.evals && deepest(o.evals)
    if (!o?.fen || !evl) {
      empty++
      return
    }

    // The dump's FENs are already in its own convention, so they are hashed as
    // given — normalising here would be a no-op at best and a mismatch at worst.
    const key = keyFor(o.fen)
    packRecord(scratch, 0, key, evl)

    const i = bucketOf(key)
    if (used[i] + RECORD_BYTES > BUCKET_BUF) flush(i)
    scratch.copy(bufs[i], used[i])
    used[i] += RECORD_BYTES
    records++
  }

  try {
    outer: for await (const chunk of decompressZstd(createReadStream(source))) {
      const buf = leftover.length ? Buffer.concat([leftover, chunk]) : chunk
      let start = 0
      let nl
      while ((nl = buf.indexOf(NEWLINE, start)) !== -1) {
        handleLine(buf, start, nl)
        start = nl + 1
        if (records >= limit) {
          leftover = Buffer.alloc(0)
          break outer
        }
      }
      leftover = start < buf.length ? Buffer.from(buf.subarray(start)) : Buffer.alloc(0)
      onProgress?.(records)
    }
    if (leftover.length) handleLine(leftover, 0, leftover.length)

    for (let i = 0; i < BUCKETS; i++) flush(i)
  } finally {
    for (const fd of fds) closeSync(fd)
  }

  return { records, unparseable, empty }
}

async function main() {
  const args = parseArgs(process.argv.slice(2), ['in', 'out', 'limit'])
  const source = stringFlag(args, 'in') ?? 'db/lichess_db_eval.jsonl.zst'
  const dir = stringFlag(args, 'out') ?? 'db/eval-index'
  const limit = numberFlag(args, 'limit') ?? Infinity

  mkdirSync(dir, { recursive: true })
  const sourceBytes = statSync(source).size
  process.stdout.write(
    `indexing ${source} (${(sourceBytes / 1e9).toFixed(1)} GB) -> ${dir}\n` +
      `${BUCKETS} buckets, ${RECORD_BYTES} bytes/record\n\n`,
  )

  const started = Date.now()
  let lastPrint = 0
  const { records, unparseable, empty } = await scatter(source, dir, {
    limit,
    onProgress: (n) => {
      if (n - lastPrint < 2_000_000) return
      lastPrint = n
      const secs = (Date.now() - started) / 1000
      process.stdout.write(
        `  scattered ${(n / 1e6).toFixed(1)}M positions  ` +
          `${Math.round(n / secs / 1000)}k/s  ${Math.round(secs)}s elapsed\n`,
      )
    },
  })

  const scatterSecs = (Date.now() - started) / 1000
  process.stdout.write(
    `\nscatter done: ${records.toLocaleString()} positions in ${Math.round(scatterSecs)}s\n` +
      `  unparseable lines ${unparseable}   entries with no pv ${empty}\n\nsorting buckets…\n`,
  )

  let sorted = 0
  for (let i = 0; i < BUCKETS; i++) {
    sorted += sortBucket(dir, i)
    if ((i + 1) % 32 === 0) process.stdout.write(`  ${i + 1}/${BUCKETS} buckets\n`)
  }

  // The manifest is what evalDb.mjs checks before trusting the index: a build
  // killed midway leaves buckets that look perfectly well-formed, and a partial
  // index answers "not in the database" instead of failing.
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify(
      {
        source,
        sourceBytes,
        records: sorted,
        scattered: records,
        unparseable,
        empty,
        buckets: BUCKETS,
        recordBytes: RECORD_BYTES,
        limited: Number.isFinite(limit) ? limit : null,
        built: new Date().toISOString(),
        seconds: Math.round((Date.now() - started) / 1000),
      },
      null,
      2,
    ),
  )

  process.stdout.write(
    `\nindexed ${sorted.toLocaleString()} positions in ${Math.round((Date.now() - started) / 60000)} min\n`,
  )
}

// Windows gives `file:///C:/…` from import.meta.url but argv[1] is a plain path,
// so compare through pathToFileURL — as build.mjs, crawl.mjs and buildBook.mjs do.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
