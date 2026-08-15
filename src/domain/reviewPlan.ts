/**
 * Reviewing a game of your own: what to offer first, and what may be offered at
 * all (#144).
 *
 * The pieces this composes already exist — `keyMoments.ts` picks the moments,
 * `studyGame.ts` turns a row into a session, `app/gameAnalysis.ts` runs the
 * pass. What was missing is the judgment *between* them, and it is all of the
 * same kind: deciding when we know enough to make a claim.
 *
 * Two claims this module exists to stop being made by accident:
 *
 * - **"These are your critical positions."** That is a claim about every move
 *   you played, so it needs every move you played to have been measured. A pass
 *   that was interrupted, or never run, produces a *shorter* list rather than an
 *   error — the moments it found are real, but the ones it never looked at are
 *   invisible, and six positions out of a game whose actual blunder was never
 *   scored is a confident lie. So `criticalOffer` refuses on anything short of a
 *   complete pass and says which kind of incomplete it was.
 * - **"You played this clean."** Distinguishable from the above only by
 *   coverage, which is why `selectKeyMoments` returns `measured`/`total` and why
 *   they are carried all the way to the screen here rather than collapsed into
 *   an empty list (#132's own note says the same).
 *
 * Everything here is pure and the input is structural, so the ordering rules can
 * be tested without a database and the offer without an engine.
 */

import type { Color } from './types'
import type { KeyMoment, KeyMoments } from './keyMoments.ts'
import type { StudyGame } from './studyGame.ts'
import { buildQuiz, parseGame } from './harness.ts'

// ---------- which games to review first ----------

/**
 * How much a game is worth opening, as far as anything recorded can tell.
 *
 * `not-yours` is a real answer and not a fallback: with no names given, or names
 * that match neither player, nothing here knows whether the result was a loss.
 * Calling such a game a win or a loss anyway would put a confident order on a
 * list that has no information in it, so it gets its own bucket and the screen
 * can say why the ordering is thin.
 */
export type ReviewPriority = 'lost' | 'undecided' | 'won' | 'not-yours'

/** The fields the ordering reads. A `DbGame` satisfies it. */
export interface ReviewCandidate {
  /** Whatever identifies the row to the caller; never interpreted here. */
  readonly key: string
  /** The game's result tag, as the file wrote it. */
  readonly result: string
  /** The side you played, from `studyGame.yourSide`, or `null` for "can't tell". */
  readonly yours: Color | null
  /** True when a completed pass at the *current* budget already covers it. */
  readonly analysed: boolean
}

/**
 * Loss, draw, win — from your side, when we know which side that is.
 *
 * A game the file left unfinished (`*`) sits with the draws rather than with
 * the wins: it is not a game you lost, and it is not one you won either.
 */
export function reviewPriority(game: { result: string; yours: Color | null }): ReviewPriority {
  const { result, yours } = game
  if (!yours) return 'not-yours'
  if (result === '1-0') return yours === 'w' ? 'won' : 'lost'
  if (result === '0-1') return yours === 'b' ? 'won' : 'lost'
  return 'undecided'
}

const PRIORITY_ORDER: Record<ReviewPriority, number> = {
  lost: 0,
  undecided: 1,
  won: 2,
  'not-yours': 3,
}

/**
 * The games worth reviewing, first.
 *
 * The result leads and the analysis state breaks the tie, in that order,
 * because they answer different questions: the result is *whether this game has
 * something to teach*, and "not analysed yet" is only *whether the work has been
 * done*. A won game you have not analysed is still a won game.
 *
 * **This orders the page it is given, not the database.** Results come back
 * through whichever index answered the filter (`persist/dbGames.queryDbGames`),
 * and re-ordering a page cannot pull a loss forward from page four — sorting the
 * whole set would mean loading the whole set, which is what paging exists to
 * avoid. The screen says so; putting it only here would let a later caller
 * assume otherwise. Deliberately **stable**, so games of equal priority stay in
 * the index's order rather than in an arbitrary one that changes between reads.
 */
export function orderForReview<T extends ReviewCandidate>(candidates: readonly T[]): T[] {
  return candidates
    .map((candidate, index) => ({ candidate, index }))
    .sort(
      (a, b) =>
        PRIORITY_ORDER[reviewPriority(a.candidate)] - PRIORITY_ORDER[reviewPriority(b.candidate)] ||
        Number(a.candidate.analysed) - Number(b.candidate.analysed) ||
        a.index - b.index,
    )
    .map((entry) => entry.candidate)
}

// ---------- what the review may offer ----------

/**
 * The opening cutoff does not apply to a moment that was *selected*.
 *
 * `harness.DEFAULT_START_PLY` skips the first four moves because quizzing
 * memorised theory teaches nothing — a rule about moves nobody chose to ask
 * about. A key moment is here because it measurably cost win%, and a blunder on
 * move three is exactly the position a review exists for. Applying the cutoff
 * would drop it from the list *silently*, which is the failure this whole module
 * is about.
 */
export const CRITICAL_START_PLY = 0

/** Why the critical-positions path cannot be offered. Each is a different sentence. */
export type CriticalBlocker =
  /** No completed pass at this budget. The list would be of what was scored so far. */
  | 'not-analysed'
  /** A pass ran but left moves of yours unmeasured — see `KeyMoments.measured`. */
  | 'partial'
  /** Every move of yours was measured and none cost more than Tier A. */
  | 'clean'
  /** Moments were found, and none of them is a position that can be quizzed. */
  | 'unquizzable'

export type CriticalOffer =
  | {
      ok: true
      /** The hero plies to ask about, in playing order. */
      plies: number[]
      /** The moments those plies came from, worst first — the ranking `selectKeyMoments` made. */
      moments: readonly KeyMoment[]
      /** How many questions the session will ask. Equal to `plies.length`. */
      positions: number
      /**
       * Moments that exist but cannot be asked — no legal choice at that ply, or
       * movetext that stops replaying before it. Non-zero means the session is
       * **smaller than the finding**, which the screen has to say rather than
       * quietly showing fewer.
       */
      unaskable: number
      /** Your moves that were measured, and how many you played. Carried for the caveat. */
      measured: number
      total: number
    }
  | {
      ok: false
      reason: CriticalBlocker
      measured: number
      total: number
      /** Moments found so far. Non-empty under `partial` — real, but not the whole list. */
      moments: readonly KeyMoment[]
    }

/**
 * Whether the critical positions may be offered, and which ones.
 *
 * Takes the *selection* rather than the evaluations: `selectKeyMoments` owns the
 * rule about which moves cost enough to be worth re-deciding, and a second
 * opinion here would be the second grading scale #132 refuses to invent. What
 * this adds is the two things selection cannot know — whether the pass that fed
 * it was complete, and whether the positions can actually be asked as questions.
 *
 * The quiz is built here and **thrown away**, the same promise-then-rebuild
 * `studyGame.planStudy` makes: the reducer builds its own from the same pure
 * function, so a plan that says "four positions" is a session that asks four.
 */
export function criticalOffer(studyGame: StudyGame, found: KeyMoments): CriticalOffer {
  const { measured, total, complete, moments } = found

  // Coverage first, and before the list is even looked at. An incomplete pass
  // can still have found moments — they are real — but the moves it never
  // scored are indistinguishable from moves that were fine, so a list drawn
  // from it is not "the positions that decided this game".
  if (measured === 0) return { ok: false, reason: 'not-analysed', measured, total, moments }
  if (!complete) return { ok: false, reason: 'partial', measured, total, moments }
  if (moments.length === 0) return { ok: false, reason: 'clean', measured, total, moments }

  const askable = quizzablePlies(studyGame, moments)
  if (askable.length === 0) {
    return { ok: false, reason: 'unquizzable', measured, total, moments }
  }

  return {
    ok: true,
    // Playing order, not severity order: you re-decide the game forwards. The
    // ranking is not lost — `moments` keeps it, and the screen lists them by it.
    plies: askable,
    moments,
    positions: askable.length,
    unaskable: moments.length - askable.length,
    measured,
    total,
  }
}

/**
 * The moment plies that survive the quiz rules, in playing order.
 *
 * A moment can fail to be a question for reasons that have nothing to do with
 * how bad the move was: the position had one legal move (no decision to make),
 * or the movetext stops replaying before it. Both are silent in `buildQuiz`,
 * which simply emits fewer items — hence intersecting rather than trusting.
 */
function quizzablePlies(studyGame: StudyGame, moments: readonly KeyMoment[]): number[] {
  const wanted = new Set(moments.map((m) => m.ply))
  let items
  try {
    const parsed = parseGame(studyGame.pgn)
    items = buildQuiz(parsed.sanMoves, {
      // The side is the caller's — a game with no winner has no answer to derive
      // one from, and `studyGame.heroColor` is where that choice was recorded.
      heroColor: studyGame.heroColor ?? 'w',
      startPly: CRITICAL_START_PLY,
      ...(parsed.startFen ? { startFen: parsed.startFen } : {}),
    })
  } catch {
    // Unreadable movetext is already `planStudy`'s refusal; reaching it here
    // means no position can be asked, which is the same answer.
    return []
  }
  return items.filter((item) => wanted.has(item.ply)).map((item) => item.ply)
}
