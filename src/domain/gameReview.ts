import type { Color, Score, Tier } from './types'
// Extensions deliberate — see the note in grade.ts. `scripts/review/game.mjs`
// loads this module directly, and Node needs them to resolve it.
import { tierForSwing } from './grade.ts'
import { negate, winPercent } from './winPercent.ts'

// Reviewing a finished game is the same grading rule as the trainer's, applied
// to every move instead of one: win% swing, Tier A for engine-equal (ADR 0010,
// docs/decisions/0004-tier-not-rank). Nothing here talks to an engine or a
// file — the caller supplies the evaluations and this turns them into a report.
//
// The saving is that each position is evaluated ONCE. The evaluation before
// move N+1 is the evaluation after move N, so consecutive entries give both
// sides' swings; evaluating "before" and "after" separately doubles the engine
// cost for the same answer.

/**
 * What is known about one position in the game. Positions where the game has
 * ended carry a result instead of a score, because there is no evaluation to
 * have — and a move that delivers mate must be graded on the mate, not on an
 * engine score that does not exist.
 */
export type PositionEval =
  | { readonly kind: 'eval'; readonly score: Score }
  | { readonly kind: 'over'; readonly result: 'checkmate' | 'draw' }

export interface TimeControl {
  readonly startSeconds: number
  readonly incrementSeconds: number
}

/**
 * Parse a PGN `[TimeControl]` tag: `"900+10"`, or `"600"` for no increment.
 *
 * Returns null for anything else, which is the honest answer for chess.com's
 * correspondence form (`"1/259200"`): that is a per-move allowance, not a game
 * budget, so the clock arithmetic below would silently produce nonsense.
 */
export function parseTimeControl(raw: string): TimeControl | null {
  const m = /^(\d+)(?:\+(\d+))?$/.exec(raw.trim())
  if (!m) return null
  return { startSeconds: Number(m[1]), incrementSeconds: Number(m[2] ?? 0) }
}

/**
 * Seconds spent on each move, from the per-ply clock readings a PGN carries in
 * `[%clk ...]` comments.
 *
 * The reading after a move already has the increment added, so the time spent is
 * *this side's previous reading, plus the increment, minus what is showing now*.
 * The previous reading is two plies back, not one — one ply back is the
 * opponent's clock.
 */
export function secondsPerMove(
  clocks: readonly (number | null)[],
  tc: TimeControl,
): (number | null)[] {
  return clocks.map((clock, ply) => {
    const previous = ply < 2 ? tc.startSeconds : clocks[ply - 2]
    if (clock == null || previous == null) return null
    // Clamped: a reading rounded to a tenth can make a near-instant move look
    // very slightly negative, and a negative "time spent" is never meaningful.
    return Math.max(0, previous + tc.incrementSeconds - clock)
  })
}

export interface ReviewedMove {
  /** 0-based half-move index, so ply 0 is White's first move. */
  readonly ply: number
  readonly moveNumber: number
  readonly color: Color
  readonly san: string
  /** Was this the reviewed player's move? */
  readonly mine: boolean
  /** Win% for the mover, before they moved. */
  readonly before: number
  /** Win% for the mover, after they moved — what the move actually got them. */
  readonly after: number
  /** Win% given up against the best move; never negative. */
  readonly swing: number
  readonly tier: Tier
  /** The engine's preference in this position, if the caller supplied one. */
  readonly best: string | null
  readonly seconds: number | null
  /** `before`, expressed from the reviewed player's side — the eval curve. */
  readonly beforeMine: number
}

export interface GameReviewInput {
  readonly sans: readonly string[]
  /** One entry per position, so `sans.length + 1` of them: before every move, and after the last. */
  readonly positions: readonly PositionEval[]
  readonly myColor: Color
  /** The engine's best move in each position, parallel to `sans`. */
  readonly best?: readonly (string | null)[]
  /** Seconds spent on each move, parallel to `sans`. */
  readonly seconds?: readonly (number | null)[]
}

/** Win% for the side that just moved into `position`. */
function winPercentForMover(position: PositionEval): number {
  if (position.kind === 'over') {
    // The mover delivered it, so checkmate is theirs and a draw is a half point.
    return position.result === 'checkmate' ? 100 : 50
  }
  // Scores are reported from the side to move — which, after a move, is the
  // opponent. Negating expresses it from the mover's point of view.
  return winPercent(negate(position.score))
}

export function reviewGame(input: GameReviewInput): ReviewedMove[] {
  const { sans, positions, myColor, best, seconds } = input
  if (positions.length !== sans.length + 1) {
    throw new Error(
      `expected ${sans.length + 1} positions for ${sans.length} moves, got ${positions.length}`,
    )
  }

  const rows: ReviewedMove[] = []
  for (let ply = 0; ply < sans.length; ply++) {
    const from = positions[ply]
    const to = positions[ply + 1]
    const san = sans[ply]
    // The length check above already guarantees these; the guard is for the
    // type checker, which cannot see that far.
    if (!from || !to || san === undefined) continue
    // A position the game has already ended in has no move to grade.
    if (from.kind === 'over') continue

    const color: Color = ply % 2 === 0 ? 'w' : 'b'
    const before = winPercent(from.score)
    const after = winPercentForMover(to)
    const swing = Math.max(0, before - after)
    rows.push({
      ply,
      moveNumber: Math.floor(ply / 2) + 1,
      color,
      san,
      mine: color === myColor,
      before,
      after,
      swing,
      tier: tierForSwing(swing),
      best: best?.[ply] ?? null,
      seconds: seconds?.[ply] ?? null,
      beforeMine: color === myColor ? before : 100 - before,
    })
  }
  return rows
}

export interface Phase {
  readonly name: string
  readonly fromMove: number
  /** Inclusive; omit for "to the end of the game". */
  readonly toMove?: number
}

/**
 * The default split. Deliberately by move number rather than by material or
 * piece count: the point of the summary is to compare where win% leaks against
 * where *time* goes, and a player budgets their clock by move number.
 */
export const DEFAULT_PHASES: readonly Phase[] = [
  { name: 'opening', fromMove: 1, toMove: 15 },
  { name: 'middlegame', fromMove: 16, toMove: 30 },
  { name: 'endgame', fromMove: 31 },
]

export interface PhaseSummary {
  readonly name: string
  readonly moves: number
  /** Total win% given away in this phase. */
  readonly swing: number
  /** Win% given away per move — the comparable number across phases of different lengths. */
  readonly swingPerMove: number
  readonly seconds: number | null
  readonly secondsPerMove: number | null
}

/** Summarise one player's moves by phase. Pass the rows you care about (usually `mine`). */
export function summariseByPhase(
  rows: readonly ReviewedMove[],
  phases: readonly Phase[] = DEFAULT_PHASES,
): PhaseSummary[] {
  return phases.map((phase) => {
    const inPhase = rows.filter(
      (r) => r.moveNumber >= phase.fromMove && (phase.toMove === undefined || r.moveNumber <= phase.toMove),
    )
    const swing = inPhase.reduce((total, r) => total + r.swing, 0)
    // A single missing clock reading would understate the total, so the time
    // side of the comparison is reported only when every move in the phase has one.
    const timed = inPhase.every((r) => r.seconds != null)
    const secs = timed ? inPhase.reduce((total, r) => total + (r.seconds ?? 0), 0) : null
    return {
      name: phase.name,
      moves: inPhase.length,
      swing,
      swingPerMove: inPhase.length ? swing / inPhase.length : 0,
      seconds: secs,
      secondsPerMove: secs != null && inPhase.length ? secs / inPhase.length : null,
    }
  })
}

export interface MissedChance {
  /** The opponent's mistake. */
  readonly blunder: ReviewedMove
  /** The reviewed player's reply, absent if the game ended on the blunder. */
  readonly reply: ReviewedMove | null
}

/**
 * The opponent's Tier C moves, paired with what the reviewed player did next.
 * A punished blunder and a let-off look identical in a swing table — the reply
 * is what tells them apart.
 */
export function chancesGiven(rows: readonly ReviewedMove[]): MissedChance[] {
  return rows
    .filter((r) => !r.mine && r.tier === 'C')
    .map((blunder) => ({
      blunder,
      reply: rows.find((r) => r.ply === blunder.ply + 1) ?? null,
    }))
}
