import {
  blunderRate,
  countBlunders,
  type BlunderRate,
  type GameBlunders,
} from '../domain/blunderRate'
import { evalSwingAt, isAnalysed, yourPlies } from './gameAnalysis'
import { gameKind, type StoredGame } from '../persist/db'

/**
 * The leading indicator (#65, docs/development-focus.md §Measurement) read off
 * the games already in the library. Pure — the domain holds the rule, this
 * applies it to what is stored.
 *
 * Nothing here recomputes anything: the whole-game pass (#68) already scored
 * every position and persisted the result, so a blunder is a subtraction
 * between two stored evaluations.
 *
 * **A game earns its way into the number.** The bar is a *completed* pass that
 * measured every move you played, and the reason is #74: the coach grades your
 * moves in order and stops when the game does, so anything short of a completed
 * pass is a mean over your opening moves wearing the label of a whole game. It
 * reads flatteringly and it is wrong in a direction the user cannot detect. A
 * game that does not clear the bar is *uncounted*, never assumed clean.
 */

/** Why a stored game contributes nothing. Shown per row so the total is checkable. */
export type UncountedReason =
  | 'not analysed'
  | 'partly measured'
  | 'play-out'
  | 'no moves of yours'

export type GameBlunderResult =
  | ({ counted: true } & GameBlunders)
  | { counted: false; reason: UncountedReason }

/**
 * Your blunders in one stored game, or why it cannot be counted.
 *
 * Every field it reads is optional on `StoredGame` — v0.2 records predate all of
 * them — so an old game falls out as `not analysed` rather than erroring.
 */
export function gameBlunders(game: StoredGame): GameBlunderResult {
  // A play-out starts from a position rather than move 1, so ply parity no
  // longer says who moved and we would credit the opponent's blunders to you
  // (the same assumption `app/replay.ts` documents). "Per game" over a fragment
  // is not the quantity being measured either. Left to #48 rather than guessed.
  if (gameKind(game) === 'playout') return { counted: false, reason: 'play-out' }
  if (!isAnalysed(game)) return { counted: false, reason: 'not analysed' }

  const plies = yourPlies(game)
  // Zero blunders over zero moves is not a clean game — it is no evidence, and
  // averaging it in would pull the rate down for free.
  if (plies.length === 0) return { counted: false, reason: 'no moves of yours' }

  const swings = plies.map((ply) =>
    evalSwingAt(game.evalByPly, ply, game.yourColor, game.startEval),
  )
  // A completed pass can still leave a move unmeasured: a gap in `evalByPly`, or
  // an older record with no `startEval`, whose first move has nothing to be
  // measured against. Counting the remainder would be a rate over an unstated
  // subset, which is exactly what #74 was.
  if (swings.some((s) => s === undefined)) return { counted: false, reason: 'partly measured' }

  return { counted: true, blunders: countBlunders(swings), yourMoves: plies.length }
}

/** The rate across a set of stored games, with the games it could not use. */
export function blunderRateOf(games: readonly StoredGame[]): BlunderRate {
  const counted: GameBlunders[] = []
  let uncounted = 0
  for (const game of games) {
    const result = gameBlunders(game)
    if (result.counted) counted.push(result)
    else uncounted += 1
  }
  return blunderRate(counted, uncounted)
}
