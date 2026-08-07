#!/usr/bin/env node
// Verify — and repair — the local dump cache under db/cache.
//
// zstd does not report a torn frame: it returns whatever it managed to decode
// and calls that success. So "the build finished" says nothing about whether the
// build saw the whole file, and a cached dump can be a truncated prefix of the
// month while every downstream number looks plausible. The only honest check is
// to decode the bytes and see where they stop.
//
// The sidecar (`<file>.meta`, `{"validBytes":N}`) is what buildBook trusts on
// startup: it truncates the cache back to that mark and re-fetches from there.
// A sidecar that *understates* a good file silently throws away a download; one
// that *overstates* a damaged file poisons every later run. Both have happened
// here — 2026-05 shipped 456 MB of good bytes recorded as 12, and 2026-06 had no
// sidecar at all — so this exists to make the claim checkable rather than
// assumed.
//
//   node scripts/repertoire/verifyCache.mjs            # report
//   node scripts/repertoire/verifyCache.mjs --repair   # and rewrite the sidecars
//
// Exits non-zero when anything is damaged, so it can gate a rebuild.
import { createReadStream, statSync, writeFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { sniffAndDecompress } from './decompress.mjs'
import { readValidBytes } from './buildBook.mjs'

// Resolved against the repo, not the working directory: a relative path made
// this print "nothing to verify" and exit 0 whenever it was run from anywhere
// else — a verification step that passes having examined no files at all.
export const CACHE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'db', 'cache')

/**
 * How much of a cached dump a later run may safely resume from, or `null` when
 * verification cannot locate a safe point at all.
 *
 * On a clean EOF that is the whole file. On a torn stream it is the decoder's
 * consumed mark, which already sits SAFETY_MARGIN behind the feed position and
 * is conservative by construction (see decompress.mjs). That mark is
 * `fed - SAFETY_MARGIN`, so for any file smaller than the 16 MiB margin it is
 * structurally 0 — which says nothing about how much of the file is sound.
 * Reporting that as 0 would let `--repair` write validBytes:0 and discard a
 * download that is probably almost entirely good, so it is `null` instead.
 */
export function trustedBytes({ ok, size, consumed }) {
  if (ok) return size
  const mark = Math.min(consumed, size)
  return mark > 0 ? mark : null
}

/** What to do about a sidecar, given what verification actually found. */
export function repairPlan({ recorded, verified }) {
  if (verified === null || verified === undefined) return { action: 'unknown' }
  if (recorded === verified) return { action: 'ok' }
  return {
    action: recorded < verified ? 'raise' : 'lower',
    from: recorded,
    to: verified,
    bytesAtRisk: Math.abs(verified - recorded),
  }
}

// Counted on the raw bytes rather than by decoding each chunk to a string: a
// month is ~3.2 GB decompressed, and building a latin1 string per chunk plus two
// /gm regex passes over it costs several GB of transient allocation for a tool
// meant to be cheap enough to run before every rebuild.
const EVENT = Buffer.from('\n[Event ')
const RESULT = Buffer.from('\n[Result ')
const CARRY = Math.max(EVENT.length, RESULT.length) - 1

/**
 * Occurrences of `needle` that were *not* already counted in the previous chunk.
 *
 * The carried tail is rescanned so a needle straddling a chunk boundary is still
 * found, which means anything lying wholly inside it has been seen before —
 * count those again and a 3 GB dump gains phantom records (measured: 17 of them
 * over 2026-05). A match is new only if it ends past the carried region.
 */
export function countTag(buf, needle, carried = 0) {
  let n = 0
  for (let i = buf.indexOf(needle); i !== -1; i = buf.indexOf(needle, i + needle.length)) {
    if (i + needle.length > carried) n++
  }
  return n
}

/** Decode one cached dump end to end and report what is actually in it. */
export async function verifyFile(path) {
  const size = statSync(path).size
  let bytesOut = 0, events = 0, results = 0, consumed = 0
  let carry = Buffer.alloc(0)
  let first = true
  let error = null
  try {
    for await (const chunk of sniffAndDecompress(createReadStream(path), {
      onConsumed: (n) => { consumed = n },
    })) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      bytesOut += buf.length
      const scan = carry.length ? Buffer.concat([carry, buf]) : buf
      // The needles are newline-anchored, so the record at byte 0 of the file
      // has nothing in front of it to match.
      if (first) {
        if (scan.subarray(0, EVENT.length - 1).equals(EVENT.subarray(1))) events++
        if (scan.subarray(0, RESULT.length - 1).equals(RESULT.subarray(1))) results++
        first = false
      }
      events += countTag(scan, EVENT, carry.length)
      results += countTag(scan, RESULT, carry.length)
      // Keep just enough of the tail that a needle straddling the boundary is
      // still found, without rescanning any byte twice.
      carry = scan.subarray(Math.max(0, scan.length - CARRY))
    }
  } catch (e) {
    error = e
  }
  return {
    path, size, bytesOut, games: events,
    // A stream torn between a [Result] and the next [Event] leaves more results
    // than events; a negative "torn record" count is not a thing.
    torn: Math.max(0, events - results),
    consumed, ok: !error, error,
  }
}

const mb = (n) => `${(n / 1e6).toFixed(1)} MB`

async function main() {
  const repair = process.argv.includes('--repair')
  let entries
  try {
    entries = await readdir(CACHE_DIR, { withFileTypes: true })
  } catch {
    console.log(`no ${CACHE_DIR} — nothing to verify`)
    return
  }
  // Files only: a stray subdirectory would statSync fine, fail to open, and be
  // reported as a damaged dump complete with its own bogus sidecar.
  const files = entries.filter((e) => e.isFile() && !e.name.endsWith('.meta')).map((e) => e.name)
  if (!files.length) {
    console.log(`${CACHE_DIR} is empty`)
    return
  }

  let bad = 0
  for (const name of files) {
    const path = join(CACHE_DIR, name)
    const r = await verifyFile(path)
    const verified = trustedBytes(r)
    const metaPath = `${path}.meta`
    // readValidBytes already returns 0 for a missing or malformed sidecar.
    const recorded = readValidBytes(metaPath)
    const plan = repairPlan({ recorded, verified })

    console.log(`\n${name}`)
    console.log(`  ${mb(r.size)} on disk → ${mb(r.bytesOut)} decoded · ${r.games.toLocaleString()} games` +
      (r.torn ? ` · ${r.torn} torn record(s)` : ''))
    if (r.ok) {
      console.log(`  decodes cleanly to EOF`)
    } else {
      bad++
      // Whatever was thrown — not necessarily an Error, and crashing here would
      // abandon the remaining files at the moment damage was actually found.
      const why = String(r.error?.message ?? r.error).split('.')[0]
      console.log(`  DAMAGED after ${mb(r.bytesOut)} decoded: ${why}`)
    }

    if (plan.action === 'unknown') {
      console.log(`  cannot locate a safe resume point (the file is smaller than the decoder's`)
      console.log(`  safety margin), so the sidecar is left at ${recorded.toLocaleString()} rather than zeroed.`)
      console.log(`  Delete this file and let it re-download if you want it rebuilt.`)
    } else if (plan.action === 'ok') {
      console.log(`  sidecar agrees (${verified.toLocaleString()} valid bytes)`)
    } else {
      const why = plan.action === 'raise'
        ? `understates the file — a rebuild would discard ${mb(plan.bytesAtRisk)} of good download`
        : `overstates a damaged file — a rebuild would read ${mb(plan.bytesAtRisk)} of untrusted bytes`
      console.log(`  sidecar ${why}`)
      console.log(`  ${recorded.toLocaleString()} → ${verified.toLocaleString()}${repair ? '  [written]' : '  (run --repair to fix)'}`)
      if (repair) writeFileSync(metaPath, JSON.stringify({ validBytes: verified }))
    }
  }
  console.log(`\n${files.length} file(s) checked, ${bad} damaged.`)
  if (bad) {
    console.log('A damaged file is still usable as a prefix — the sidecar stops reads at the last good byte.')
    // Non-zero so `verifyCache && buildBook` cannot proceed on truncated input.
    process.exitCode = 1
  }
}

// Windows gives `file:///C:/…` from import.meta.url but argv[1] is a plain path,
// so compare through pathToFileURL — as build.mjs, crawl.mjs and buildBook.mjs do.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
