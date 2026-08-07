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
import { createReadStream, statSync, existsSync, writeFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { sniffAndDecompress } from './decompress.mjs'
import { readValidBytes } from './buildBook.mjs'

export const CACHE_DIR = 'db/cache'

/**
 * How much of a cached dump a later run may safely resume from.
 *
 * On a clean EOF that is the whole file. On a torn stream it is the decoder's
 * consumed mark, which already sits SAFETY_MARGIN behind the feed position and
 * is therefore conservative by construction (see decompress.mjs).
 */
export function trustedBytes({ ok, size, consumed }) {
  if (ok) return size
  return Math.max(0, Math.min(consumed, size))
}

/** What to do about a sidecar, given what verification actually found. */
export function repairPlan({ recorded, verified }) {
  if (recorded === verified) return { action: 'ok' }
  return {
    action: recorded < verified ? 'raise' : 'lower',
    from: recorded,
    to: verified,
    bytesAtRisk: Math.abs(verified - recorded),
  }
}

/** Decode one cached dump end to end and report what is actually in it. */
export async function verifyFile(path) {
  const size = statSync(path).size
  let bytesOut = 0, events = 0, results = 0, consumed = 0, tail = ''
  let error = null
  try {
    for await (const chunk of sniffAndDecompress(createReadStream(path), {
      onConsumed: (n) => { consumed = n },
    })) {
      bytesOut += chunk.length
      const text = tail + chunk.toString('latin1')
      const cut = text.lastIndexOf('\n')
      tail = cut === -1 ? text : text.slice(cut + 1)
      const whole = cut === -1 ? '' : text.slice(0, cut)
      events += (whole.match(/^\[Event /gm) ?? []).length
      results += (whole.match(/^\[Result /gm) ?? []).length
    }
  } catch (e) {
    error = e
  }
  return { path, size, bytesOut, games: events, torn: events - results, consumed, ok: !error, error }
}

const mb = (n) => `${(n / 1e6).toFixed(1)} MB`

async function main() {
  const repair = process.argv.includes('--repair')
  if (!existsSync(CACHE_DIR)) {
    console.log(`no ${CACHE_DIR} — nothing to verify`)
    return
  }
  const files = (await readdir(CACHE_DIR)).filter((f) => !f.endsWith('.meta'))
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
    const recorded = existsSync(metaPath) ? readValidBytes(metaPath) : 0
    const plan = repairPlan({ recorded, verified })

    console.log(`\n${name}`)
    console.log(`  ${mb(r.size)} on disk → ${mb(r.bytesOut)} decoded · ${r.games.toLocaleString()} games` +
      (r.torn ? ` · ${r.torn} torn record(s)` : ''))
    console.log(r.ok
      ? `  decodes cleanly to EOF`
      : `  DAMAGED at ~${mb(r.consumed)}: ${r.error.message.split('.')[0]}`)
    if (!r.ok) bad++

    if (plan.action === 'ok') {
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
  if (bad) console.log('A damaged file is still usable as a prefix — the sidecar now stops reads at the last good byte.')
}

// Windows gives `file:///C:/…` from import.meta.url but argv[1] is a plain path,
// so compare through pathToFileURL — as build.mjs, crawl.mjs and buildBook.mjs do.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
