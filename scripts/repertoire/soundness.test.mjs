import { describe, it, expect } from 'vitest'
import { Chess } from 'chess.js'
import { MIN_INDEX_DEPTH, createSoundnessGate } from './soundness.mjs'

const START = new Chess().fen()
const AFTER_E4 = (() => {
  const c = new Chess()
  c.move('e4')
  return c.fen()
})()

const cp = (v) => ({ type: 'cp', value: v })
const pos = (lines, depth = 50) => ({
  lines: lines.map((l, i) => ({ multipv: i + 1, score: l.score, pv: [l.uci] })),
  bestMove: lines[0]?.uci ?? null,
  depth,
  knodes: 1,
})
const db = (table) => ({ query: (fen) => table[fen] ?? null })

/** What the local search would have said — deliberately different, so we can see which won. */
const FALLBACK = { swing: 99, depth: 15 }

describe('createSoundnessGate', () => {
  it('uses the local number when there is no index at all', () => {
    const g = createSoundnessGate()
    expect(g.swingFor(START, 'e2e4', FALLBACK)).toEqual({ swing: 99, source: 'local', depth: 15 })
  })

  it('uses the local number when the position is not indexed', () => {
    const g = createSoundnessGate({ evalDb: db({}) })
    expect(g.swingFor(START, 'e2e4', FALLBACK).source).toBe('local')
  })

  it('prefers the multi-pv entry when our move is in it', () => {
    const g = createSoundnessGate({
      evalDb: db({ [START]: pos([{ uci: 'd2d4', score: cp(30) }, { uci: 'e2e4', score: cp(20) }]) }),
    })
    const r = g.swingFor(START, 'e2e4', FALLBACK)
    expect(r.source).toBe('cloud')
    expect(r.method).toBe('multipv')
    expect(r.depth).toBe(50)
    expect(r.swing).toBeGreaterThan(0)
    expect(r.swing).toBeLessThan(10)
  })

  it('scores the best move as zero', () => {
    const g = createSoundnessGate({ evalDb: db({ [START]: pos([{ uci: 'e2e4', score: cp(30) }]) }) })
    expect(g.swingFor(START, 'e2e4', FALLBACK).swing).toBe(0)
  })

  it('falls back to the position after our move when it is outside the pvs', () => {
    const g = createSoundnessGate({
      evalDb: db({
        [START]: pos([{ uci: 'd2d4', score: cp(30) }]),
        [AFTER_E4]: pos([{ uci: 'e7e5', score: cp(200) }]),
      }),
    })
    const r = g.swingFor(START, 'e2e4', FALLBACK)
    expect(r.method).toBe('after')
    // Opponent at +200 after our move means we are at -200: a big concession,
    // not a big gain. A missing negation would show as a swing of 0 here.
    expect(r.swing).toBeGreaterThan(20)
  })

  it('never returns a negative swing', () => {
    const g = createSoundnessGate({
      evalDb: db({
        [START]: pos([{ uci: 'd2d4', score: cp(10) }]),
        [AFTER_E4]: pos([{ uci: 'e7e5', score: cp(-500) }]),
      }),
    })
    expect(g.swingFor(START, 'e2e4', FALLBACK).swing).toBeGreaterThanOrEqual(0)
  })

  it('refuses a shallow index entry rather than mixing depths', () => {
    const g = createSoundnessGate({
      evalDb: db({ [START]: pos([{ uci: 'e2e4', score: cp(30) }], MIN_INDEX_DEPTH - 1) }),
    })
    expect(g.swingFor(START, 'e2e4', FALLBACK).source).toBe('local')
  })

  it('refuses when only one half of the pair is deep enough', () => {
    // Subtracting a depth-50 best from a depth-10 candidate would invent a
    // swing out of depth disagreement, so the whole comparison falls back.
    const g = createSoundnessGate({
      evalDb: db({
        [START]: pos([{ uci: 'd2d4', score: cp(30) }], 50),
        [AFTER_E4]: pos([{ uci: 'e7e5', score: cp(0) }], 10),
      }),
    })
    expect(g.swingFor(START, 'e2e4', FALLBACK).source).toBe('local')
  })

  it('falls back on an illegal candidate instead of throwing', () => {
    const g = createSoundnessGate({ evalDb: db({ [START]: pos([{ uci: 'd2d4', score: cp(30) }]) }) })
    expect(g.swingFor(START, 'e7e5', FALLBACK).source).toBe('local')
  })

  it('counts where its verdicts came from', () => {
    const g = createSoundnessGate({
      evalDb: db({
        [START]: pos([{ uci: 'd2d4', score: cp(30) }, { uci: 'c2c4', score: cp(25) }]),
        [AFTER_E4]: pos([{ uci: 'e7e5', score: cp(-25) }]),
      }),
    })
    g.swingFor(START, 'c2c4', FALLBACK) // multipv
    g.swingFor(START, 'e2e4', FALLBACK) // after
    g.swingFor('8/8/8/4k3/8/8/4K3/8 w - - 0 1', 'e2e3', FALLBACK) // miss
    expect(g.stats()).toEqual({ cloud: 2, local: 1, multipv: 1, after: 1 })
  })
})
