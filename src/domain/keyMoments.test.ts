import { describe, it, expect } from 'vitest'
import type { PositionEval } from './gameRecord'
import type { Color } from './types'
import { TIER_A_MAX_SWING, TIER_B_MAX_SWING, tierForSwing } from './grade'
import { selectKeyMoments, DEFAULT_KEY_MOMENT_CAP, type KeyMomentsInput } from './keyMoments'

const ev = (whitePct: number): PositionEval => ({ whitePct, label: `${whitePct}` })

// Real SAN so a moment reads like a move; nothing here replays a game.
const SANS = [
  'e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Nf6', 'Ng5', 'd5',
  'exd5', 'Nxd5', 'Nxf7', 'Kxf7', 'Qf3+', 'Ke6', 'Nc3', 'Nce7',
]

/**
 * A game described by **White's win% after each ply**, which is the form a
 * stored analysis holds. `null` is a gap — a position the pass never reached.
 */
function game(
  hero: Color,
  start: number | null,
  after: (number | null)[],
  extra: { firstMover?: Color } = {},
): KeyMomentsInput {
  return {
    heroColor: hero,
    sanHistory: SANS.slice(0, after.length),
    evalByPly: after.map((pct) => (pct === null ? undefined : ev(pct))),
    startEval: start === null ? undefined : ev(start),
    ...extra,
  }
}

describe('selectKeyMoments — what gets picked', () => {
  it('picks the hero move that cost more than Tier B and calls it a blunder', () => {
    // White holds at ply 0, then drops 20 points across ply 2.
    const result = selectKeyMoments(game('w', 50, [50, 50, 30, 30, 28]))

    expect(result.moments).toHaveLength(1)
    expect(result.moments[0]).toMatchObject({ ply: 2, san: 'Nf3', reason: 'blunder', tier: 'C' })
    expect(result.moments[0]?.swing).toBeCloseTo(20, 6)
  })

  it('picks a hero move that cost more than Tier A and calls it a mistake', () => {
    const result = selectKeyMoments(game('w', 50, [50, 50, 40]))

    expect(result.moments).toHaveLength(1)
    expect(result.moments[0]).toMatchObject({ ply: 2, reason: 'mistake', tier: 'B' })
    expect(result.moments[0]?.swing).toBeCloseTo(10, 6)
  })

  it('leaves a Tier A move alone — there is nothing to re-decide', () => {
    // The whole point of the issue: ~26 of ~30 questions a game were these.
    const result = selectKeyMoments(game('w', 50, [46, 46, 42, 42, 38]))

    expect(result.moments).toEqual([])
    expect(result.measured).toBe(3)
  })

  it('uses the tier boundaries from grade.ts rather than a second scale', () => {
    // Just under and just over each boundary. If these thresholds drifted from
    // the coach's, the same move would be a mistake in one place and fine in
    // the other (constitution §9, ADR 0010).
    expect(selectKeyMoments(game('w', 50, [50 - TIER_A_MAX_SWING])).moments).toEqual([])
    expect(selectKeyMoments(game('w', 50, [50 - TIER_A_MAX_SWING - 0.1])).moments[0]?.reason).toBe(
      'mistake',
    )
    expect(selectKeyMoments(game('w', 50, [50 - TIER_B_MAX_SWING])).moments[0]?.reason).toBe(
      'mistake',
    )
    expect(selectKeyMoments(game('w', 50, [50 - TIER_B_MAX_SWING - 0.1])).moments[0]?.reason).toBe(
      'blunder',
    )
  })

  it('reports the tier the swing earns, so severity survives the label', () => {
    const result = selectKeyMoments(game('w', 50, [50, 50, 20, 20, 12]))

    expect(result.moments.map((m) => m.tier)).toEqual(['C', 'B'])
    for (const moment of result.moments) {
      expect(moment.tier).toBe(tierForSwing(moment.swing))
    }
  })

  it('ignores the opponent’s mistakes — this is a list of your decisions', () => {
    // Black hands over 30 at ply 1 and 20 at ply 3; White plays clean.
    const result = selectKeyMoments(game('w', 50, [50, 80, 80, 100]))

    expect(result.moments).toEqual([])
    expect(result.total).toBe(2)
  })

  it('ignores a move that gained ground', () => {
    const result = selectKeyMoments(game('w', 50, [90]))
    expect(result.moments).toEqual([])
  })

  it('finds the hero’s moves when the hero is Black', () => {
    // Black moves on the odd plies; White's win% rising is Black losing ground.
    const result = selectKeyMoments(game('b', 50, [50, 80, 80]))

    expect(result.moments).toHaveLength(1)
    expect(result.moments[0]).toMatchObject({ ply: 1, san: 'e5', reason: 'blunder' })
    expect(result.moments[0]?.swing).toBeCloseTo(30, 6)
    expect(result.total).toBe(1)
  })

  it('honours a game that does not start with White to move', () => {
    // An imported study or endgame can begin on Black's move (#128 keeps the
    // start position). Reading ply parity as "even is White" would quietly
    // select the opponent's moves as the hero's.
    const result = selectKeyMoments(game('b', 50, [80, 80, 80], { firstMover: 'b' }))

    expect(result.moments).toHaveLength(1)
    expect(result.moments[0]).toMatchObject({ ply: 0, reason: 'blunder' })
    expect(result.moments[0]?.swing).toBeCloseTo(30, 6)
  })
})

describe('selectKeyMoments — missed-punish', () => {
  it('labels a mistake made right after the opponent handed something over', () => {
    // Black drops 25 at ply 1 (50 → 75 for White); White gives 10 of it back.
    const result = selectKeyMoments(game('w', 50, [50, 75, 65]))

    expect(result.moments).toHaveLength(1)
    const moment = result.moments[0]!
    expect(moment).toMatchObject({ ply: 2, reason: 'missed-punish' })
    expect(moment.chance).toMatchObject({ ply: 1, san: 'e5' })
    expect(moment.chance?.swing).toBeCloseTo(25, 6)
  })

  it('outranks the plain labels, because the lesson is the one that differs', () => {
    // A 40-point drop is Tier C either way; what this move is *about* is that
    // the position was winning a move earlier.
    const result = selectKeyMoments(game('w', 50, [50, 90, 50]))

    expect(result.moments[0]).toMatchObject({ ply: 2, reason: 'missed-punish', tier: 'C' })
  })

  it('needs the opponent to have given up more than Tier B, not merely erred', () => {
    // Black concedes exactly TIER_B_MAX_SWING: a concession, not a gift.
    const result = selectKeyMoments(game('w', 50, [50, 50 + TIER_B_MAX_SWING, 40]))

    expect(result.moments[0]).toMatchObject({ ply: 2, reason: 'blunder' })
    expect(result.moments[0]?.chance).toBeUndefined()
  })

  it('works on the first reply of the game, which is measured from the start position', () => {
    // Hero is Black: White's ply-0 blunder has no earlier entry to difference
    // against, so without `startEval` it would look unmeasurable and the label
    // would silently fall back to a plain mistake.
    const result = selectKeyMoments(game('b', 50, [20, 45]))

    expect(result.moments[0]).toMatchObject({ ply: 1, reason: 'missed-punish' })
    expect(result.moments[0]?.chance).toMatchObject({ ply: 0, san: 'e4' })
  })

  it('does not claim a gift the analysis never measured', () => {
    // The gap at ply 0 leaves the opponent's ply-1 move unmeasurable. The
    // hero's ply-2 blunder is still measured, and is labelled on its own terms
    // rather than on a guess about what came before it.
    const result = selectKeyMoments(game('w', 50, [null, 75, 55]))

    expect(result.moments).toHaveLength(1)
    expect(result.moments[0]).toMatchObject({ ply: 2, reason: 'blunder' })
    expect(result.moments[0]?.chance).toBeUndefined()
  })

  it('finds the gift by whose move it was, not by ply parity', () => {
    // With `firstMover: 'b'` the hero (Black) moves on the even plies, so the
    // opponent's blunder is at ply 1 and the hero's reply at ply 2.
    const result = selectKeyMoments(game('b', 50, [50, 20, 40], { firstMover: 'b' }))

    expect(result.moments.map((m) => [m.ply, m.reason])).toEqual([[2, 'missed-punish']])
  })
})

describe('selectKeyMoments — sparse evaluations', () => {
  it('skips a move it cannot measure instead of scoring it as 0 swing', () => {
    // The gap at ply 1 makes ply 2 unmeasurable. Filling it in from the nearest
    // reading either way would produce a confident "you played this perfectly"
    // — or a 45-point blunder that never happened.
    const result = selectKeyMoments(game('w', 50, [50, null, 5, 5, 3]))

    expect(result.moments).toEqual([])
    expect(result.measured).toBe(2) // plies 0 and 4; ply 2 is unknown
    expect(result.total).toBe(3)
    expect(result.complete).toBe(false)
  })

  it('still picks the moments it can measure around a gap', () => {
    const result = selectKeyMoments(game('w', 50, [30, null, 30, 30, 10]))

    expect(result.moments.map((m) => m.ply)).toEqual([0, 4])
    expect(result.measured).toBe(2)
    expect(result.total).toBe(3)
  })

  it('treats a missing start evaluation as a gap, not as an even position', () => {
    // Assuming 50 for the start position invents a swing on the first move of
    // every game whose pass began at ply 1.
    const result = selectKeyMoments(game('w', null, [10, 10, 10]))

    expect(result.moments).toEqual([])
    expect(result.measured).toBe(1) // ply 2 only
  })

  it('survives an evaluation array shorter than the game', () => {
    const result = selectKeyMoments({
      heroColor: 'w',
      sanHistory: SANS.slice(0, 6),
      evalByPly: [ev(50), ev(50)],
      startEval: ev(50),
    })

    expect(result.moments).toEqual([])
    expect(result.total).toBe(3)
    expect(result.measured).toBe(1)
  })
})

describe('selectKeyMoments — nothing to say, for two different reasons', () => {
  it('yields no moments and no coverage when the game was never analysed', () => {
    const result = selectKeyMoments({
      heroColor: 'w',
      sanHistory: SANS.slice(0, 6),
      evalByPly: undefined,
    })

    expect(result.moments).toEqual([])
    expect(result.measured).toBe(0)
    expect(result.total).toBe(3)
    expect(result.complete).toBe(false)
  })

  it('yields no moments and full coverage when the hero played clean', () => {
    // Same empty list as above; `measured` is the only thing that tells the
    // caller whether "nothing to study" means "you were fine" or "we haven't
    // looked yet".
    const result = selectKeyMoments(game('w', 50, [50, 50, 48, 48, 47, 47]))

    expect(result.moments).toEqual([])
    expect(result.measured).toBe(3)
    expect(result.total).toBe(3)
    expect(result.complete).toBe(true)
  })

  it('is not "complete" over a game with no hero moves at all', () => {
    // A vacuous 0-of-0 reported as complete would let a caller say "every move
    // you played was measured" about a game you never moved in.
    const result = selectKeyMoments({ heroColor: 'w', sanHistory: [], evalByPly: [] })

    expect(result.moments).toEqual([])
    expect(result.total).toBe(0)
    expect(result.complete).toBe(false)
  })

  it('does not crash on a game with no moves and no evaluations', () => {
    expect(() =>
      selectKeyMoments({ heroColor: 'b', sanHistory: [], evalByPly: undefined }),
    ).not.toThrow()
  })
})

describe('selectKeyMoments — mate', () => {
  it('keeps a swing into mate on the same 0–100 scale as every other move', () => {
    // Evaluations are already win%, where mate is 100/0 — not a centipawn
    // number like 32000, whose raw difference would swamp every real mistake in
    // the game and rank a missed mate-in-12 above the move that lost it.
    const result = selectKeyMoments(game('w', 50, [0]))

    expect(result.moments[0]?.swing).toBe(50)
    expect(Number.isFinite(result.moments[0]?.swing)).toBe(true)
  })

  it('caps a swing out of a won position at 100', () => {
    const result = selectKeyMoments(game('w', 100, [0]))

    expect(result.moments[0]?.swing).toBe(100)
    expect(result.moments[0]?.tier).toBe('C')
  })

  it('scores a move that delivers mate as no loss at all', () => {
    const result = selectKeyMoments(game('w', 80, [100]))

    expect(result.moments).toEqual([])
    expect(result.measured).toBe(1)
  })
})

describe('selectKeyMoments — ordering and the cap', () => {
  // Eight hero moves costing 20, 20, 25, 20, 10, 8, 7 and 6; Black gives back a
  // Tier A 5 each time, so nothing here is a gift and every candidate is one of
  // White's own mistakes.
  const eight = game('w', 95, [
    75, 80, // ply 0: −20
    60, 65, // ply 2: −20
    40, 45, // ply 4: −25
    25, 30, // ply 6: −20
    20, 25, // ply 8: −10
    17, 22, // ply 10: −8
    15, 20, // ply 12: −7
    14, 19, // ply 14: −6
  ])

  it('ranks by what the move cost, biggest first', () => {
    const result = selectKeyMoments(eight, 99)
    const swings = result.moments.map((m) => m.swing)

    expect(swings).toEqual([...swings].sort((a, b) => b - a))
    expect(result.moments[0]?.ply).toBe(4)
  })

  it('breaks a tie by playing order, so the list is stable', () => {
    const result = selectKeyMoments(eight, 99)

    expect(result.moments.filter((m) => m.swing === 20).map((m) => m.ply)).toEqual([0, 2, 6])
  })

  it('caps the list at DEFAULT_KEY_MOMENT_CAP, keeping the worst', () => {
    const result = selectKeyMoments(eight)

    expect(result.moments).toHaveLength(DEFAULT_KEY_MOMENT_CAP)
    expect(result.moments.map((m) => m.ply)).toEqual([4, 0, 2, 6, 8, 10])
  })

  it('reports coverage over the whole game, not over the capped list', () => {
    // The cap is a session-length decision; it must not make the game look less
    // measured than it was.
    const result = selectKeyMoments(eight, 2)

    expect(result.moments).toHaveLength(2)
    expect(result.measured).toBe(8)
    expect(result.total).toBe(8)
    expect(result.complete).toBe(true)
  })

  it('takes an explicit cap', () => {
    expect(selectKeyMoments(eight, 3).moments).toHaveLength(3)
    expect(selectKeyMoments(eight, 0).moments).toEqual([])
  })

  it('treats a nonsensical cap as none, never as "drop the worst one"', () => {
    // `slice(0, -1)` would quietly return everything but the last moment.
    expect(selectKeyMoments(eight, -1).moments).toEqual([])
  })
})
