import type { Color, Tier } from './types'

/**
 * Ranking weaknesses across a whole archive of the owner's games (#137).
 *
 * `scripts/coach/archive.mjs` grades every move with the *trainer's* rule —
 * `gradeMove` on two evaluations from the mover's perspective, exactly as
 * `engine/grading.ts` does — and writes the rows. This module is the judgment
 * over those rows: bucketing, aggregation, ranking, and the base-rate checks
 * that decide whether a pattern is a finding at all. `scripts/coach/assess.mjs`
 * is the printer and holds no opinion, the way `scripts/review/game.mjs` relates
 * to `gameReview.ts`.
 *
 * Type-only imports on purpose: the scripts load this under Node's type
 * stripping, and a module with no runtime imports has nothing left to resolve.
 * (See the note in `grade.ts` for the other half of that rule.)
 *
 * Three design decisions here are the whole point of the module, and each one
 * exists because the hand-run of 2026-08-15 got it wrong first:
 *
 * 1. **The headline is total win% given away, not error rate.** "Where is my
 *    time worth spending" is frequency × severity. Ranking by rate puts the
 *    rare-and-dramatic above the common-and-expensive, which is exactly the
 *    wrong advice.
 * 2. **A bucket's share of the loss is meaningless without its share of the
 *    moves.** "Pawn moves are 31% of your losses" is not a finding when pawn
 *    moves are 33% of your moves. `share` and `moveShare` are on every summary
 *    so a caller cannot render one without the other.
 * 3. **Time controls are never pooled.** `bucketsBy` refuses a mixed sample
 *    rather than trusting the caller to have split it.
 */

/** Time-class label as chess.com reports it: `bullet | blitz | rapid | daily`. */
export type TimeClass = string

/** Coarse phase, from `accuracy.ts`'s `phaseOf` — recorded, not re-derived. */
export type Phase = 'opening' | 'middlegame' | 'endgame'

/**
 * One graded move of the owner's, as `scripts/coach/archive.mjs` records it.
 *
 * Everything here is recorded at archive time so a slice can be re-cut without
 * re-running hours of engine. The fields that look redundant are not:
 * `legalMoves` / `movablePieces` / `bestPieceMoves` exist solely so
 * `pieceMatchBaseline` can compute a chance baseline *on the same positions*
 * rather than against an invented denominator.
 */
export interface CoachMove {
  readonly gameId: string
  readonly timeClass: TimeClass
  /** Which side the owner had. */
  readonly color: Color
  /** The owner's result in that game. */
  readonly result: 'win' | 'loss' | 'draw'
  readonly eco: string | null
  readonly moveNumber: number
  readonly phase: Phase
  readonly san: string
  /** The engine's preference in the position, SAN. Null when it returned none. */
  readonly best: string | null
  /** Win% given up against the best move; never negative. */
  readonly swing: number
  readonly tier: Tier
  /** Was the move played a capture or a check? */
  readonly forcingPlayed: boolean
  /** Was the engine's best move a capture or a check? */
  readonly forcingBest: boolean
  /** Piece type moved: `p b n r q k`. */
  readonly piece: string
  /**
   * Did the played move move the same *physical* piece (same from-square) as the
   * engine's best? Null when there was no best move to compare against.
   */
  readonly samePiece: boolean | null
  /** Legal moves in the position before the move. */
  readonly legalMoves: number
  /** Distinct pieces with at least one legal move. */
  readonly movablePieces: number
  /** Of `legalMoves`, how many belong to the engine's best move's piece. */
  readonly bestPieceMoves: number | null
  /** Pieces on the board before the move, both sides, kings included. */
  readonly pieces: number
  /** Seconds spent, from the PGN `[%clk]` comments. Null when the PGN had none. */
  readonly seconds: number | null
}

/**
 * A move counts as an **error** when it is not Tier A.
 *
 * Tier A is engine-equal and is not a mistake (the game-review skill's §4 opens
 * with this). Tier B is a real concession, so folding B into "fine" would hide
 * most of what a rapid player actually gives away. `blunders` carries the Tier C
 * count separately, so nothing is buried inside the wider label.
 */
export function isError(tier: Tier): boolean {
  return tier !== 'A'
}

export interface Bucket {
  readonly label: string
  readonly moves: number
  /** Moves that were not Tier A. */
  readonly errors: number
  /** Moves that were Tier C. */
  readonly blunders: number
  /** Errors over moves, 0–1. `undefined` over an empty bucket — a rate with no sample is not 0. */
  readonly errorRate?: number
  /**
   * Total win% given away in this bucket, over **every** move in it — Tier A
   * moves included, exactly as `npm run review` totals a single game. Excluding
   * them would flatter the total and stop it being comparable to the per-game
   * number the owner already reads.
   */
  readonly winPercentLost: number
  /** Of that, the part given away on non-Tier-A moves. */
  readonly lostOnErrors: number
  /** This bucket's share of the sample's total win% lost, 0–1. */
  readonly share: number
  /**
   * This bucket's share of the sample's moves, 0–1 — the base rate `share` has
   * to be read against. A bucket costing 30% of the loss over 30% of the moves
   * is not a weakness; it is a third of the game.
   */
  readonly moveShare: number
  /** Win% given away per move — the figure that is comparable across bucket sizes. */
  readonly perMove: number
  /**
   * True while the bucket holds too few moves to read a rate into. Rendering
   * "50% error rate" over four moves is a stronger claim than the data supports.
   */
  readonly thin: boolean
}

/**
 * Moves below this and a bucket's rate is noise wearing a percent sign. Error
 * rates here sit around 0.1–0.35, so the standard error at n=50 is ±0.06 — the
 * same order as the differences between buckets that a ranking would be reading.
 */
export const MIN_MOVES_FOR_RATE = 50

export interface Ranking {
  /** The one time class these buckets describe. Never a pool of several. */
  readonly timeClass: TimeClass
  readonly buckets: readonly Bucket[]
  /** Moves the ranking rests on. */
  readonly moves: number
  /** Total win% given away across them — the denominator of every `share`. */
  readonly winPercentLost: number
}

/** Every distinct time class present, so a caller can see what it must not pool. */
export function timeClassesIn(moves: readonly CoachMove[]): string[] {
  return [...new Set(moves.map((m) => m.timeClass))].sort()
}

/**
 * Split a sample by time class. This is the *only* way into `bucketsBy`, and
 * that is deliberate.
 *
 * The owner's archive on 2026-08-15 was 232 blitz (all of July, ~840–880), 27
 * rapid (~1090–1220) and 17 daily (~1449–1496), and he moved off blitz around
 * 2026-08-08. A pooled ranking lets blitz outvote his current chess 5:1 and
 * describes a player he no longer is — with numbers that look perfectly healthy.
 */
export function byTimeClass(moves: readonly CoachMove[]): { timeClass: TimeClass; moves: CoachMove[] }[] {
  return timeClassesIn(moves).map((timeClass) => ({
    timeClass,
    moves: moves.filter((m) => m.timeClass === timeClass),
  }))
}

/**
 * Bucket a single time class's moves by whatever key the caller names, ranked by
 * total win% given away, biggest first.
 *
 * **Throws on a mixed sample.** The caller has to have gone through
 * `byTimeClass`; a rate averaged across time controls is not a rate, and the
 * failure is silent if it is merely discouraged in a comment.
 */
export function bucketsBy(
  moves: readonly CoachMove[],
  keyOf: (move: CoachMove) => string,
): Ranking {
  const classes = timeClassesIn(moves)
  if (classes.length > 1) {
    throw new Error(
      `refusing to rank across pooled time controls (${classes.join(', ')}) — split with byTimeClass first`,
    )
  }

  const total = moves.reduce((sum, m) => sum + m.swing, 0)
  const groups = new Map<string, CoachMove[]>()
  for (const move of moves) {
    const key = keyOf(move)
    const group = groups.get(key)
    if (group) group.push(move)
    else groups.set(key, [move])
  }

  const buckets = [...groups].map(([label, group]) => summarise(label, group, total, moves.length))
  // Total win% lost first — frequency × severity, per the module note. Ties fall
  // back to move count so the order is stable rather than insertion-dependent.
  buckets.sort((a, b) => b.winPercentLost - a.winPercentLost || b.moves - a.moves || a.label.localeCompare(b.label))

  return {
    timeClass: classes[0] ?? '',
    buckets,
    moves: moves.length,
    winPercentLost: total,
  }
}

function summarise(
  label: string,
  group: readonly CoachMove[],
  sampleSwing: number,
  sampleMoves: number,
): Bucket {
  const errors = group.filter((m) => isError(m.tier))
  const winPercentLost = group.reduce((sum, m) => sum + m.swing, 0)
  return {
    label,
    moves: group.length,
    errors: errors.length,
    blunders: group.filter((m) => m.tier === 'C').length,
    errorRate: group.length ? errors.length / group.length : undefined,
    winPercentLost,
    lostOnErrors: errors.reduce((sum, m) => sum + m.swing, 0),
    share: sampleSwing ? winPercentLost / sampleSwing : 0,
    moveShare: sampleMoves ? group.length / sampleMoves : 0,
    perMove: group.length ? winPercentLost / group.length : 0,
    thin: group.length < MIN_MOVES_FOR_RATE,
  }
}

// --- the slicers ------------------------------------------------------------
// Each is a plain key function so a caller can add one without touching the
// aggregation. They are here rather than in the script because which buckets a
// number is cut into is a judgment about what the number means.

export const byPhase = (m: CoachMove): string => m.phase

/**
 * Whether the *engine's* move was forcing, not whether the owner's was. The
 * question a coach asks is "when the answer was a capture or a check, did he
 * find it" — asking about the move he actually played only ever describes his
 * taste.
 */
export const byBestForcing = (m: CoachMove): string => (m.forcingBest ? 'best was forcing' : 'best was quiet')

export const byColor = (m: CoachMove): string => (m.color === 'w' ? 'White' : 'Black')

export const byPieceMoved = (m: CoachMove): string => m.piece

/** Seconds-spent bands. Wide and few, because the clock reading is a tenth-second estimate. */
export const SECONDS_BANDS: readonly { readonly label: string; readonly max: number }[] = [
  { label: 'under 5s', max: 5 },
  { label: '5–15s', max: 15 },
  { label: '15–30s', max: 30 },
  { label: '30–60s', max: 60 },
  { label: 'over 60s', max: Infinity },
]

export const bySeconds = (m: CoachMove): string => {
  const spent = m.seconds
  if (spent == null) return 'unclocked'
  return SECONDS_BANDS.find((b) => spent < b.max)?.label ?? 'over 60s'
}

/** Pieces-on-the-board bands, kings included, so 32 is the starting position. */
export const PIECES_BANDS: readonly { readonly label: string; readonly max: number }[] = [
  { label: '7 or fewer', max: 8 },
  { label: '8–14', max: 15 },
  { label: '15–22', max: 23 },
  { label: '23–32', max: Infinity },
]

export const byPieces = (m: CoachMove): string =>
  PIECES_BANDS.find((b) => m.pieces < b.max)?.label ?? '23–32'

// --- the base-rate check ----------------------------------------------------

export interface Baseline {
  /** Moves the check rests on — those with a best move to compare against. */
  readonly n: number
  /** How often the owner moved the engine's piece. */
  readonly observed: number
  readonly observedRate: number
  /** How often a move picked blindly from the legal moves would have. */
  readonly expected: number
  readonly expectedRate: number
  /**
   * Standard deviation of `expected` under the blind-guess model — each position
   * an independent Bernoulli trial with its own probability, so the count is
   * Poisson-binomial and this is √Σp(1−p). Exact, no normal approximation
   * involved in producing it.
   */
  readonly sd: number
  /** (observed − expected) / sd. Null when sd is 0 (nothing to distinguish). */
  readonly z: number | null
  readonly verdict: 'above chance' | 'below chance' | 'indistinguishable from chance'
  /** Context the verdict is meaningless without. */
  readonly meanLegalMoves: number
  readonly meanMovablePieces: number
}

/**
 * Standard deviations from the blind-guess expectation before a difference is
 * worth naming. Two is the usual convention and it is the one that killed the
 * finding below; nothing here justifies a tighter bar.
 */
export const BASELINE_Z = 2

/**
 * Did the owner move the piece the engine wanted more often than chance?
 *
 * **This function exists because of one worked example, and the skill quotes
 * it.** On 2026-08-15, 82% of his middlegame errors moved a different piece than
 * the engine's best. That reads as a clean, teachable finding — "the right move
 * was never on his list" — and it had already been drafted as a coaching
 * conclusion. Then the baseline: those positions averaged 29.3 legal moves
 * across 8.8 movable pieces, and the engine's piece owned enough of them that a
 * blind guess lands on it 22% of the time. He was at 18%. The finding was
 * chance.
 *
 * The denominator that matters is *legal moves belonging to the engine's piece
 * over all legal moves*, position by position — not one over the number of
 * pieces. A queen with nine legal moves is nine chances to "agree" with the
 * engine by accident, and the one-over-pieces version (11% here) would have
 * turned a null result into a finding pointing the other way.
 *
 * A verdict of `indistinguishable from chance` is not evidence that nothing is
 * there. It means this sample cannot tell, which is a reason not to coach off it
 * — not a reason to claim the opposite.
 */
export function pieceMatchBaseline(moves: readonly CoachMove[]): Baseline {
  const usable = moves.filter((m) => m.samePiece != null && m.bestPieceMoves != null && m.legalMoves > 0)
  const n = usable.length
  const observed = usable.filter((m) => m.samePiece).length
  const probabilities = usable.map((m) => (m.bestPieceMoves ?? 0) / m.legalMoves)
  const expected = probabilities.reduce((sum, p) => sum + p, 0)
  const sd = Math.sqrt(probabilities.reduce((sum, p) => sum + p * (1 - p), 0))
  const z = sd > 0 ? (observed - expected) / sd : null
  return {
    n,
    observed,
    observedRate: n ? observed / n : 0,
    expected,
    expectedRate: n ? expected / n : 0,
    sd,
    z,
    verdict:
      z == null || Math.abs(z) < BASELINE_Z
        ? 'indistinguishable from chance'
        : z > 0
          ? 'above chance'
          : 'below chance',
    meanLegalMoves: n ? usable.reduce((sum, m) => sum + m.legalMoves, 0) / n : 0,
    meanMovablePieces: n ? usable.reduce((sum, m) => sum + m.movablePieces, 0) / n : 0,
  }
}

export interface ThinkTime {
  readonly bands: readonly Bucket[]
  /** True when the error rate rises with every band — the shape seen on 2026-08-15. */
  readonly risesWithTime: boolean
  /**
   * What the shape does and does not support. Carried on the result rather than
   * left to the caller, because the wrong reading of it is the natural one.
   */
  readonly caveat: string
}

const THINK_TIME_CAVEAT =
  'Confounded in both directions: hard positions cause the long think AND the error, ' +
  'so this is not evidence that thinking causes blunders. The claim it does support is ' +
  'the weaker one — extra time is not converting into accuracy — which is still enough ' +
  'to rule out "slow down" as advice.'

/**
 * Error rate against seconds spent, in clock order rather than ranked.
 *
 * The ranking everything else uses would sort this by cost and destroy the only
 * thing the slice is for: the *shape*. On 2026-08-15 it ran 3% under 5s to 34%
 * over 60s, monotonically — and the obvious conclusion from that is wrong, which
 * is why `caveat` is a field and not a comment.
 */
export function thinkTime(moves: readonly CoachMove[]): ThinkTime {
  const ranked = bucketsBy(moves, bySeconds)
  const order = [...SECONDS_BANDS.map((b) => b.label), 'unclocked']
  const bands = ranked.buckets
    .slice()
    .sort((a, b) => order.indexOf(a.label) - order.indexOf(b.label))
  const clocked = bands.filter((b) => b.label !== 'unclocked' && !b.thin)
  return {
    bands,
    risesWithTime:
      clocked.length > 1 &&
      clocked.every((b, i) => i === 0 || (b.errorRate ?? 0) > (clocked[i - 1]?.errorRate ?? 0)),
    caveat: THINK_TIME_CAVEAT,
  }
}

export interface Sample {
  readonly timeClass: TimeClass
  readonly games: number
  readonly moves: number
  readonly winPercentLost: number
  /** Moves whose PGN carried no `[%clk]`, so the time slices do not cover them. */
  readonly unclocked: number
  /** True while the sample is too thin for any of it to be read as a pattern. */
  readonly thin: boolean
}

/**
 * Games below this and the whole time class is a description of a few
 * afternoons. 27 rapid games was the real number on 2026-08-15 and it was
 * already marginal — enough to rank where the loss sits, not enough to call any
 * one bucket a weakness on its own.
 */
export const MIN_GAMES_FOR_PATTERN = 30

/** Everything a caller needs to state what a ranking was computed over. */
export function describeSample(moves: readonly CoachMove[]): Sample {
  const games = new Set(moves.map((m) => m.gameId)).size
  return {
    timeClass: timeClassesIn(moves).join('+'),
    games,
    moves: moves.length,
    winPercentLost: moves.reduce((sum, m) => sum + m.swing, 0),
    unclocked: moves.filter((m) => m.seconds == null).length,
    thin: games < MIN_GAMES_FOR_PATTERN,
  }
}
