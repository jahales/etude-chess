import { describe, it, expect } from 'vitest'
import { Chess } from 'chess.js'
import { confirmOne } from './confirmFailures.mjs'
import { SOUNDNESS_MAX_SWING } from '../../src/domain/repertoire.ts'

const START = new Chess().fen()
const cp = (v) => ({ type: 'cp', value: v })

/** Stands in for engine.analyse: lines best-first, from the side to move. */
const fakeEngine = (lines, depth = 30) => ({
  analyse: async () => ({
    lines: lines.map((l, i) => ({ multipv: i + 1, score: l.score, pv: [l.uci] })),
    bestMove: lines[0]?.uci ?? null,
    depth,
  }),
})

describe('confirmOne', () => {
  it('clears a move the engine puts within the gate', async () => {
    const engine = fakeEngine([{ uci: 'd2d4', score: cp(30) }, { uci: 'e2e4', score: cp(28) }])
    const r = await confirmOne(engine, { fen: START, uci: 'e2e4' }, { nodes: 1, multipv: 12 })
    expect(r.sound).toBe(true)
    expect(r.swing).toBeLessThan(SOUNDNESS_MAX_SWING)
    expect(r.bestUci).toBe('d2d4')
    expect(r.depth).toBe(30)
  })

  it('confirms a move that stays over the gate', async () => {
    const engine = fakeEngine([{ uci: 'd2d4', score: cp(40) }, { uci: 'e2e4', score: cp(-90) }])
    const r = await confirmOne(engine, { fen: START, uci: 'e2e4' }, { nodes: 1, multipv: 12 })
    expect(r.sound).toBe(false)
    expect(r.swing).toBeGreaterThan(SOUNDNESS_MAX_SWING)
    expect(r.tier).not.toBe('A')
  })

  it('scores the engine\'s own choice as zero', async () => {
    const engine = fakeEngine([{ uci: 'e2e4', score: cp(30) }])
    expect((await confirmOne(engine, { fen: START, uci: 'e2e4' }, { nodes: 1, multipv: 12 })).swing).toBe(0)
  })

  it('reports rather than invents a swing when our move is outside the top N', async () => {
    // Saying "outside the top 12" is evidence; turning it into a number would
    // be making one up, and the report would not be able to tell the two apart.
    const engine = fakeEngine([{ uci: 'd2d4', score: cp(30) }])
    const r = await confirmOne(engine, { fen: START, uci: 'e2e4' }, { nodes: 1, multipv: 12 })
    expect(r.error).toMatch(/outside the engine's top 12/)
    expect(r.swing).toBeUndefined()
    expect(r.bestUci).toBe('d2d4')
  })

  it('reports an engine that returns nothing', async () => {
    const r = await confirmOne(fakeEngine([]), { fen: START, uci: 'e2e4' }, { nodes: 1, multipv: 12 })
    expect(r.error).toMatch(/no lines/)
  })
})
