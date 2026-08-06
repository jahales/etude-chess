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

/** Below this win% loss a move is an inaccuracy, not a trap worth a drill. */
export const TRAP_MIN_SWING = 10

export interface TrapInput {
  /** How often the move is played here, 0–1. */
  frequency: number
  /** Win% the mover gives up versus the best move here, 0–100. */
  swing: number
  /** What humans actually score with it, 0–1. */
  practical: number
  /** What the resulting position is worth to the mover, 0–1 (win% / 100). */
  expected: number
}

/**
 * How much better a move does in practice than its evaluation deserves, 0–1.
 * Clamped at zero: a move that under-performs its evaluation is not a trap, it
 * is just a bad move people already punish.
 */
export function outperformance(t: TrapInput): number {
  return Math.max(0, t.practical - t.expected)
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
  soundness?: number
  branching?: number
  popularity?: number
}

/** Branching is weighted highest on purpose — see `rankOurMoves`. */
export const DEFAULT_WEIGHTS: Required<RankingWeights> = {
  soundness: 0.3,
  branching: 0.45,
  popularity: 0.25,
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
  maxSwing: number = SOUNDNESS_MAX_SWING,
  branchingReference: number = BRANCHING_REFERENCE,
): number {
  const w = { ...DEFAULT_WEIGHTS, ...weights }
  const soundness = maxSwing === 0 ? 1 : Math.max(0, 1 - c.swing / maxSwing)
  const branching = Math.max(0, 1 - Math.max(0, c.replyBranching) / branchingReference)
  return w.soundness * soundness + w.branching * branching + w.popularity * c.frequency
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
  return soundCandidates(candidates, maxSwing).sort(
    (a, b) =>
      ourMoveScore(b, weights, maxSwing, branchingReference) -
      ourMoveScore(a, weights, maxSwing, branchingReference),
  )
}
