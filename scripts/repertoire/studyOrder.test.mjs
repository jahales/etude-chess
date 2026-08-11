import { describe, it, expect } from 'vitest'
import { Chess } from 'chess.js'
import { scoreDecision } from './studyOrder.mjs'
import { MIN_INDEX_DEPTH } from './soundness.mjs'

const START = new Chess().fen()
const cp = (v) => ({ type: 'cp', value: v })
const pos = (lines, depth = 50) => ({
  lines: lines.map((l, i) => ({ multipv: i + 1, score: l.score, pv: [l.uci] })),
  bestMove: lines[0]?.uci ?? null,
  depth,
  knodes: 1,
})
const db = (table) => ({ query: (fen) => table[fen] ?? null })
const stat = (san, uci, games) => ({ san, uci, white: games, draws: 0, black: 0 })

const BASE = {
  db: db({ [START]: pos([{ uci: 'd2d4', score: cp(30) }, { uci: 'e2e4', score: cp(28) }]) }),
  band: { moves: [stat('e4', 'e2e4', 6000), stat('d4', 'd2d4', 4000)] },
  bandTotal: 10_000,
  minDepth: MIN_INDEX_DEPTH,
}

describe('scoreDecision', () => {
  it('values a decision by reach times cost', () => {
    const r = scoreDecision({ fen: START, uci: 'd2d4' }, BASE)
    expect(r.reach).toBeCloseTo(1, 5) // 10,000 of 10,000 games arrive here
    expect(r.instinct).toBe('e4') // the band's most popular alternative
    expect(r.cost).toBeGreaterThan(0)
    expect(r.value).toBeCloseTo(r.reach * r.cost, 8)
  })

  it('scores a decision at nothing when the natural move is just as good', () => {
    // Every candidate passed the soundness gate, so "our move is fine" is not
    // what makes a decision worth studying — the gap to the instinctive move is.
    const same = {
      ...BASE,
      db: db({ [START]: pos([{ uci: 'd2d4', score: cp(30) }, { uci: 'e2e4', score: cp(30) }]) }),
    }
    expect(scoreDecision({ fen: START, uci: 'd2d4' }, same).value).toBe(0)
  })

  it('never returns a negative cost when our move is the worse of the two', () => {
    const inverted = {
      ...BASE,
      db: db({ [START]: pos([{ uci: 'e2e4', score: cp(90) }, { uci: 'd2d4', score: cp(10) }]) }),
    }
    const r = scoreDecision({ fen: START, uci: 'd2d4' }, inverted)
    expect(r.cost).toBe(0)
    expect(r.value).toBe(0)
  })

  it('falls in proportion to how rarely the position is reached', () => {
    const rare = scoreDecision({ fen: START, uci: 'd2d4' }, { ...BASE, bandTotal: 1_000_000 })
    const common = scoreDecision({ fen: START, uci: 'd2d4' }, BASE)
    expect(rare.value).toBeLessThan(common.value)
    expect(rare.cost).toBe(common.cost)
  })

  it('lets the owner\'s own frequency outweigh the band\'s', () => {
    const mine = scoreDecision({ fen: START, uci: 'd2d4' }, { ...BASE, ownWeight: 4 })
    expect(mine.value).toBeCloseTo(4 * scoreDecision({ fen: START, uci: 'd2d4' }, BASE).value, 8)
  })

  it('picks the most popular alternative as the instinctive move, not the second pv', () => {
    const three = {
      ...BASE,
      band: { moves: [stat('c4', 'c2c4', 100), stat('e4', 'e2e4', 9000), stat('d4', 'd2d4', 900)] },
      db: db({
        [START]: pos([
          { uci: 'd2d4', score: cp(30) },
          { uci: 'c2c4', score: cp(29) },
          { uci: 'e2e4', score: cp(0) },
        ]),
      }),
    }
    // c2c4 is the better alternative by evaluation; e4 is what you would play.
    expect(scoreDecision({ fen: START, uci: 'd2d4' }, three).instinct).toBe('e4')
  })

  it('says why it skipped, rather than scoring on missing data', () => {
    expect(scoreDecision({ fen: START, uci: 'd2d4' }, { ...BASE, band: { moves: [] } }).skipped).toMatch(
      /band book/,
    )
    expect(scoreDecision({ fen: START, uci: 'd2d4' }, { ...BASE, db: db({}) }).skipped).toMatch(
      /not scorable/,
    )
    const onlyOurs = { ...BASE, band: { moves: [stat('d4', 'd2d4', 4000)] } }
    expect(scoreDecision({ fen: START, uci: 'd2d4' }, onlyOurs).skipped).toMatch(/no alternative/)
  })

  it('refuses an index entry shallower than the gate would accept', () => {
    const shallow = {
      ...BASE,
      db: db({
        [START]: pos(
          [{ uci: 'd2d4', score: cp(30) }, { uci: 'e2e4', score: cp(28) }],
          MIN_INDEX_DEPTH - 1,
        ),
      }),
    }
    expect(scoreDecision({ fen: START, uci: 'd2d4' }, shallow).skipped).toMatch(/not scorable/)
  })
})
