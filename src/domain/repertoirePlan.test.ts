import { describe, it, expect } from 'vitest'
import manifest from '../../scripts/repertoire/manifest.v1.json'
import e4Manifest from '../../scripts/repertoire/manifest.e4.json'
import {
  delegationsFor,
  isOurPly,
  plies,
  sumLoads,
  theoryLoad,
  validatePlan,
  type PlanEntry,
} from './repertoirePlan'

const entry = (id: string, line: string, color: 'w' | 'b' = 'w'): PlanEntry => ({
  id,
  name: id,
  color,
  line,
})

describe('plies / isOurPly', () => {
  it('splits a SAN line and tolerates ragged spacing', () => {
    expect(plies('  d4   d5 c4 ')).toEqual(['d4', 'd5', 'c4'])
    expect(plies('')).toEqual([])
  })

  it('knows whose move each ply is', () => {
    expect([0, 1, 2, 3].map((i) => isOurPly(i, 'w'))).toEqual([true, false, true, false])
    expect([0, 1, 2, 3].map((i) => isOurPly(i, 'b'))).toEqual([false, true, false, true])
  })
})

describe('delegationsFor', () => {
  const entries = [
    entry('d4-sidelines', 'd4'),
    entry('qg-sidelines', 'd4 d5 c4'),
    entry('qgd-exchange', 'd4 d5 c4 e6 cxd5'),
    entry('qga', 'd4 d5 c4 dxc4 e3'),
    entry('dutch', 'd4 f5 g3'),
  ]

  it('stops a branch one ply past its own prefix, where the two could first disagree', () => {
    expect([...delegationsFor(entries[1]!, entries)]).toEqual([
      ['d4 d5 c4 e6', 'qgd-exchange'],
      ['d4 d5 c4 dxc4', 'qga'],
    ])
  })

  it('hands ownership to the shortest branch reaching through the point', () => {
    // From `d4`, 1...d5 belongs to the Queen's Gambit sweeper — not to the QGD
    // Exchange buried underneath it, which would skip 2...dxc4 entirely.
    expect(delegationsFor(entries[0]!, entries).get('d4 d5')).toBe('qg-sidelines')
    expect(delegationsFor(entries[0]!, entries).get('d4 f5')).toBe('dutch')
  })

  it('never delegates its own root, however deep another branch runs', () => {
    for (const e of entries) {
      expect([...delegationsFor(e, entries).keys()]).not.toContain(e.line)
    }
  })

  it('a leaf branch owns everything below it', () => {
    expect([...delegationsFor(entries[2]!, entries)]).toEqual([])
  })

  it('does not delegate across colours', () => {
    // Two repertoires that happen to share notation: our Slav as Black and the
    // Queen's Gambit as White reach the same moves and must not truncate
    // each other.
    const mixed = [entry('slav-white', 'd4 d5 c4 c6 Nf3', 'w'), entry('slav', 'd4 d5 c4 c6', 'b')]
    expect([...delegationsFor(mixed[1]!, mixed)]).toEqual([])
    expect([...delegationsFor(mixed[0]!, mixed)]).toEqual([])
  })

  it('is unaffected by a branch that merely shares a prefix without extending it', () => {
    const siblings = [entry('a', 'd4 d5 c4 e6'), entry('b', 'd4 d5 c4 c6')]
    expect([...delegationsFor(siblings[0]!, siblings)]).toEqual([])
  })
})

describe('validatePlan — coverage gaps', () => {
  it('accepts a boundary the owner only extends with our own moves', () => {
    // `d4` hands 1...d5 to a branch that opens 2.c4. Nothing is skipped: 2.c4 is
    // a move we were going to choose anyway.
    expect(validatePlan([entry('d4-sidelines', 'd4'), entry('qg', 'd4 d5 c4')])).toEqual([])
  })

  it('rejects a boundary whose owner assumes an opponent move', () => {
    // The real one this check was written for. Handing the whole 2.d4 complex to
    // a branch opening `2.d4 d5 3.e5` silently drops 3.Nc3, 3.Nd2 and 3.exd5 —
    // a repertoire that looks complete and has no answer to the main line.
    const problems = validatePlan([
      entry('caro', 'e4 c6', 'b'),
      entry('caro-advance', 'e4 c6 d4 d5 e5 Bf5', 'b'),
    ])
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatchObject({ entryId: 'caro' })
    expect(problems[0]!.message).toContain('e5')
    // and it names the entry that would close the hole
    expect(problems[0]!.message).toContain('"e4 c6 d4 d5"')
  })

  it('is satisfied once the missing intermediate branch exists', () => {
    expect(
      validatePlan([
        entry('caro', 'e4 c6', 'b'),
        entry('caro-2d4', 'e4 c6 d4 d5', 'b'),
        entry('caro-advance', 'e4 c6 d4 d5 e5 Bf5', 'b'),
      ]),
    ).toEqual([])
  })

  it('reports a duplicate id', () => {
    const problems = validatePlan([entry('a', 'd4'), entry('a', 'e4')])
    expect(problems).toHaveLength(1)
    expect(problems[0]!.message).toContain('duplicate id')
  })

  it('reports two branches with the same colour and line', () => {
    const problems = validatePlan([entry('a', 'd4 d5 c4'), entry('b', 'd4 d5 c4')])
    expect(problems.some((p) => p.message.includes('decides nothing'))).toBe(true)
  })

  it('allows the same line for opposite colours', () => {
    expect(validatePlan([entry('a', 'd4 d5 c4 c6', 'w'), entry('b', 'd4 d5 c4 c6', 'b')])).toEqual([])
  })
})

describe('the shipped manifest', () => {
  // Not a style check: a gap here is a hole in the repertoire the owner would
  // meet across the board, and the whole manifest is validated before an hour
  // of engine time is spent on it.
  const entries = manifest.entries as PlanEntry[]

  it('has no coverage gaps', () => {
    expect(validatePlan(entries)).toEqual([])
  })

  it('covers both colours', () => {
    const colors = new Set(entries.map((e) => e.color))
    expect([...colors].sort()).toEqual(['b', 'w'])
  })

  it('says why every branch is in the repertoire', () => {
    // The `why` becomes the comment before the first move, so a drill can say
    // what it is drilling. A branch nobody can justify should not be here.
    for (const e of entries) expect(e.why, e.id).toBeTruthy()
  })

  it('answers 1.d4, 1.e4, 1.c4 and 1.Nf3 by name, and the rest from the root', () => {
    // This used to assert the set was *exactly* those four, which quietly said
    // "a Black branch is always rooted at one named first move". That was the
    // bug: it made having no answer to 1.b3 look like a satisfied invariant.
    const blackRoots = entries.filter((e) => e.color === 'b').map((e) => plies(e.line)[0])
    expect(new Set(blackRoots.filter(Boolean))).toEqual(new Set(['e4', 'd4', 'c4', 'Nf3']))
    expect(blackRoots.filter((m) => m === undefined)).toHaveLength(1)
  })
})

describe('theoryLoad', () => {
  const nodes = [
    { ours: true, ply: 2, children: [{}] },
    { ours: false, ply: 3, children: [{}, {}, {}] },
    { ours: true, ply: 4, children: [], terminal: true, terminalReason: 'quiet' },
    { ours: false, ply: 5, children: [], terminal: true, terminalReason: 'delegated' },
    { ours: true, ply: 6, children: [], terminal: true, terminalReason: 'out-of-book' },
  ]

  it('counts what there is to memorise and what it answers', () => {
    expect(theoryLoad(nodes)).toEqual({
      ourDecisions: 1,
      preparedReplies: 3,
      quietTargets: 1,
      delegated: 1,
      outOfBook: 1,
      deepestPly: 6,
    })
  })

  it('does not count a position where we have nothing left to decide', () => {
    // A terminal node of ours is the item to train, not a move to recall.
    expect(theoryLoad([{ ours: true, children: [] }]).ourDecisions).toBe(0)
  })

  it('handles an empty crawl', () => {
    expect(theoryLoad([])).toMatchObject({ ourDecisions: 0, deepestPly: 0 })
  })
})

describe('theoryLoad — the aggregate keeps every field', () => {
  it('sums all six, so summary.load is the same shape as a branch load', () => {
    const a = theoryLoad([{ ours: true, ply: 3, children: [{}], terminalReason: 'delegated' }])
    const b = theoryLoad([{ ours: false, ply: 7, children: [{}, {}], terminalReason: 'out-of-book' }])
    expect(sumLoads([a, b])).toEqual({
      ourDecisions: 1,
      preparedReplies: 2,
      quietTargets: 0,
      delegated: 1,
      outOfBook: 1,
      deepestPly: 7,
    })
  })

  it('takes the deepest ply rather than adding them', () => {
    expect(sumLoads([theoryLoad([{ ply: 4 }]), theoryLoad([{ ply: 9 }])]).deepestPly).toBe(9)
  })

  it('sums nothing to a zero load', () => {
    expect(sumLoads([])).toEqual(theoryLoad([]))
  })
})

describe('the tail of the opening — the moves nothing else owns', () => {
  // Both holes below were found by replaying the owner's own chess.com games
  // against the shipped PGN (2026-08-07): 11% of their games as White and 2% as
  // Black reached a position the repertoire had no answer for at all. Neither
  // showed up as a gap in `validatePlan`, because a branch that silently covers
  // fewer replies than it claims is not a *contradiction* — it is just quiet.
  const entries = manifest.entries as PlanEntry[]

  it('roots a Black branch at the initial position, so 1.Nc3 and 1.b3 are answered', () => {
    const root = entries.filter((e) => e.color === 'b' && plies(e.line).length === 0)
    expect(root).toHaveLength(1)
    // A signpost, and measured rather than assumed: run as a sweeper it cost 38
    // decisions to answer 2% of the owner's games — 11% of the repertoire's
    // whole memorisation budget — because massTarget buys breadth at every ply,
    // not just the root one it was raised for. The decision here is the first
    // move; everything after transposes into what the curated branches teach.
    expect(root[0]?.role).toBe('signpost')
  })

  it('hands that root branch every first move a real branch owns, and keeps the rest', () => {
    const root = entries.find((e) => e.color === 'b' && plies(e.line).length === 0)!
    expect([...delegationsFor(root, entries).keys()].sort()).toEqual(['Nf3', 'c4', 'd4', 'e4'])
  })

  it('lets the 1.d4 sweeper cover more replies than a curated branch would', () => {
    // DEFAULT_MAX_MOVES is 6 and DEFAULT_MASS_TARGET 0.85. After 1.d4 the mass
    // is eaten by 1...d5 and 1...Nf6 — which this branch hands *away* — so the
    // budget ran out before 1...c5 and 1...d6, the replies it exists to catch.
    const sweeper = entries.find((e) => e.id === 'd4-sidelines')!
    expect(sweeper.maxOpponentMoves ?? 6).toBeGreaterThan(6)
    expect(sweeper.massTarget ?? 0.85).toBeGreaterThan(0.85)
  })
})

describe('the 1.e4 manifest', () => {
  // A second White repertoire, shipped separately so it is an alternative to the
  // Queen's Gambit rather than more cards in the same deck.
  const entries = e4Manifest.entries as PlanEntry[]

  it('has no coverage gaps', () => {
    expect(validatePlan(entries)).toEqual([])
  })

  it('is White-only — the Black repertoire is shared, not duplicated', () => {
    expect([...new Set(entries.map((e) => e.color))]).toEqual(['w'])
  })

  it('names a branch for each reply that carries real weight in the band', () => {
    // Measured over 231,700 games at Lichess 1300–1800: 1...e5 44.7%, 1...c5
    // 15.3%, 1...d5 10.0%, 1...e6 9.7%, 1...c6 8.4% — 88% between them. Note
    // 1...d5 outranks both the French and the Caro-Kann here, which is the
    // opposite of master practice and the reason this list is measured.
    const seconds = new Set(
      entries.map((e) => plies(e.line)[1]).filter((m): m is string => Boolean(m)),
    )
    for (const reply of ['e5', 'c5', 'd5', 'e6', 'c6']) expect(seconds, reply).toContain(reply)
  })

  it('sweeps the tail from 1.e4 with a raised budget', () => {
    // The five replies above are delegated and carry 88% of the mass, so the
    // default budget would be spent entirely on moves this branch hands away —
    // the failure that left 1...c5 unanswered in the 1.d4 sweeper.
    const root = entries.find((e) => e.line === 'e4')
    expect(root?.role).toBe('sweeper')
    expect(root?.maxOpponentMoves ?? 6).toBeGreaterThan(6)
  })
})
