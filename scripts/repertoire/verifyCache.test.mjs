import { describe, it, expect } from 'vitest'
import { trustedBytes, repairPlan } from './verifyCache.mjs'

describe('trustedBytes — how much of a cached dump a later run may resume from', () => {
  it('trusts the whole file when the stream ended cleanly', () => {
    expect(trustedBytes({ ok: true, size: 456_721_264, consumed: 440_000_000 })).toBe(456_721_264)
  })

  it('falls back to the decoder mark when the stream was torn', () => {
    // `consumed` already sits SAFETY_MARGIN behind the feed position, so it is
    // the conservative answer by construction — see decompress.mjs.
    expect(trustedBytes({ ok: false, size: 65_584_394, consumed: 48_807_178 })).toBe(48_807_178)
  })

  it('never claims more than the file holds', () => {
    expect(trustedBytes({ ok: false, size: 100, consumed: 999 })).toBe(100)
  })

  it('never goes negative when nothing decoded', () => {
    expect(trustedBytes({ ok: false, size: 100, consumed: -1 })).toBe(0)
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
})
