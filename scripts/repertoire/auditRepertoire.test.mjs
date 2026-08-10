import { describe, it, expect } from 'vitest'
import { Chess } from 'chess.js'
import { auditDeck, gradeDecision } from './auditRepertoire.mjs'
import { SOUNDNESS_MAX_SWING } from '../../src/domain/repertoire.ts'

// The audit's whole job is a subtraction, and every way of getting it wrong
// produces a full-looking report rather than an error: a sign flip turns the
// best move into the worst, and scoring the position after our move without
// negating grades us on the opponent's chances.

const START = new Chess().fen()
const after = (sans) => {
  const c = new Chess()
  for (const s of sans) c.move(s)
  return c.fen()
}

/** A stand-in for evalDb: FEN -> the object createEvalDb.query returns. */
const fakeDb = (table) => ({
  query: (fen) => table[fen] ?? null,
})

const line = (uci, cp) => ({ multipv: 1, score: { type: 'cp', value: cp }, pv: [uci] })
const position = (lines, depth = 50, knodes = 2_800_000) => ({
  lines: lines.map((l, i) => ({ ...l, multipv: i + 1 })),
  bestMove: lines[0].pv[0],
  depth,
  knodes,
  source: 'cloud',
})

describe('gradeDecision — our move is in the multi-pv list', () => {
  const db = fakeDb({
    [START]: position([line('e2e4', 30), line('d2d4', 20), line('c2c4', -60)]),
  })

  it('scores the best move as a zero swing', () => {
    const g = gradeDecision({ fen: START, fenAfter: 'x', uci: 'e2e4' }, db)
    expect(g.covered).toBe(true)
    expect(g.method).toBe('multipv')
    expect(g.swing).toBe(0)
    expect(g.tier).toBe('A')
    expect(g.sound).toBe(true)
  })

  it('scores a slightly worse move as a small positive swing', () => {
    const g = gradeDecision({ fen: START, fenAfter: 'x', uci: 'd2d4' }, db)
    expect(g.swing).toBeGreaterThan(0)
    expect(g.swing).toBeLessThan(SOUNDNESS_MAX_SWING)
    expect(g.sound).toBe(true)
    expect(g.bestUci).toBe('e2e4')
  })

  it('fails a move that concedes more than the gate allows', () => {
    const g = gradeDecision({ fen: START, fenAfter: 'x', uci: 'c2c4' }, db)
    expect(g.swing).toBeGreaterThan(SOUNDNESS_MAX_SWING)
    expect(g.sound).toBe(false)
    expect(g.tier).not.toBe('A')
  })

  it('never reports a negative swing', () => {
    for (const uci of ['e2e4', 'd2d4', 'c2c4']) {
      expect(gradeDecision({ fen: START, fenAfter: 'x', uci }, db).swing).toBeGreaterThanOrEqual(0)
    }
  })

  it('carries the depth the verdict rests on', () => {
    expect(gradeDecision({ fen: START, fenAfter: 'x', uci: 'e2e4' }, db).depth).toBe(50)
  })
})

describe('gradeDecision — our move is outside the stored pvs', () => {
  const AFTER_E4 = after(['e4'])

  it('falls back to the position after our move, negated', () => {
    // Best here is +30 for us. After our move the *opponent* is +200, i.e. we
    // are -200 — a large concession. Without the negation this would read as a
    // huge improvement instead.
    const db = fakeDb({
      [START]: position([line('d2d4', 30), line('c2c4', 25)]),
      [AFTER_E4]: position([line('e7e5', 200)]),
    })
    const g = gradeDecision({ fen: START, fenAfter: AFTER_E4, uci: 'e2e4' }, db)
    expect(g.method).toBe('after')
    expect(g.ourScore).toEqual({ type: 'cp', value: -200 })
    expect(g.swing).toBeGreaterThan(SOUNDNESS_MAX_SWING)
    expect(g.sound).toBe(false)
  })

  it('passes a move that is fine but simply not in the top five', () => {
    const db = fakeDb({
      [START]: position([line('d2d4', 30), line('c2c4', 28)]),
      [AFTER_E4]: position([line('e7e5', -28)]),
    })
    const g = gradeDecision({ fen: START, fenAfter: AFTER_E4, uci: 'e2e4' }, db)
    expect(g.method).toBe('after')
    expect(g.ourScore).toEqual({ type: 'cp', value: 28 })
    expect(g.sound).toBe(true)
  })

  it('takes the shallower of the two depths, since the pair is only as good as its weaker half', () => {
    const db = fakeDb({
      [START]: position([line('d2d4', 30)], 50),
      [AFTER_E4]: position([line('e7e5', -30)], 28),
    })
    expect(gradeDecision({ fen: START, fenAfter: AFTER_E4, uci: 'e2e4' }, db).depth).toBe(28)
  })

  it('handles a mate score without treating it as centipawns', () => {
    const db = fakeDb({
      [START]: position([line('d2d4', 30)]),
      [AFTER_E4]: {
        lines: [{ multipv: 1, score: { type: 'mate', value: 3 }, pv: ['d8h4'] }],
        bestMove: 'd8h4',
        depth: 50,
        knodes: 1,
        source: 'cloud',
      },
    })
    const g = gradeDecision({ fen: START, fenAfter: AFTER_E4, uci: 'e2e4' }, db)
    // Mated in 3 after our move: 0 win% for us, so the swing is nearly the whole scale.
    expect(g.ourScore).toEqual({ type: 'mate', value: -3 })
    expect(g.swing).toBeGreaterThan(50)
    expect(g.tier).toBe('C')
  })
})

describe('gradeDecision — gaps', () => {
  it('reports a position the dump has never seen rather than scoring it', () => {
    const g = gradeDecision({ fen: START, fenAfter: 'x', uci: 'e2e4' }, fakeDb({}))
    expect(g.covered).toBe(false)
    expect(g.reason).toMatch(/not in index/)
    expect(g.swing).toBeUndefined()
  })

  it('reports when only the after-position is missing', () => {
    const db = fakeDb({ [START]: position([line('d2d4', 30)]) })
    const g = gradeDecision({ fen: START, fenAfter: after(['e4']), uci: 'e2e4' }, db)
    expect(g.covered).toBe(false)
    expect(g.reason).toMatch(/outside the stored pvs/)
    expect(g.bestUci).toBe('d2d4')
  })

  it('treats an empty line list as no coverage', () => {
    const db = fakeDb({ [START]: { lines: [], bestMove: null, depth: 0, knodes: 0 } })
    expect(gradeDecision({ fen: START, fenAfter: 'x', uci: 'e2e4' }, db).covered).toBe(false)
  })
})

describe('auditDeck', () => {
  it('grades a whole deck and separates covered from gaps', async () => {
    const { mkdtempSync, writeFileSync, mkdirSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')

    const root = mkdtempSync(join(tmpdir(), 'audit-'))
    mkdirSync(join(root, 'repertoire'), { recursive: true })
    writeFileSync(
      join(root, 'repertoire', 'deck.pgn'),
      '[Event "t"]\n[Orientation "white"]\n[Result "*"]\n\n1. e4 e5 2. Nf3 *\n',
    )

    const afterE4 = after(['e4'])
    const posE4E5 = after(['e4', 'e5'])
    const db = fakeDb({
      [START]: position([line('e2e4', 30), line('d2d4', 25)]),
      [posE4E5]: position([line('g1f3', 35), line('f1c4', 30)]),
      [afterE4]: position([line('e7e5', -30)]),
    })

    const r = auditDeck({ id: 'test', file: 'repertoire/deck.pgn' }, db, root)
    expect(r.decisions).toBe(2)
    expect(r.covered).toBe(2)
    expect(r.failures).toEqual([])
    expect(r.tiers.A).toBe(2)
    expect(r.byMethod.multipv).toBe(2)
    expect(r.conflicts).toEqual([])
    expect(r.depth.median).toBe(50)
  })
})
