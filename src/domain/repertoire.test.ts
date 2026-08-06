import { describe, it, expect } from 'vitest'
import { TIER_A_MAX_SWING } from './grade'
import {
  coverByMass,
  frequency,
  gamesFor,
  isTrap,
  ourMoveScore,
  outperformance,
  practicalScore,
  quietness,
  rankOurMoves,
  soundCandidates,
  totalGames,
  trapValue,
  QUIET_BREADTH_WINDOW,
  TRAP_MIN_SWING,
  type MoveStats,
  type OurMoveCandidate,
  type TrapInput,
} from './repertoire'

const stats = (san: string, white: number, draws: number, black: number): MoveStats => ({
  san,
  uci: san.toLowerCase(),
  white,
  draws,
  black,
})

describe('move statistics', () => {
  it('counts games and shares across a node', () => {
    const moves = [stats('d5', 60, 20, 20), stats('Nf6', 15, 5, 5)]
    expect(gamesFor(moves[0]!)).toBe(100)
    expect(totalGames(moves)).toBe(125)
    expect(frequency(moves[0]!, 125)).toBeCloseTo(0.8)
  })

  it('scores from the perspective of whoever played the move', () => {
    const m = stats('e5', 30, 20, 50) // White won 30, drew 20, lost 50
    expect(practicalScore(m, 'w')).toBeCloseTo(0.4)
    expect(practicalScore(m, 'b')).toBeCloseTo(0.6)
  })

  it('treats an unplayed move as scoreless rather than dividing by zero', () => {
    expect(practicalScore(stats('a3', 0, 0, 0), 'w')).toBe(0)
    expect(frequency(stats('a3', 0, 0, 0), 0)).toBe(0)
  })
})

describe('coverByMass', () => {
  const moves = [
    stats('e6', 400, 100, 200), // 700
    stats('c6', 150, 50, 100), // 300
    stats('dxc4', 100, 20, 80), // 200
    stats('Nf6', 40, 10, 30), // 80
    stats('e5', 5, 1, 4), // 10 — below minGames
  ]

  it('covers moves in frequency order until the mass target is met', () => {
    // e6+c6 is only 1000/1290 ≈ 0.775, short of 0.8, so dxc4 is pulled in too.
    const r = coverByMass(moves, { massTarget: 0.8, minGames: 20 })
    expect(r.covered.map((m) => m.san)).toEqual(['e6', 'c6', 'dxc4'])
    expect(r.mass).toBeCloseTo(1200 / 1290)
  })

  it('takes more moves when the target is higher', () => {
    const r = coverByMass(moves, { massTarget: 0.95, minGames: 20 })
    expect(r.covered.map((m) => m.san)).toEqual(['e6', 'c6', 'dxc4', 'Nf6'])
  })

  it('never covers noise on frequency grounds — traps get in another way', () => {
    const r = coverByMass(moves, { massTarget: 1, minGames: 20 })
    expect(r.covered.map((m) => m.san)).not.toContain('e5')
    expect(r.skipped.map((m) => m.san)).toContain('e5')
  })

  it('reports truncation rather than silently dropping lines', () => {
    const r = coverByMass(moves, { massTarget: 0.99, minGames: 1, maxMoves: 2 })
    expect(r.truncated).toBe(true)
    expect(r.skipped).toHaveLength(3)
    expect(r.covered).toHaveLength(2)
  })

  it('is not truncated when the target is genuinely reached', () => {
    const r = coverByMass(moves, { massTarget: 0.5, minGames: 20, maxMoves: 6 })
    expect(r.truncated).toBe(false)
  })

  it('survives an empty node', () => {
    const r = coverByMass([])
    expect(r).toMatchObject({ covered: [], mass: 0, truncated: false })
  })
})

describe('trapValue', () => {
  const base: TrapInput = {
    frequency: 0.03,
    swing: 25,
    practical: 0.45,
    expected: 0.3,
    games: 400,
  }

  it('scores a bad move that overperforms — the line worth preparing', () => {
    // Played 3% of the time, gives up 25 win%, yet scores .45 where .30 is deserved.
    expect(trapValue(base)).toBeGreaterThan(0)
    // Positive, but below the raw .15 gap: even 400 games are shrunk a little.
    expect(outperformance(base)).toBeGreaterThan(0.1)
    expect(outperformance(base)).toBeLessThan(0.15)
  })

  it('ignores a bad move that people already punish', () => {
    // Same frequency and same evaluation loss, but it actually loses in practice.
    expect(trapValue({ ...base, practical: 0.22 })).toBe(0)
  })

  it('ignores a sound main line however popular', () => {
    expect(
      trapValue({ frequency: 0.6, swing: 2, practical: 0.55, expected: 0.5, games: 5000 }),
    ).toBe(0)
  })

  it('ignores an inaccuracy just below the trap threshold', () => {
    expect(trapValue({ ...base, swing: TRAP_MIN_SWING - 0.01 })).toBe(0)
    expect(trapValue({ ...base, swing: TRAP_MIN_SWING })).toBeGreaterThan(0)
  })

  it('gates on Tier A, so the two cannot drift apart', () => {
    expect(TRAP_MIN_SWING).toBe(TIER_A_MAX_SWING)
  })

  it('catches a club gambit that is only mildly unsound but overperforms', () => {
    // The Albin at 1500–1900: ~3.9% of replies to 2.c4, gives up roughly 5 win%,
    // and still scores 50.9% where ~42% is deserved, over 511 games. A higher
    // gate would throw away the whole gambit family — the material most worth
    // studying at this level.
    const albin = { frequency: 0.039, swing: 5.5, practical: 0.509, expected: 0.42, games: 511 }
    expect(trapValue(albin)).toBeGreaterThan(0)
  })

  it('refuses to call a six-game fluke a trap', () => {
    // Straight from the first real run: this outranked everything else at 1.76
    // on five wins from six games. Small samples produce enormous apparent
    // outperformance and will dominate any unguarded ranking.
    const fluke = { frequency: 0.3, swing: 10.9, practical: 0.83, expected: 0.3, games: 6 }
    expect(trapValue(fluke)).toBe(0)
  })

  it('prefers the better-evidenced of two findings that look identical', () => {
    // The honest property. A thin sample with a *huge* gap can legitimately
    // outrank a well-sampled small edge — that is what the hard floor is for,
    // not shrinkage. What shrinkage guarantees is this: same observed numbers,
    // more evidence, higher score.
    const shared = { frequency: 0.1, swing: 10, practical: 0.55, expected: 0.4 }
    expect(trapValue({ ...shared, games: 800 })).toBeGreaterThan(
      trapValue({ ...shared, games: 60 }),
    )
  })

  it('leaves a well-sampled score almost unshrunk', () => {
    const raw = 0.47 - 0.4
    const shrunk = outperformance({
      frequency: 0.16,
      swing: 6.5,
      practical: 0.47,
      expected: 0.4,
      games: 317,
    })
    // 317 games against a 100-game prior keeps ~76% of the observed gap.
    expect(shrunk).toBeGreaterThan(raw * 0.7)
    expect(shrunk).toBeLessThan(raw)
  })

  it('collapses a thin score toward what the evaluation deserves', () => {
    const shrunk = outperformance({
      frequency: 0.3,
      swing: 10.9,
      practical: 0.83,
      expected: 0.3,
      games: 6,
    })
    expect(shrunk).toBeLessThan(0.53 * 0.25) // raw gap was 0.53
  })

  it('ranks the more common of two equally unsound traps higher', () => {
    const rare = trapValue({ ...base, frequency: 0.01 })
    const common = trapValue({ ...base, frequency: 0.08 })
    expect(common).toBeGreaterThan(rare)
  })

  it('ranks the more punishing of two equally common traps higher', () => {
    const mild = trapValue({ ...base, swing: 12 })
    const severe = trapValue({ ...base, swing: 40 })
    expect(severe).toBeGreaterThan(mild)
  })

  it('gates coverage on a threshold', () => {
    expect(isTrap(base, 0.05)).toBe(true)
    expect(isTrap(base, 5)).toBe(false)
  })
})

describe('quietness', () => {
  const quiet = { multipv: [52, 50, 49, 45], shallow: 51, deep: 52 }

  it('accepts a balanced position with several playable moves and no tactic', () => {
    const q = quietness(quiet)
    expect(q.quiet).toBe(true)
    expect(q.breadth).toBe(3) // 52, 50, 49 are within 5 of best; 45 is not
    expect(q.reasons).toEqual([])
  })

  it('rejects a position with only one good move — that is a sequence, not a decision', () => {
    const q = quietness({ ...quiet, multipv: [60, 40, 38, 30] })
    expect(q.quiet).toBe(false)
    expect(q.breadth).toBe(1)
    expect(q.reasons.join(' ')).toMatch(/playable move/)
  })

  it('rejects a position where the deep search changed its mind', () => {
    // Constitution §6: shallow/deep disagreement means a tactic is hiding.
    const q = quietness({ ...quiet, shallow: 50, deep: 85 })
    expect(q.quiet).toBe(false)
    expect(q.tacticGap).toBeCloseTo(35)
    expect(q.reasons.join(' ')).toMatch(/tactic hiding/)
  })

  it('rejects a position that is already decided', () => {
    const q = quietness({ multipv: [90, 88, 87], shallow: 89, deep: 90 })
    expect(q.quiet).toBe(false)
    expect(q.reasons.join(' ')).toMatch(/already decided/)
  })

  it('collects every failing reason at once', () => {
    const q = quietness({ multipv: [95, 20, 10], shallow: 40, deep: 95 })
    expect(q.reasons).toHaveLength(3)
  })

  it('handles an empty MultiPV without throwing', () => {
    expect(quietness({ multipv: [], shallow: 50, deep: 50 }).breadth).toBe(0)
  })

  it('uses the same "also playable" window as Tier A, so the two cannot drift', () => {
    expect(QUIET_BREADTH_WINDOW).toBe(TIER_A_MAX_SWING)
  })
})

describe('rankOurMoves', () => {
  const candidate = (
    san: string,
    swing: number,
    replyBranching: number,
    freq: number,
  ): OurMoveCandidate => ({
    move: stats(san, 1, 1, 1),
    swing,
    replyBranching,
    frequency: freq,
  })

  it('drops candidates outside the soundness gate', () => {
    const cands = [candidate('c4', 1, 4, 0.5), candidate('h4', 30, 2, 0.01)]
    expect(soundCandidates(cands).map((c) => c.move.san)).toEqual(['c4'])
    expect(rankOurMoves(cands).map((c) => c.move.san)).toEqual(['c4'])
  })

  it('prefers the narrower line when two moves are equally sound and popular', () => {
    const wide = candidate('Nf3', 0, 8, 0.4)
    const narrow = candidate('cxd5', 0, 2, 0.4)
    expect(rankOurMoves([wide, narrow])[0]!.move.san).toBe('cxd5')
  })

  it('lets branching outweigh a small evaluation edge — the learnability trade', () => {
    const sharper = candidate('Bg5', 0, 9, 0.5) // best move, nine replies to learn
    const simpler = candidate('cxd5', 3, 2, 0.5) // 3 win% worse, two replies
    expect(rankOurMoves([sharper, simpler])[0]!.move.san).toBe('cxd5')
  })

  it('breaks a branching tie on popularity at our band', () => {
    const rare = candidate('a3', 0, 3, 0.02)
    const common = candidate('c4', 0, 3, 0.6)
    expect(rankOurMoves([rare, common])[0]!.move.san).toBe('c4')
  })

  it('scores within 0–1 so the crawler can report it directly', () => {
    const s = ourMoveScore(candidate('c4', 0, 0, 1))
    expect(s).toBeGreaterThan(0)
    expect(s).toBeLessThanOrEqual(1)
  })
})
