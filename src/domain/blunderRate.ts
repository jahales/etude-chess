import { annotationForSwing } from './annotation.ts'

/**
 * Blunder rate per game — the project's **leading indicator**
 * (docs/development-focus.md §Measurement).
 *
 * Rated game rating is the only real metric and it moves in months; puzzle
 * rating moves in weeks and lies. This is the earliest thing we can measure
 * honestly from the review loop: how often the user hands over the game.
 *
 * What it is not, and must not become (constitution §9, §12):
 *
 * - **Not a score.** It describes the games it was computed from. It says
 *   nothing about skill acquired, and nothing about transfer to a rated game.
 * - **Not a trend.** We have not measured that this number improving means
 *   anything, so we do not draw it as a line, a goal, or a bar to fill.
 * - **Not a figure without an `n`.** Every field a caller needs to state the
 *   sample is on the result, because a rate over four games rendered as
 *   "0.75 per game" is a more confident claim than the data supports.
 */

/**
 * Games below this are too few for the rate to carry information. Blunders per
 * game behave roughly like counts, so the standard error on the mean is about
 * `√rate / √games`: at a rate near 1 and ten games that is ±0.32 — a third of
 * the value, and already generous. Under ten the number is noise wearing two
 * decimal places.
 */
export const MIN_GAMES_FOR_SIGNAL = 10

/** One game's contribution: your blunders in it, over your measured moves. */
export interface GameBlunders {
  blunders: number
  /** Moves of yours the analysis measured. Only a fully measured game gets here. */
  yourMoves: number
}

export interface BlunderRate {
  /** Games the figure rests on. */
  games: number
  /** Your blunders across them. */
  blunders: number
  /** Your moves across them. */
  yourMoves: number
  /**
   * Blunders per game — **undefined over no games**. A rate over an empty
   * sample is not 0.00; rendering it as one would read as a perfect record.
   */
  perGame?: number
  /** Stored games left out, so the caller can say how much it isn't looking at. */
  uncounted: number
  /** True while the sample is too thin to read anything into. */
  smallSample: boolean
}

/**
 * Whether a move that gave up `swing` win-percentage points is a blunder.
 *
 * Deliberately delegated to `annotationForSwing` rather than comparing against
 * `BLUNDER_MIN_SWING` here: the rate then counts *exactly* the moves the move
 * list marks `??`, and the two cannot drift apart. A metric that disagrees with
 * the game it was computed from discredits both.
 *
 * An unmeasured move is not a blunder and not a clean move — it is unknown, and
 * only a game where every one of your moves was measured is counted at all.
 */
export function isBlunder(swing: number | undefined): boolean {
  return annotationForSwing(swing) === '??'
}

export function countBlunders(swings: readonly (number | undefined)[]): number {
  return swings.filter(isBlunder).length
}

/**
 * Fold per-game counts into the rate, carrying everything needed to state the
 * sample honestly. `uncounted` is the number of stored games that could not
 * contribute — the caller decides what disqualifies one; this only makes sure
 * the figure can never be shown without it.
 */
export function blunderRate(
  counted: readonly GameBlunders[],
  uncounted = 0,
): BlunderRate {
  const games = counted.length
  const blunders = counted.reduce((n, g) => n + g.blunders, 0)
  return {
    games,
    blunders,
    yourMoves: counted.reduce((n, g) => n + g.yourMoves, 0),
    perGame: games === 0 ? undefined : blunders / games,
    uncounted,
    smallSample: games < MIN_GAMES_FOR_SIGNAL,
  }
}
