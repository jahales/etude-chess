import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compress } from 'zstd-napi'
import { trustedBytes, repairPlan, verifyFile, countTag, CACHE_DIR } from './verifyCache.mjs'

describe('countTag — counting records across chunk boundaries', () => {
  const EVENT = Buffer.from('\n[Event ')

  it('counts every occurrence when nothing was carried', () => {
    expect(countTag(Buffer.from('\n[Event "a"]\n[Event "b"]'), EVENT)).toBe(2)
  })

  it('does not re-count a needle lying wholly inside the carried tail', () => {
    // The carry is rescanned so a needle straddling the boundary is still found,
    // which means anything fully inside it was already counted last time.
    // Counting it twice added 17 phantom records to a 3 GB dump.
    const scan = Buffer.concat([EVENT, Buffer.from('"later"]')])
    expect(countTag(scan, EVENT, EVENT.length)).toBe(0)
  })

  it('still counts a needle that straddles the boundary', () => {
    // Four bytes of the needle were carried; it only completes in this chunk, so
    // the previous pass could not have seen it.
    const scan = Buffer.concat([EVENT, Buffer.from('"x"]')])
    expect(countTag(scan, EVENT, 4)).toBe(1)
  })
})

describe('trustedBytes — how much of a cached dump a later run may resume from', () => {
  it('trusts the whole file when the stream ended cleanly', () => {
    expect(trustedBytes({ ok: true, size: 456_721_264, consumed: 440_000_000 })).toBe(456_721_264)
  })

  it('falls back to the decoder mark when the stream was torn', () => {
    // `consumed` already sits SAFETY_MARGIN behind the feed position, so it is
    // the conservative answer by construction — see decompress.mjs.
    expect(trustedBytes({ ok: false, size: 65_584_394, consumed: 48_807_178 })).toBe(48_807_178)
  })

  it('says "could not determine" rather than "nothing is valid" for a small torn file', () => {
    // The decoder mark is `fed - SAFETY_MARGIN`, so for any file smaller than
    // that 16 MiB margin it is structurally 0 — which says nothing about how
    // much of the file is good. Returning 0 here would let --repair write
    // validBytes:0 and throw away a download that is probably almost entirely
    // sound.
    expect(trustedBytes({ ok: false, size: 8_000_000, consumed: 0 })).toBeNull()
  })

  it('never claims more than the file holds', () => {
    expect(trustedBytes({ ok: false, size: 100, consumed: 999 })).toBe(100)
  })
})

describe('repairPlan — what to do about a sidecar that disagrees with reality', () => {
  it('leaves an accurate sidecar alone', () => {
    expect(repairPlan({ recorded: 17_761_302, verified: 17_761_302 })).toEqual({ action: 'ok' })
  })

  it('raises a sidecar that understates a good file, and says what it would have cost', () => {
    // The 2026-05 case: 456 MB of perfectly good bytes recorded as 12, so the
    // next `--month 2026-05` run truncates the lot and re-downloads it.
    expect(repairPlan({ recorded: 12, verified: 456_721_264 })).toEqual({
      action: 'raise',
      from: 12,
      to: 456_721_264,
      bytesAtRisk: 456_721_252,
    })
  })

  it('lowers a sidecar that overstates a damaged file', () => {
    expect(repairPlan({ recorded: 65_584_394, verified: 48_807_178 })).toEqual({
      action: 'lower',
      from: 65_584_394,
      to: 48_807_178,
      bytesAtRisk: 16_777_216,
    })
  })

  it('treats a missing sidecar as zero, not as agreement', () => {
    // 2026-06 had no sidecar at all. Defaulting that to "fine" is how an
    // unverified file gets read as if it were checked.
    expect(repairPlan({ recorded: 0, verified: 48_807_178 }).action).toBe('raise')
  })

  it('refuses to write anything when verification could not locate a safe point', () => {
    // Never turn "I do not know" into validBytes:0, which would discard the
    // whole cached prefix on the next run.
    expect(repairPlan({ recorded: 9_000_000, verified: null })).toEqual({ action: 'unknown' })
    expect(repairPlan({ recorded: 0, verified: null })).toEqual({ action: 'unknown' })
  })
})

describe('verifyFile — against real zstd bytes', () => {
  let dir
  const pgn = (n) =>
    Array.from({ length: n }, (_, i) => `[Event "G${i}"]\n[Result "1-0"]\n\n1. e4 e5 1-0\n\n`).join('')

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'verifycache-'))
    await writeFile(join(dir, 'clean.pgn.zst'), compress(Buffer.from(pgn(50))))
    // Lop off the tail so the final frame is incomplete — the exact shape that
    // zstd reports as success and that this module exists to catch.
    const whole = compress(Buffer.from(pgn(50)))
    await writeFile(join(dir, 'torn.pgn.zst'), whole.subarray(0, whole.length - 8))
    await writeFile(join(dir, 'plain.pgn'), Buffer.from(pgn(7)))
  })
  afterAll(async () => { await rm(dir, { recursive: true, force: true }) })

  it('reports a clean stream as clean and counts every record', async () => {
    const r = await verifyFile(join(dir, 'clean.pgn.zst'))
    expect(r.ok).toBe(true)
    expect(r.games).toBe(50)
    expect(r.torn).toBe(0)
  })

  it('counts the first record, which has no newline before it', async () => {
    // A `\n[Event ` needle misses the record at byte 0 of the file.
    const r = await verifyFile(join(dir, 'plain.pgn'))
    expect(r.games).toBe(7)
  })

  it('detects a torn final frame instead of reporting success', async () => {
    const r = await verifyFile(join(dir, 'torn.pgn.zst'))
    expect(r.ok).toBe(false)
    expect(r.error).toBeTruthy()
  })

  it('never reports a negative torn count', async () => {
    for (const f of ['clean.pgn.zst', 'torn.pgn.zst', 'plain.pgn']) {
      expect((await verifyFile(join(dir, f))).torn, f).toBeGreaterThanOrEqual(0)
    }
  })
})

describe('CACHE_DIR', () => {
  it('is absolute, so the script does not silently no-op from another directory', () => {
    // Relative 'db/cache' made `node scripts/repertoire/verifyCache.mjs` from any
    // other cwd print "nothing to verify" and exit 0 — a verification step that
    // passes having examined nothing.
    expect(CACHE_DIR).toMatch(/^([A-Za-z]:[\\/]|\/)/)
    expect(CACHE_DIR.replace(/\\/g, '/')).toMatch(/\/db\/cache$/)
  })
})
