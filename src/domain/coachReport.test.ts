import { describe, it, expect } from 'vitest'
import {
  BASELINE_Z,
  MIN_MOVES_FOR_RATE,
  bucketsBy,
  byColor,
  byPhase,
  byPieceMoved,
  byPieces,
  bySeconds,
  byBestForcing,
  byTimeClass,
  describeSample,
  isError,
  pieceMatchBaseline,
  thinkTime,
  timeClassesIn,
  type CoachMove,
} from './coachReport'

// The three things this module exists to get right, and the three things the
// hand-run of 2026-08-15 got wrong first:
//
//   1. rank by total win% given away, not by error rate
//   2. read a bucket's share of the loss against its share of the moves
//   3. never pool time controls
//
// Plus `pieceMatchBaseline`, which is the reason the whole feature exists: it is
// what turned "82% of his errors moved the wrong piece" from a coaching
// conclusion back into a coincidence.

const move = (over: Partial<CoachMove> = {}): CoachMove => ({
  gameId: 'g1',
  timeClass: 'rapid',
  color: 'w',
  result: 'win',
  eco: null,
  moveNumber: 20,
  phase: 'middlegame',
  san: 'Nf3',
  best: 'Nf3',
  swing: 0,
  tier: 'A',
  forcingPlayed: false,
  forcingBest: false,
  piece: 'n',
  samePiece: true,
  legalMoves: 30,
  movablePieces: 9,
  bestPieceMoves: 5,
  pieces: 24,
  seconds: 10,
  ...over,
})

const many = (n: number, over: Partial<CoachMove> = {}) => Array.from({ length: n }, () => move(over))

describe('never pooling time controls', () => {
  it('refuses to rank a sample that spans two time classes', () => {
    // The failure this prevents is silent: 232 blitz games and 27 rapid ones
    // pool into a ranking that looks perfectly healthy and describes the player
    // the owner stopped being on 2026-08-08.
    const mixed = [...many(3, { timeClass: 'blitz' }), ...many(3, { timeClass: 'rapid' })]
    expect(() => bucketsBy(mixed, byPhase)).toThrow(/pooled time controls/)
  })

  it('splits into one sample per class, and each ranks fine on its own', () => {
    const mixed = [...many(3, { timeClass: 'blitz' }), ...many(2, { timeClass: 'rapid' })]
    expect(timeClassesIn(mixed)).toEqual(['blitz', 'rapid'])
    const split = byTimeClass(mixed)
    expect(split.map((s) => [s.timeClass, s.moves.length])).toEqual([
      ['blitz', 3],
      ['rapid', 2],
    ])
    for (const { timeClass, moves } of split) {
      expect(bucketsBy(moves, byPhase).timeClass).toBe(timeClass)
    }
  })
})

describe('ranking', () => {
  it('ranks the common-and-expensive above the rare-and-dramatic', () => {
    // The whole point of the headline metric. Endgame here is catastrophic per
    // move and almost never happens; the middlegame quietly costs three times as
    // much in total. "Where is my time worth spending" is the second one, and an
    // error-rate ranking says the first.
    const moves = [
      ...many(200, { phase: 'middlegame', swing: 3, tier: 'A' }),
      ...many(20, { phase: 'middlegame', swing: 30, tier: 'C' }),
      ...many(6, { phase: 'endgame', swing: 65, tier: 'C' }),
    ]
    const { buckets } = bucketsBy(moves, byPhase)
    expect(buckets.map((b) => b.label)).toEqual(['middlegame', 'endgame'])
    expect(buckets[0]?.winPercentLost).toBe(1200)
    expect(buckets[1]?.winPercentLost).toBe(390)
    // …and the endgame still wins on every rate, which is exactly why both are
    // reported rather than one.
    expect(buckets[1]?.errorRate).toBe(1)
    expect(buckets[1]?.perMove).toBe(65)
    expect(buckets[0]?.errorRate).toBeCloseTo(20 / 220)
  })

  it('carries share of the loss beside share of the moves', () => {
    // Half the loss from half the moves is not a finding, and a caller that can
    // only see `share` will report it as one.
    const moves = [
      ...many(50, { color: 'w', swing: 4 }),
      ...many(50, { color: 'b', swing: 4 }),
    ]
    const { buckets } = bucketsBy(moves, byColor)
    for (const b of buckets) {
      expect(b.share).toBeCloseTo(0.5)
      expect(b.moveShare).toBeCloseTo(0.5)
    }
  })

  it('totals win% over every move, Tier A included, as `npm run review` does', () => {
    // Excluding Tier A would flatter the total and stop it being comparable to
    // the per-game number the owner already reads.
    const moves = [...many(10, { swing: 2, tier: 'A' }), ...many(2, { swing: 20, tier: 'C' })]
    const { buckets } = bucketsBy(moves, () => 'all')
    expect(buckets[0]?.winPercentLost).toBe(60)
    expect(buckets[0]?.lostOnErrors).toBe(40)
    expect(buckets[0]?.blunders).toBe(2)
  })

  it('marks a bucket too small to read a rate into', () => {
    const moves = [
      ...many(MIN_MOVES_FOR_RATE, { phase: 'middlegame', swing: 1 }),
      ...many(MIN_MOVES_FOR_RATE - 1, { phase: 'endgame', swing: 1 }),
    ]
    const byLabel = new Map(bucketsBy(moves, byPhase).buckets.map((b) => [b.label, b]))
    expect(byLabel.get('middlegame')?.thin).toBe(false)
    expect(byLabel.get('endgame')?.thin).toBe(true)
  })

  it('counts Tier B as an error and reports Tier C separately', () => {
    expect([isError('A'), isError('B'), isError('C')]).toEqual([false, true, true])
    const { buckets } = bucketsBy([move({ tier: 'B' }), move({ tier: 'C' }), move()], () => 'all')
    expect(buckets[0]?.errors).toBe(2)
    expect(buckets[0]?.blunders).toBe(1)
  })
})

describe('the slicers', () => {
  it('asks whether the ENGINE’s move was forcing, not the played one', () => {
    // "When the answer was a capture or a check, did he find it" is a coaching
    // question. "Does he like captures" is a description of taste.
    expect(byBestForcing(move({ forcingBest: true, forcingPlayed: false }))).toBe('best was forcing')
    expect(byBestForcing(move({ forcingBest: false, forcingPlayed: true }))).toBe('best was quiet')
  })

  it('bands seconds, keeping an unclocked move out of every band', () => {
    expect(bySeconds(move({ seconds: 4.9 }))).toBe('under 5s')
    expect(bySeconds(move({ seconds: 5 }))).toBe('5–15s')
    expect(bySeconds(move({ seconds: 61 }))).toBe('over 60s')
    // Daily games have no usable [%clk], and inventing a 0 for them would put
    // every correspondence move in the fastest band.
    expect(bySeconds(move({ seconds: null }))).toBe('unclocked')
  })

  it('bands pieces on the board, kings included', () => {
    expect(byPieces(move({ pieces: 32 }))).toBe('23–32')
    expect(byPieces(move({ pieces: 7 }))).toBe('7 or fewer')
    expect(byPieces(move({ pieces: 8 }))).toBe('8–14')
  })

  it('buckets by the piece type moved', () => {
    const { buckets } = bucketsBy([move({ piece: 'p' }), move({ piece: 'p' }), move({ piece: 'q' })], byPieceMoved)
    expect(buckets.map((b) => [b.label, b.moves])).toEqual([
      ['p', 2],
      ['q', 1],
    ])
  })
})

describe('pieceMatchBaseline — the check that kills findings', () => {
  // The 2026-08-15 sample, reconstructed: 100 middlegame errors, ~29 legal moves
  // across ~9 movable pieces, the engine's piece owning 6 or 7 of those moves.
  // Blind guessing lands on it 22% of the time. He was at 18%.
  const positions = (samePieceCount: number) => {
    const rows: CoachMove[] = []
    for (let i = 0; i < 100; i++) {
      rows.push(
        move({
          tier: 'C',
          legalMoves: 29,
          movablePieces: 9,
          bestPieceMoves: i < 62 ? 6 : 7,
          samePiece: i < samePieceCount,
        }),
      )
    }
    return rows
  }

  it('calls the 82%-wrong-piece finding what it was: chance', () => {
    const base = pieceMatchBaseline(positions(18))
    expect(base.n).toBe(100)
    expect(base.observedRate).toBeCloseTo(0.18)
    expect(base.expectedRate).toBeCloseTo(0.22)
    expect(base.z).not.toBeNull()
    expect(Math.abs(base.z ?? 0)).toBeLessThan(BASELINE_Z)
    expect(base.verdict).toBe('indistinguishable from chance')
  })

  it('uses legal moves of the engine’s piece, not one over the movable pieces', () => {
    // This is the load-bearing arithmetic. One-over-pieces gives 11%, against
    // which 18% reads as ABOVE chance — a null result flipped into a finding
    // pointing the opposite way. A queen with seven legal moves is seven
    // chances to agree with the engine by accident.
    const base = pieceMatchBaseline(positions(18))
    expect(base.meanMovablePieces).toBe(9)
    expect(base.expectedRate).toBeGreaterThan(1 / 9)
    expect(base.expectedRate).toBeCloseTo(0.22)
    expect(base.meanLegalMoves).toBe(29)
  })

  it('still finds a real effect when there is one', () => {
    const base = pieceMatchBaseline(positions(45))
    expect(base.verdict).toBe('above chance')
    expect(base.z ?? 0).toBeGreaterThan(BASELINE_Z)
  })

  it('reports below chance when the gap is big enough to see', () => {
    const base = pieceMatchBaseline(positions(2))
    expect(base.verdict).toBe('below chance')
  })

  it('ignores moves with no engine best to compare against', () => {
    const base = pieceMatchBaseline([...positions(18), ...many(20, { samePiece: null, bestPieceMoves: null })])
    expect(base.n).toBe(100)
  })

  it('says indistinguishable rather than dividing by zero on an empty sample', () => {
    const base = pieceMatchBaseline([])
    expect(base.n).toBe(0)
    expect(base.z).toBeNull()
    expect(base.verdict).toBe('indistinguishable from chance')
  })
})

describe('thinkTime', () => {
  const curve = [
    ...many(100, { seconds: 2, swing: 1, tier: 'A' }),
    ...many(100, { seconds: 10, swing: 2, tier: 'A' }),
    ...many(100, { seconds: 20, swing: 4, tier: 'B' }),
  ]

  it('returns bands in clock order, not ranked by cost', () => {
    // Ranking would destroy the only thing the slice carries: the shape.
    expect(thinkTime(curve).bands.map((b) => b.label)).toEqual(['under 5s', '5–15s', '15–30s'])
  })

  it('carries the confound on the result, where it cannot be dropped', () => {
    const { caveat } = thinkTime(curve)
    expect(caveat).toMatch(/not evidence that thinking causes blunders/)
    expect(caveat).toMatch(/not converting into accuracy/)
  })

  it('reports the rising shape only from bands big enough to have one', () => {
    const rising = [
      ...many(100, { seconds: 2, tier: 'A' }),
      ...many(50, { seconds: 10, tier: 'A' }),
      ...many(50, { seconds: 10, tier: 'B', swing: 8 }),
      ...many(100, { seconds: 20, tier: 'B', swing: 8 }),
    ]
    // Error rates 0 / 0.5 / 1 across three bands of 100, none of them thin.
    // Strictly rising, deliberately: two bands at the same rate is a flat
    // stretch, and calling that "rises with time" is the sort of overstatement
    // this module exists to refuse.
    expect(thinkTime(rising).risesWithTime).toBe(true)
    // The same shape over four moves a band is not a shape.
    const tiny = [
      ...many(2, { seconds: 2, tier: 'A' }),
      ...many(2, { seconds: 20, tier: 'C', swing: 40 }),
    ]
    expect(thinkTime(tiny).risesWithTime).toBe(false)
  })

  it('refuses a pooled sample, like every other ranking', () => {
    expect(() => thinkTime([move({ timeClass: 'blitz' }), move({ timeClass: 'rapid' })])).toThrow(
      /pooled time controls/,
    )
  })
})

describe('describeSample', () => {
  it('states games, moves, unclocked moves and whether it is too thin', () => {
    const moves = [
      ...many(20, { gameId: 'a', swing: 2 }),
      ...many(20, { gameId: 'b', swing: 3, seconds: null }),
    ]
    const sample = describeSample(moves)
    expect(sample).toMatchObject({ games: 2, moves: 40, unclocked: 20, thin: true })
    expect(sample.winPercentLost).toBe(100)
  })

  it('is not thin once there are enough games', () => {
    const moves = Array.from({ length: 40 }, (_, i) => move({ gameId: `g${i}` }))
    expect(describeSample(moves).thin).toBe(false)
  })

  it('names both classes when handed a pooled sample, so the caller can see what to split', () => {
    expect(describeSample([move({ timeClass: 'blitz' }), move({ timeClass: 'rapid' })]).timeClass).toBe(
      'blitz+rapid',
    )
  })
})

describe('empty buckets', () => {
  it('has no error rate over no moves — a rate with no sample is not 0', () => {
    const { buckets, winPercentLost } = bucketsBy([], () => 'all')
    expect(buckets).toEqual([])
    expect(winPercentLost).toBe(0)
  })
})
