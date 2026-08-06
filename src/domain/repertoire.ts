import type { Color } from './types'

// Pure scoring for the opening-repertoire generator (ADR 0021, issue #88). The
// crawler in scripts/repertoire/ does the IO; everything with a judgment in it
// lives here so it is unit-tested and reusable by the app when epic:opening
// arrives.
//
// This module deliberately has **no runtime imports** — only `import type`.
// That is what lets the .mjs scripts load it directly under Node's type
// stripping (see scripts/repertoire/README.md). It therefore speaks in
// *win-percentage points* (0–100) and *scores* (0–1), never centipawns; callers
// convert via domain/winPercent first.

/** Human-play statistics for one move at a rating band — the Lichess explorer shape. */
export interface MoveStats {
  san: string
  uci: string
  /** Games reaching this position that continued with this move and ended thus. */
  white: number
  draws: number
  black: number
}

/** Games in which this move was played. */
export function gamesFor(m: MoveStats): number {
  return m.white + m.draws + m.black
}

/** Games played from the parent position, across all candidate moves. */
export function totalGames(moves: readonly MoveStats[]): number {
  return moves.reduce((sum, m) => sum + gamesFor(m), 0)
}

/** How often this move is chosen from the parent position, 0–1. */
export function frequency(m: MoveStats, total: number): number {
  return total === 0 ? 0 : gamesFor(m) / total
}

/**
 * Practical score (0–1) for the player who *makes* this move: wins plus half of
 * draws. This is the "did it work in practice" half of `trapValue`, and it is
 * the number that diverges from the engine's opinion at low ratings.
 */
export function practicalScore(m: MoveStats, mover: Color): number {
  const n = gamesFor(m)
  if (n === 0) return 0
  const wins = mover === 'w' ? m.white : m.black
  return (wins + m.draws / 2) / n
}

// ---------------------------------------------------------------------------
// Opponent coverage — which of their moves we prepare against
// ---------------------------------------------------------------------------

/** Share of games we aim to cover at an opponent node. */
export const DEFAULT_MASS_TARGET = 0.85
/** Below this many games the explorer's win rates are noise, not signal. */
export const DEFAULT_MIN_GAMES = 20
/** A hard ceiling so one chaotic node can't blow up the tree. */
export const DEFAULT_MAX_MOVES = 6

export interface CoverageOptions {
  massTarget?: number
  minGames?: number
  maxMoves?: number
}

export interface CoverageResult {
  covered: MoveStats[]
  /** Share of games actually covered, 0–1. May fall short of the target. */
  mass: number
  /** Everything left out, so the caller can report it rather than hide it. */
  skipped: MoveStats[]
  /** True when `maxMoves` stopped us before reaching `massTarget`. */
  truncated: boolean
}

/**
 * Take opponent moves in descending frequency until `massTarget` of the games
 * played here is covered. Moves below `minGames` are never covered on frequency
 * grounds — but the caller may still add them back via `trapValue`, which is
 * where rare-but-vicious lines get in.
 *
 * Reports `skipped` and `truncated` because a coverage cap that silently drops
 * lines reads as "we covered everything" when it did not.
 */
export function coverByMass(
  moves: readonly MoveStats[],
  opts: CoverageOptions = {},
): CoverageResult {
  const massTarget = opts.massTarget ?? DEFAULT_MASS_TARGET
  const minGames = opts.minGames ?? DEFAULT_MIN_GAMES
  const maxMoves = opts.maxMoves ?? DEFAULT_MAX_MOVES

  const total = totalGames(moves)
  const ranked = [...moves].sort((a, b) => gamesFor(b) - gamesFor(a))

  const covered: MoveStats[] = []
  const skipped: MoveStats[] = []
  let carried = 0

  for (const m of ranked) {
    const enough = carried / (total || 1) >= massTarget
    if (enough || covered.length >= maxMoves || gamesFor(m) < minGames) {
      skipped.push(m)
      continue
    }
    covered.push(m)
    carried += gamesFor(m)
  }

  return {
    covered,
    mass: total === 0 ? 0 : carried / total,
    skipped,
    truncated: covered.length >= maxMoves && carried / (total || 1) < massTarget,
  }
}

// ---------------------------------------------------------------------------
// Traps — frequency-weighted regret, pointed at the opponent
// ---------------------------------------------------------------------------

/**
 * A move must give up more than this to be a trap candidate. Anchored to
 * TIER_A_MAX_SWING (repertoire.test.ts pins them together): Tier A means "as
 * good as best", so anything inside it is a legitimate alternative, not a
 * mistake anyone needs preparing against.
 *
 * Deliberately *not* set higher. Real club traps are often only worth half a
 * pawn — the Albin Counter-Gambit gives up around 5 win% and still scores over
 * 50% at 1500–1900, which is precisely the material worth an hour of study. A
 * higher gate silently discards the entire gambit family, and `outperformance`
 * is what separates signal from noise here anyway: a merely-inferior move that
 * scores as badly as it deserves still yields a trapValue of zero.
 */
export const TRAP_MIN_SWING = 5

export interface TrapInput {
  /** How often the move is played here, 0–1. */
  frequency: number
  /** Win% the mover gives up versus the best move here, 0–100. */
  swing: number
  /** What humans actually score with it, 0–1. */
  practical: number
  /** What the resulting position is worth to the mover, 0–1 (win% / 100). */
  expected: number
  /** How many games the practical score is computed from. */
  games: number
}

/**
 * Pseudo-count for shrinking `practical` toward `expected`. At this many games
 * the observed rate carries half the weight. Chosen because the standard error
 * of a win rate at n≈50 is around 7 points, which is the size of the effects we
 * are trying to detect — below that we cannot tell a trap from a coin flip.
 */
export const TRAP_PRIOR_GAMES = 100

/**
 * Games below which we decline to call anything a trap at all.
 *
 * Shrinkage alone is not enough, because a small sample with a *large* apparent
 * gap survives it: six games at 83% against a 30% expectation still shrinks to
 * a score that outranks a genuine 317-game finding. Database samples are also
 * correlated in ways the binomial ignores — a handful of games between the same
 * two players, or one popular follow-up blunder. So there is a hard floor, and
 * what it excludes is reported rather than dropped.
 */
export const TRAP_MIN_GAMES = 50

/**
 * How much better a move does in practice than its evaluation deserves, 0–1.
 *
 * The observed score is shrunk toward the evaluation in proportion to how
 * little evidence backs it, because the raw difference is worthless at low
 * counts: five wins from six games reads as an 83% score and will outrank any
 * genuine finding. Shrinkage leaves a well-sampled move essentially untouched
 * (n=317 moves by under a point) while collapsing a six-game fluke.
 *
 * Clamped at zero: a move that under-performs its evaluation is not a trap, it
 * is just a bad move people already punish.
 */
export function outperformance(t: TrapInput): number {
  const n = Math.max(0, t.games)
  const shrunk = (t.practical * n + t.expected * TRAP_PRIOR_GAMES) / (n + TRAP_PRIOR_GAMES)
  return Math.max(0, shrunk - t.expected)
}

/**
 * Constitution §4's frequency-weighted regret, inverted onto the opponent.
 *
 * A line is worth preparing when it is played often, gives up real evaluation,
 * and *still* scores well — that combination means the refutation is not common
 * knowledge at this band, which is exactly where an hour of study pays. Sorting
 * candidate deviations by this is how the generator finds the traps we would
 * never have thought to list by hand.
 */
export function trapValue(t: TrapInput): number {
  if (t.swing < TRAP_MIN_SWING) return 0
  // Below this we genuinely cannot tell. Returning 0 is a refusal to guess, not
  // a claim the move is sound — the crawler reports what it excluded on these
  // grounds so a rare-but-vicious line is visible rather than disappeared.
  if (t.games < TRAP_MIN_GAMES) return 0
  return t.frequency * t.swing * outperformance(t)
}

/** Whether a deviation earns coverage on trap grounds alone. */
export function isTrap(t: TrapInput, minValue: number): boolean {
  return trapValue(t) >= minValue
}

// ---------------------------------------------------------------------------
// Quiet positions — where a line stops, and the item we actually train
// ---------------------------------------------------------------------------

/**
 * Win% window within which an alternative counts as "also playable". Mirrors
 * TIER_A_MAX_SWING in grade.ts — repertoire.test.ts pins the two together so
 * they cannot drift. (Not imported: this module must stay runtime-import-free.)
 */
export const QUIET_BREADTH_WINDOW = 5
/** Fewer playable moves than this and it is a sequence, not a decision. */
export const QUIET_MIN_BREADTH = 3
/** Shallow/deep disagreement above this means a tactic is hiding (constitution §6). */
export const QUIET_MAX_TACTIC_GAP = 10
/** How far from balanced a terminal position may be, in win% points. */
export const QUIET_MAX_IMBALANCE = 15

export interface QuietnessOptions {
  breadthWindow?: number
  minBreadth?: number
  maxTacticGap?: number
  maxImbalance?: number
}

export interface QuietnessInput {
  /** Top-N win% for the side to move, best first, 0–100. */
  multipv: readonly number[]
  /** Win% for the side to move from a deliberately shallow search. */
  shallow: number
  /** Win% for the side to move at the full node budget. */
  deep: number
}

export interface Quietness {
  quiet: boolean
  /** Moves within `breadthWindow` of the best. */
  breadth: number
  /** |shallow − deep|: how much the deep search changed its mind. */
  tacticGap: number
  /** Distance from balanced, in win% points. */
  imbalance: number
  /** Why it failed, empty when quiet. */
  reasons: string[]
}

/**
 * Decide whether a line can stop here. All three tests must pass:
 *
 * - **no hidden tactic** — a shallow and a deep search agree, so nothing
 *   concrete is lurking (constitution §6's filter, reused as-is);
 * - **breadth** — several moves are playable, so the position poses a judgment
 *   rather than a single move to recall (constitution §1);
 * - **balance** — the position is still a game.
 *
 * A repertoire whose lines ended on forced moves would be exactly the
 * memorisation §1 rules out. This function is what mechanically prevents that,
 * and it is why depth is variable rather than fixed.
 */
export function quietness(input: QuietnessInput, opts: QuietnessOptions = {}): Quietness {
  const breadthWindow = opts.breadthWindow ?? QUIET_BREADTH_WINDOW
  const minBreadth = opts.minBreadth ?? QUIET_MIN_BREADTH
  const maxTacticGap = opts.maxTacticGap ?? QUIET_MAX_TACTIC_GAP
  const maxImbalance = opts.maxImbalance ?? QUIET_MAX_IMBALANCE

  const best = input.multipv[0]
  const breadth =
    best === undefined ? 0 : input.multipv.filter((wp) => best - wp <= breadthWindow).length
  const tacticGap = Math.abs(input.shallow - input.deep)
  const imbalance = Math.abs(input.deep - 50)

  const reasons: string[] = []
  if (breadth < minBreadth) reasons.push(`only ${breadth} playable move(s)`)
  if (tacticGap > maxTacticGap) reasons.push(`tactic hiding (shallow/deep gap ${tacticGap.toFixed(1)})`)
  if (imbalance > maxImbalance) reasons.push(`position already decided (${imbalance.toFixed(1)} from level)`)

  return { quiet: reasons.length === 0, breadth, tacticGap, imbalance, reasons }
}

// ---------------------------------------------------------------------------
// Our own moves — one per node, chosen partly on what it costs to learn
// ---------------------------------------------------------------------------

/** Win% we are willing to give up for a better-to-learn move. */
export const SOUNDNESS_MAX_SWING = 5

export interface OurMoveCandidate {
  move: MoveStats
  /** Win% given up versus the engine's best move here, 0–100. */
  swing: number
  /** How many replies we would have to prepare if we played this. */
  replyBranching: number
  /** How often our band plays it, 0–1. */
  frequency: number
}

export interface RankingWeights {
  branching?: number
  popularity?: number
}

/**
 * Branching and popularity only — **not** how far a candidate sits from the
 * engine's favourite.
 *
 * Constitution §3: "engine ordering within a tier is an artifact that flips
 * with depth and version." Every candidate here has already passed the
 * soundness gate at TIER_A_MAX_SWING, which is the project's own definition of
 * "as good as best" — so ranking them against each other by evaluation is
 * ordering within a tier, exactly what §3 forbids.
 *
 * This was measured, not theorised. With a soundness term the repertoire chose
 * 3.Nc3 against the Slav at a 120k node budget and 3.cxd5 at 1M — both sound,
 * both from master practice — which rerouted the whole subtree and silently
 * changed which lines were even examined. A repertoire you memorise must not
 * depend on an engine setting.
 */
export const DEFAULT_WEIGHTS: Required<RankingWeights> = {
  branching: 0.6,
  popularity: 0.4,
}

/**
 * Replies-to-prepare at which a move scores zero for learnability. Branching is
 * scored linearly against this rather than as 1/(1+n): the reciprocal curve
 * flattens out exactly where the interesting comparisons live, making the
 * difference between two replies and nine almost weightless.
 */
export const BRANCHING_REFERENCE = 8

/** Candidates within the soundness gate. */
export function soundCandidates(
  candidates: readonly OurMoveCandidate[],
  maxSwing: number = SOUNDNESS_MAX_SWING,
): OurMoveCandidate[] {
  return candidates.filter((c) => c.swing <= maxSwing)
}

/** The 0–1 score `rankOurMoves` sorts by; exposed so the crawler can report it. */
export function ourMoveScore(
  c: OurMoveCandidate,
  weights: RankingWeights = {},
  branchingReference: number = BRANCHING_REFERENCE,
): number {
  const w = { ...DEFAULT_WEIGHTS, ...weights }
  const branching = Math.max(0, 1 - Math.max(0, c.replyBranching) / branchingReference)
  return w.branching * branching + w.popularity * c.frequency
}

/**
 * Rank the moves we might adopt, best first. Only sound candidates are ranked;
 * among those, **branching cost dominates**, because a repertoire's real price
 * is the number of replies it obliges you to learn. Optimising purely for
 * evaluation produces a theoretically excellent repertoire nobody can hold in
 * their head — which for a club player is the same as not having one.
 */
export function rankOurMoves(
  candidates: readonly OurMoveCandidate[],
  weights: RankingWeights = {},
  maxSwing: number = SOUNDNESS_MAX_SWING,
  branchingReference: number = BRANCHING_REFERENCE,
): OurMoveCandidate[] {
  // The engine's role is to *veto* unsound moves, not to choose between sound
  // ones — hence the gate here and no evaluation term in the score.
  return soundCandidates(candidates, maxSwing).sort(
    (a, b) =>
      ourMoveScore(b, weights, branchingReference) - ourMoveScore(a, weights, branchingReference),
  )
}
