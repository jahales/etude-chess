import { describe, it, expect } from 'vitest'
import { Chess } from 'chess.js'
import {
  RECORD_BYTES,
  bucketOf,
  compareKeys,
  evalFen,
  keyFor,
  keyForFen,
  packMove,
  packRecord,
  packScore,
  unpackMove,
  unpackRecord,
  unpackScore,
} from './evalKey.mjs'

// These are the two conventions that, if wrong, produce a plausible-looking
// result instead of an error — so they get the most tests.

describe('evalFen — key normalisation', () => {
  it('drops the halfmove and fullmove counters', () => {
    expect(evalFen(new Chess().fen())).toBe(
      'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -',
    )
  })

  it('accepts a four-field FEN unchanged', () => {
    const f = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -'
    expect(evalFen(f)).toBe(f)
  })

  it('clears an ep square that no pawn can capture on', () => {
    // The "always record after a double push" convention, which most FEN
    // producers use and the dump does not. After 1.e4 no black pawn stands on
    // d4 or f4, so e3 is not part of the dump's key and must be stripped.
    expect(evalFen('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1')).toBe(
      'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -',
    )
  })

  it('agrees with chess.js, which already omits an unusable ep square', () => {
    // Worth pinning: chess.js 1.4 happens to share the dump's convention, so
    // the normaliser is a no-op on our own FENs. If a future version reverts to
    // always recording, this test fails here rather than as a silent 0% hit
    // rate in the audit.
    const c = new Chess()
    c.move('e4')
    expect(c.fen()).toContain(' - ')
    expect(evalFen(c.fen())).toBe('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -')
  })

  it('keeps an ep square that is genuinely capturable', () => {
    // 1.e4 a6 2.e5 d5 — now exd6 e.p. is legal, so d6 belongs in the key.
    const c = new Chess()
    for (const m of ['e4', 'a6', 'e5', 'd5']) c.move(m)
    expect(evalFen(c.fen())).toMatch(/ d6$/)
  })

  it('is stable across the two spellings of the same position', () => {
    const c = new Chess()
    c.move('e4')
    const six = c.fen()
    const four = six.split(' ').slice(0, 4).join(' ')
    expect(keyForFen(six).equals(keyForFen(four))).toBe(true)
  })

  it('rejects a string that is not a FEN', () => {
    expect(() => evalFen('not a fen')).toThrow(/not a FEN/)
  })
})

describe('keyFor', () => {
  it('is 16 bytes and deterministic', () => {
    const k = keyFor('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -')
    expect(k).toHaveLength(16)
    expect(k.equals(keyFor('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -'))).toBe(true)
  })

  it('separates positions that differ only in side to move', () => {
    const w = keyFor('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -')
    const b = keyFor('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq -')
    expect(w.equals(b)).toBe(false)
  })

  it('puts the bucket in range', () => {
    for (const fen of ['8/8/8/8/8/8/8/K6k w - -', '8/8/8/8/8/8/8/K6k b - -']) {
      const bucket = bucketOf(keyFor(fen))
      expect(bucket).toBeGreaterThanOrEqual(0)
      expect(bucket).toBeLessThan(256)
    }
  })
})

describe('move packing', () => {
  it('round-trips ordinary moves', () => {
    for (const uci of ['e2e4', 'a1a2', 'h7h8', 'b1c3', 'g8f6']) {
      expect(unpackMove(packMove(uci))).toBe(uci)
    }
  })

  it('round-trips promotions', () => {
    for (const uci of ['a7a8q', 'b2b1n', 'h7h8r', 'c2c1b']) {
      expect(unpackMove(packMove(uci))).toBe(uci)
    }
  })

  it('treats 0 as absent', () => {
    expect(unpackMove(0)).toBeNull()
    expect(packMove('')).toBe(0)
    expect(packMove(undefined)).toBe(0)
  })
})

describe('score packing', () => {
  it('round-trips centipawns including the sign', () => {
    for (const cp of [0, 1, -1, 35, -35, 900, -900, 25_000, -25_000]) {
      expect(unpackScore(packScore({ cp }))).toEqual({ type: 'cp', value: cp })
    }
  })

  it('round-trips mate distances including the sign', () => {
    for (const mate of [1, -1, 5, -5, 15, -15, 99, -99]) {
      expect(unpackScore(packScore({ mate }))).toEqual({ type: 'mate', value: mate })
    }
  })

  it('never confuses a large centipawn score with a mate', () => {
    const huge = unpackScore(packScore({ cp: 99_999 }))
    expect(huge.type).toBe('cp')
    const mate = unpackScore(packScore({ mate: 1 }))
    expect(mate.type).toBe('mate')
  })
})

describe('packRecord / unpackRecord', () => {
  const evl = {
    depth: 50,
    knodes: 2_800_000,
    pvs: [
      { cp: 30, line: 'e2e4 e7e5 g1f3' },
      { cp: 25, line: 'd2d4 d7d5' },
      { mate: 12, line: 'b1c3' },
    ],
  }

  it('round-trips a full entry', () => {
    const buf = Buffer.alloc(RECORD_BYTES)
    const key = keyFor('8/8/8/8/8/8/8/K6k w - -')
    packRecord(buf, 0, key, evl)

    const out = unpackRecord(buf, 0)
    expect(out.depth).toBe(50)
    expect(out.knodes).toBe(2_800_000)
    expect(out.pvs).toEqual([
      { score: { type: 'cp', value: 30 }, uci: 'e2e4' },
      { score: { type: 'cp', value: 25 }, uci: 'd2d4' },
      { score: { type: 'mate', value: 12 }, uci: 'b1c3' },
    ])
    expect(buf.subarray(0, 16).equals(key)).toBe(true)
  })

  it('writes at an offset without disturbing its neighbours', () => {
    const buf = Buffer.alloc(RECORD_BYTES * 3, 0x7f)
    packRecord(buf, RECORD_BYTES, keyFor('8/8/8/8/8/8/8/K6k w - -'), evl)
    expect(buf.subarray(0, RECORD_BYTES).every((b) => b === 0x7f)).toBe(true)
    expect(buf.subarray(RECORD_BYTES * 2).every((b) => b === 0x7f)).toBe(true)
    expect(unpackRecord(buf, RECORD_BYTES).depth).toBe(50)
  })

  it('clamps depth and knodes rather than overflowing into the next field', () => {
    const buf = Buffer.alloc(RECORD_BYTES)
    packRecord(buf, 0, keyFor('8/8/8/8/8/8/8/K6k w - -'), {
      depth: 9999,
      knodes: 99_999_999,
      pvs: [],
    })
    const out = unpackRecord(buf, 0)
    expect(out.depth).toBe(255)
    expect(out.knodes).toBe(0xffffff)
    expect(out.pvs).toEqual([])
  })

  it('drops pvs beyond the fifth rather than writing past the record', () => {
    const buf = Buffer.alloc(RECORD_BYTES)
    packRecord(buf, 0, keyFor('8/8/8/8/8/8/8/K6k w - -'), {
      depth: 1,
      knodes: 1,
      pvs: Array.from({ length: 9 }, (_, i) => ({ cp: i, line: 'e2e4' })),
    })
    expect(unpackRecord(buf, 0).pvs).toHaveLength(5)
  })
})

describe('compareKeys', () => {
  it('orders unsigned, so a 0xff byte sorts above 0x01', () => {
    const a = Buffer.alloc(16)
    const b = Buffer.alloc(16)
    a[0] = 0x01
    b[0] = 0xff
    expect(compareKeys(a, 0, b, 0)).toBeLessThan(0)
    expect(compareKeys(b, 0, a, 0)).toBeGreaterThan(0)
  })

  it('is zero for equal keys and respects the offset', () => {
    const k = keyFor('8/8/8/8/8/8/8/K6k w - -')
    const buf = Buffer.concat([Buffer.alloc(7, 0xaa), k])
    expect(compareKeys(buf, 7, k, 0)).toBe(0)
  })

  it('breaks ties on later bytes', () => {
    const a = Buffer.alloc(16)
    const b = Buffer.alloc(16)
    a[15] = 1
    expect(compareKeys(a, 0, b, 0)).toBeGreaterThan(0)
  })
})
