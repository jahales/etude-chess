import { describe, it, expect } from 'vitest'
import { compareTraps, AGREEMENT_FACTOR } from './replicate.mjs'
import { learnedTotal } from './verifyBook.mjs'

// `compareTraps` decides whether a finding is real. Its contradicted-vs-unseen
// distinction is the whole point of the module — one means "the other month
// looked and disagreed", the other means "the other month never looked" — and it
// was implemented wrongly once already, giving the opposite conclusion.

const trap = (line, trapValue, games = 300) => ({ line, trapValue, games, san: line.split(' ').pop() })

/** A run: its trap list, plus which lines it actually expanded. */
const run = (traps, expandedLines = []) => ({
  report: { traps },
  nodes: Object.fromEntries(
    expandedLines.map((line, i) => [
      `k${i}`,
      { line: line.split(' ').filter(Boolean), games: 500, children: [{ san: 'x' }] },
    ]),
  ),
})

describe('compareTraps', () => {
  it('replicates a finding both runs made at a consistent magnitude', () => {
    const a = run([trap('d4 d5 c4 Bf5', 0.05)])
    const b = run([trap('d4 d5 c4 Bf5', 0.06)])
    const { replicated } = compareTraps(a, b)
    expect(replicated).toHaveLength(1)
    expect(replicated[0].stable).toBe(true)
    expect(replicated[0].games).toBe(600) // combined evidence
  })

  it('marks a finding present in both but wildly different as unstable', () => {
    // Presence alone is not replication: 0.3 in one month and 0.004 in the other
    // is not the same finding twice.
    const a = run([trap('d4 d5 c4 Bf5', 0.3)])
    const b = run([trap('d4 d5 c4 Bf5', 0.3 / (AGREEMENT_FACTOR * 2))])
    expect(compareTraps(a, b).replicated[0].stable).toBe(false)
  })

  it('counts a refutation as contradicted when the other run examined the position', () => {
    const a = run([trap('d4 d5 c4 Bf5', 0.05)])
    const b = run([], ['d4 d5 c4']) // expanded the parent, flagged nothing
    const { contradicted, unseen } = compareTraps(a, b)
    expect(contradicted.map((c) => c.line)).toEqual(['d4 d5 c4 Bf5'])
    expect(unseen).toEqual([])
  })

  it('counts a coverage gap as unseen, not as a refutation', () => {
    const a = run([trap('d4 d5 c4 c6 Nc3 Bf5', 0.05)])
    const b = run([], ['d4 d5 c4']) // never reached the parent of that trap
    const { contradicted, unseen } = compareTraps(a, b)
    expect(unseen.map((u) => u.line)).toEqual(['d4 d5 c4 c6 Nc3 Bf5'])
    expect(contradicted).toEqual([])
  })

  it('treats a node that was expanded but chose nothing as examined', () => {
    // The bug: inferring "expanded" from child count reported a genuine
    // refutation as a coverage gap — the opposite conclusion.
    const a = run([trap('d4 d5 c4 Bf5', 0.05)])
    const b = {
      report: { traps: [] },
      nodes: { k0: { line: ['d4', 'd5', 'c4'], games: 900, children: [] } },
    }
    expect(compareTraps(a, b).contradicted).toHaveLength(1)
    expect(compareTraps(a, b).unseen).toEqual([])
  })

  it('ranks survivors by their weaker side, not their stronger', () => {
    const a = run([trap('x a', 0.9), trap('x b', 0.2)])
    const b = run([trap('x a', 0.01), trap('x b', 0.19)])
    expect(compareTraps(a, b).replicated[0].line).toBe('x b')
  })

  it('handles a run with no traps at all', () => {
    expect(compareTraps(run([]), run([]))).toEqual({
      replicated: [],
      contradicted: [],
      unseen: [],
    })
  })

  it('tolerates a run with no nodes recorded', () => {
    const a = run([trap('d4 d5', 0.05)])
    expect(() => compareTraps(a, { report: { traps: [] } })).not.toThrow()
  })
})

describe('learnedTotal', () => {
  it('treats a scan that read a whole month as ground truth for it', () => {
    expect(learnedTotal({ stoppedAtLimit: false, gamesScanned: 121332 })).toBe(121332)
  })

  it('refuses to learn a total from a scan we cut short', () => {
    // A capped scan's count is what we asked for, not what the month holds —
    // recording it would bake in a wrong ground truth and make the truncation
    // check assert the wrong thing forever.
    expect(learnedTotal({ stoppedAtLimit: true, gamesScanned: 300000 })).toBeUndefined()
  })

  it('learns nothing from a book that never recorded the field', () => {
    expect(learnedTotal({ gamesScanned: 5000 })).toBeUndefined()
    expect(learnedTotal(undefined)).toBeUndefined()
  })
})
