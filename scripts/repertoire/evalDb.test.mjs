import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, unlinkSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Compressor } from 'zstd-napi'
import { Chess } from 'chess.js'
import { BUCKETS, bucketPath, deepest, scatter, sortBucket } from './buildEvalIndex.mjs'
import { createEvalDb } from './evalDb.mjs'
import { RECORD_BYTES, bucketOf, compareKeys, keyFor } from './evalKey.mjs'

// End to end through the real build path: a synthetic dump is compressed with
// the same zstd the real one uses, scattered, sorted and then queried. The one
// thing these tests exist to protect is the sign convention — a flip there is
// invisible to every other check and inverts every soundness verdict.

let dir
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'evaldb-'))
})

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -'
/** After 1.e4 — Black to move, so the stored White-relative score must flip. */
const AFTER_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -'

function dumpFile(entries, name = 'dump.jsonl.zst') {
  const jsonl = entries.map((e) => JSON.stringify(e)).join('\n') + '\n'
  const path = join(dir, name)
  writeFileSync(path, new Compressor().compress(Buffer.from(jsonl, 'utf8')))
  return path
}

async function build(entries) {
  const source = dumpFile(entries)
  const result = await scatter(source, dir)
  let sorted = 0
  for (let i = 0; i < BUCKETS; i++) sorted += sortBucket(dir, i)
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ records: sorted, ...result }))
  return createEvalDb({ dir })
}

const entry = (fen, pvs, depth = 50, knodes = 2_800_000) => ({
  fen,
  evals: [{ depth, knodes, pvs }],
})

describe('deepest', () => {
  it('takes the deepest entry', () => {
    expect(
      deepest([
        { depth: 20, knodes: 100, pvs: [{ cp: 1, line: 'e2e4' }] },
        { depth: 58, knodes: 50, pvs: [{ cp: 2, line: 'd2d4' }] },
      ]).depth,
    ).toBe(58)
  })

  it('breaks a depth tie on knodes — the wider search is better supported', () => {
    expect(
      deepest([
        { depth: 40, knodes: 100, pvs: [{ cp: 1, line: 'e2e4' }] },
        { depth: 40, knodes: 900, pvs: [{ cp: 2, line: 'd2d4' }] },
      ]).knodes,
    ).toBe(900)
  })

  it('ignores entries with no pv, and returns null when none are usable', () => {
    expect(deepest([{ depth: 99, knodes: 1, pvs: [] }])).toBeNull()
    expect(deepest([])).toBeNull()
  })
})

describe('createEvalDb — round trip', () => {
  it('finds a position and reports its depth and knodes', async () => {
    const db = await build([entry(START, [{ cp: 30, line: 'e2e4 e7e5' }], 46, 1_500_000)])
    const r = db.query(START)
    expect(r).not.toBeNull()
    expect(r.depth).toBe(46)
    expect(r.knodes).toBe(1_500_000)
    expect(r.bestMove).toBe('e2e4')
    db.close()
  })

  it('returns null for a position the dump has never seen', async () => {
    const db = await build([entry(START, [{ cp: 30, line: 'e2e4' }])])
    expect(db.query('8/8/8/4k3/8/8/4K3/8 w - -')).toBeNull()
    expect(db.stats().misses).toBe(1)
    db.close()
  })

  it('passes White-to-move scores through unchanged', async () => {
    const db = await build([entry(START, [{ cp: 30, line: 'e2e4' }])])
    expect(db.query(START).lines[0].score).toEqual({ type: 'cp', value: 30 })
    db.close()
  })

  it('negates scores when Black is to move, so lines read from the mover', async () => {
    // Stored +30 = 0.3 for White. With Black to move that is -30 for the mover.
    const db = await build([entry(AFTER_E4, [{ cp: 30, line: 'e7e5' }])])
    expect(db.query(AFTER_E4).lines[0].score).toEqual({ type: 'cp', value: -30 })
    db.close()
  })

  it('negates mate scores too', async () => {
    const db = await build([entry(AFTER_E4, [{ mate: 3, line: 'e7e5' }])])
    expect(db.query(AFTER_E4).lines[0].score).toEqual({ type: 'mate', value: -3 })
    db.close()
  })

  it('orders lines best-first as multipv 1..n', async () => {
    const db = await build([
      entry(START, [
        { cp: 30, line: 'e2e4 e7e5' },
        { cp: 25, line: 'd2d4 d7d5' },
        { cp: 18, line: 'g1f3' },
      ]),
    ])
    const r = db.query(START)
    expect(r.lines.map((l) => l.multipv)).toEqual([1, 2, 3])
    expect(r.lines.map((l) => l.pv[0])).toEqual(['e2e4', 'd2d4', 'g1f3'])
    db.close()
  })

  // The White-to-move case above only proves the packing preserves the order it
  // was given. Black is where the ordering could actually invert: the scores are
  // stored White-relative and negated on the way out, so if the dump ordered its
  // pvs by White's preference rather than the mover's, `lines[0]` would be
  // Black's *worst* move — and everything downstream treats it as the best.
  // `soundness.mjs` subtracts from it, the audit grades against it, `studyOrder`
  // scores against it, and a negative swing is clamped to 0, so the whole gate
  // would pass every candidate while reporting a clean run.
  //
  // Checked against the real index when this test was written: 932 White-to-move
  // and 346 Black-to-move repertoire positions all had monotonically
  // non-increasing mover win%, so the convention holds. This pins it.
  it('keeps lines best-first for the mover when Black is to move', async () => {
    const db = await build([
      entry(AFTER_E4, [
        { cp: -80, line: 'c7c5' }, // best for Black: most negative for White
        { cp: -20, line: 'e7e5' },
        { cp: 40, line: 'g8h6' }, // worst for Black
      ]),
    ])
    const r = db.query(AFTER_E4)
    expect(r.lines.map((l) => l.pv[0])).toEqual(['c7c5', 'e7e5', 'g8h6'])
    // From the mover's side these must descend, not ascend.
    expect(r.lines.map((l) => l.score.value)).toEqual([80, 20, -40])
    expect(r.bestMove).toBe('c7c5')
    db.close()
  })

  it('matches a six-field FEN against the dump\'s four-field key', async () => {
    const db = await build([entry(START, [{ cp: 30, line: 'e2e4' }])])
    expect(db.query(new Chess().fen())).not.toBeNull()
    db.close()
  })

  it('finds a position whose ep square is recorded but uncapturable', async () => {
    // The dump stores no ep square here; a caller supplying one must still hit.
    const db = await build([entry(AFTER_E4, [{ cp: 30, line: 'e7e5' }])])
    const spurious = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1'
    expect(db.query(spurious)).not.toBeNull()
    db.close()
  })
})

describe('createEvalDb — castling comes back in standard notation', () => {
  // The dump writes king-takes-rook. Every consumer compares against chess.js
  // `lan`, so an untranslated `e1h1` matches nothing and the move silently
  // drops to weaker evidence — measured against the real index before the fix.
  const READY = 'r1bqk2r/pppp1ppp/2n2n2/4p3/2B1P3/3P1N2/PPP2PPP/RNBQK2R w KQkq -'

  it('rewrites the dump\'s e1h1 into the e1g1 callers use', async () => {
    const db = await build([entry(READY, [{ cp: 40, line: 'e1h1 e8h8' }])])
    const r = db.query(READY)
    expect(r.bestMove).toBe('e1g1')
    expect(r.lines[0].pv).toEqual(['e1g1'])
    db.close()
  })

  it('matches a castling move produced by chess.js', async () => {
    const db = await build([entry(READY, [{ cp: 40, line: 'e1h1' }])])
    const c = new Chess(`${READY} 0 1`)
    const castle = c.moves({ verbose: true }).find((m) => m.san === 'O-O')
    expect(castle.lan).toBe('e1g1')
    expect(db.query(READY).lines.some((l) => l.pv[0] === castle.lan)).toBe(true)
    db.close()
  })

  it('leaves non-castling moves untouched', async () => {
    const db = await build([entry(READY, [{ cp: 40, line: 'f3g5 d7d6' }])])
    expect(db.query(READY).bestMove).toBe('f3g5')
    db.close()
  })
})

describe('createEvalDb — the index as a whole', () => {
  it('keeps every position across many buckets and finds them all', async () => {
    // 300 distinct legal positions, enough to spread across most buckets and to
    // exercise the binary search rather than hitting single-record files.
    const fens = []
    const c = new Chess()
    for (let i = 0; i < 300; i++) {
      const moves = c.moves()
      if (!moves.length) break
      c.move(moves[i % moves.length])
      fens.push(c.fen().split(' ').slice(0, 4).join(' '))
    }
    const unique = [...new Set(fens)]

    const db = await build(unique.map((f, i) => entry(f, [{ cp: i - 150, line: 'e2e4' }])))
    expect(db.manifest.records).toBe(unique.length)

    for (const [i, f] of unique.entries()) {
      const r = db.query(f)
      expect(r, `missing ${f}`).not.toBeNull()
      const stored = f.split(' ')[1] === 'w' ? i - 150 : -(i - 150)
      expect(r.lines[0].score.value).toBe(stored)
    }
    expect(db.stats().hits).toBe(unique.length)
    db.close()
  })

  it('writes each bucket in ascending key order', async () => {
    const c = new Chess()
    const fens = []
    for (let i = 0; i < 200; i++) {
      const moves = c.moves()
      if (!moves.length) break
      c.move(moves[i % moves.length])
      fens.push(c.fen().split(' ').slice(0, 4).join(' '))
    }
    const db = await build([...new Set(fens)].map((f) => entry(f, [{ cp: 0, line: 'e2e4' }])))
    db.close()

    for (let i = 0; i < BUCKETS; i++) {
      const buf = readFileSync(bucketPath(dir, i, 'bin'))
      for (let k = 1; k * RECORD_BYTES < buf.length; k++) {
        expect(
          compareKeys(buf, (k - 1) * RECORD_BYTES, buf, k * RECORD_BYTES),
          `bucket ${i} out of order at record ${k}`,
        ).toBeLessThan(0)
      }
    }
  })

  it('counts lines it could not use rather than dropping them silently', async () => {
    const source = join(dir, 'mixed.jsonl.zst')
    const jsonl =
      [
        JSON.stringify(entry(START, [{ cp: 30, line: 'e2e4' }])),
        '{ this is not json',
        JSON.stringify({ fen: AFTER_E4, evals: [{ depth: 9, knodes: 1, pvs: [] }] }),
      ].join('\n') + '\n'
    writeFileSync(source, new Compressor().compress(Buffer.from(jsonl, 'utf8')))

    const r = await scatter(source, dir)
    expect(r).toEqual({ records: 1, unparseable: 1, empty: 1 })
  })

  it('survives a record split across two decompressed chunks', async () => {
    // A 4 MB dump forces the reader across chunk boundaries mid-line; if the
    // carry-over is wrong, entries vanish without any error being raised.
    const many = Array.from({ length: 6000 }, (_, i) => {
      const c = new Chess()
      c.move(c.moves()[i % 20])
      return entry(`${c.fen().split(' ').slice(0, 3).join(' ')} ${i}`.replace(/ \d+$/, ' -'), [
        { cp: i % 500, line: 'e2e4 e7e5 g1f3 b8c6 f1b5 a7a6' },
      ])
    })
    const db = await build(many)
    expect(db.manifest.unparseable).toBe(0)
    expect(db.query(many[0].fen)).not.toBeNull()
    db.close()
  })
})

describe('createEvalDb — refusing a bad index', () => {
  it('explains how to build one when the directory is empty', () => {
    expect(() => createEvalDb({ dir })).toThrow(/no evaluation index/)
  })

  it('fails loudly when a bucket is missing rather than answering "not found"', async () => {
    const db = await build([entry(START, [{ cp: 30, line: 'e2e4' }])])
    db.close()

    // Delete exactly the bucket the start position hashes into, so the query
    // below cannot pass by luck. A truncated index that quietly reports misses
    // reads as "the dump has never seen this position", which is the failure
    // this guards against.
    unlinkSync(bucketPath(dir, bucketOf(keyFor(START)), 'bin'))

    const fresh = createEvalDb({ dir })
    expect(() => fresh.query(START)).toThrow(/incomplete/)
  })
})

afterEach(() => {
  // tmpdir cleanup is best-effort; the OS reclaims it either way.
})
