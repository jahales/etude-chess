/**
 * Which result a position is heading for, and which moves changed the answer
 * (#161).
 *
 * The owner asked for this and the criterion he named is the right one: **an
 * important move is one that changes the win/draw/loss picture**, not one with a
 * large win% swing. The two come apart in both directions and the project
 * already says so — `.claude/skills/game-review/SKILL.md` §4: *"A swing in a
 * decided position is not a swing in a close one. Check the WDL. If it reads
 * `1000/0/0` before and after, the move cost win% but never risked the result."*
 * +8.0 to +4.0 is an enormous win% swing that risked nothing; +0.3 to −0.3 is a
 * small one that lost the game, and only this rule ranks them the right way
 * round.
 *
 * Three things it deliberately does not do:
 *
 * - **It does not grade.** Nothing here produces a tier, a severity, or a
 *   number to put beside a move. It answers one question — *where should the
 *   next question be?* — and the only thing it decides is **navigation**. Win%
 *   swing → A/B/C remains the one scale in the app (ADR 0010, constitution §9);
 *   a second one would let a move be a mistake on this screen and fine on the
 *   next, which discredits both. That is why `changedResultCategory` returns a
 *   boolean rather than a magnitude: there is no "how much" here to be tempted
 *   into ranking by.
 * - **It does not fill in gaps.** A position with no recorded WDL is
 *   *unmeasurable*, never *unchanged*. `nextImportantMove` counts what it could
 *   not measure and hands the count back, because "no more important moves" and
 *   "the rest was never analysed" are different sentences and #132 was careful
 *   to keep them apart. Reading a missing evaluation as "nothing happened" is
 *   the single easiest way to tell someone they played a clean endgame that was
 *   simply never looked at.
 * - **It does not infer WDL from the score.** A cp→win% sigmoid cannot express
 *   draw likelihood: opposite-coloured bishops at +2.0 is mostly a draw and no
 *   function of the centipawns alone will say so. Approximating would be wrong
 *   in precisely the endgames this distinction exists for, so an evaluation
 *   without a recorded WDL is treated as what it is — unmeasured.
 *
 * Everything is pure and the input is structural, so the rule is testable with
 * three numbers and no engine, no database and no session.
 */

import type { PositionEval } from './gameRecord'
import type { Color, Wdl } from './types'

// ---------- perspective ----------

/**
 * The same WDL seen from the other side. Win and loss trade places; a draw is a
 * draw for both.
 *
 * The engine reports WDL from the **side to move**, so comparing the position
 * before a move against the position after it means comparing two different
 * perspectives — which would read every single move as a total reversal. This
 * is the counterpart of `winPercent.negate` and exists for the same reason.
 */
export function flipWdl(wdl: Wdl): Wdl {
  return { win: wdl.loss, draw: wdl.draw, loss: wdl.win }
}

/**
 * A side-to-move WDL as White's, which is the perspective everything on screen
 * uses (`whiteWinPercent`, `whiteScoreLabel`, the eval bar, the move list).
 */
export function whiteWdl(wdl: Wdl, sideToMove: Color): Wdl {
  return sideToMove === 'w' ? wdl : flipWdl(wdl)
}

// ---------- the category ----------

/**
 * What a position is heading for, coarsely enough that the answer survives a
 * few centipawns.
 *
 * `unclear` is a real answer and not a fallback: a position where no single
 * result is more likely than the other two together is genuinely in the
 * balance, and saying "White is winning" about 480/300/220 would be inventing
 * confidence the engine did not report.
 */
export type ResultCategory = 'white-wins' | 'draw' | 'black-wins' | 'unclear'

/**
 * The threshold, in permille, an outcome must clear to be *the* result.
 *
 * A **majority** — more likely than the other two outcomes combined — chosen
 * because it is the plain-English meaning of "this game is heading for a win"
 * and because it needs no tuning: the three sum to 1000, so at most one outcome
 * can ever clear it and the category is never ambiguous. A plurality rule would
 * call 400/300/300 a win for White, which no one would say out loud.
 *
 * Being a threshold, it has the property every threshold has, and it is worth
 * writing down rather than discovering later: **a category change is a boundary
 * crossing, not a distance.** 900/100/0 → 550/450/0 is a large real shift that
 * this rule calls no change, and 505/495/0 → 495/505/0 is a hair's width that it
 * calls one. That is acceptable here *only* because the output steers
 * navigation: a spurious stop costs one extra position, while a missed one
 * hides the move that lost the game, and the rule errs toward stopping. It
 * would not be acceptable in anything that graded a move, which is the other
 * half of why nothing here does.
 */
export const RESULT_MAJORITY = 500

/** Which result the position is heading for, from White's side. */
export function resultCategory(wdl: Wdl): ResultCategory {
  if (wdl.win > RESULT_MAJORITY) return 'white-wins'
  if (wdl.loss > RESULT_MAJORITY) return 'black-wins'
  if (wdl.draw > RESULT_MAJORITY) return 'draw'
  return 'unclear'
}

/**
 * Did the move between these two positions change the result?
 *
 * Both arguments must already be in the **same** perspective — White's, as
 * everything stored and displayed is. Handing in one side-to-move reading and
 * one White reading compares a position with its own mirror image and reports a
 * reversal on every move, which looks entirely plausible in a list.
 */
export function changedResultCategory(before: Wdl, after: Wdl): boolean {
  return resultCategory(before) !== resultCategory(after)
}

// ---------- skipping to the next one ----------

/** Where to jump, and what changed there. */
export interface ImportantMove {
  /** Index into the `plies` that were handed in — what the caller navigates by. */
  readonly index: number
  /** 0-based ply of the move. */
  readonly ply: number
  /** The result before the move and after it, White's perspective. Never equal. */
  readonly before: ResultCategory
  readonly after: ResultCategory
}

/**
 * The next important move, **and how much of what lies ahead we could actually
 * look at**.
 *
 * The counts are the point, exactly as `KeyMoments.measured` is: a null
 * `target` has three different meanings and a caller that cannot tell them
 * apart will say the wrong one out loud.
 *
 * - `measured > 0`, `unmeasured === 0` — we looked at everything ahead and no
 *   move changed the result. The only case where "nothing more to skip to" is
 *   a claim we have the evidence for.
 * - `unmeasured > 0` — some positions ahead have no recorded WDL. The honest
 *   sentence names the gap; "no more important moves" would be a guess.
 * - both zero — nothing lies ahead at all; this is the last question.
 */
export interface NextImportant {
  readonly target: ImportantMove | null
  /** Positions ahead whose result change could be measured. */
  readonly measured: number
  /** Positions ahead that could not be, for want of a recorded WDL on one side. */
  readonly unmeasured: number
}

export interface NextImportantInput {
  /**
   * The plies the session asks about, in playing order — one per question.
   * Declared as bare numbers rather than as quiz items so the domain stays clear
   * of the harness: what a question *is* belongs to `harness.ts`, and all this
   * rule needs is where each one sits in the game.
   */
  readonly plies: readonly number[]
  /** The question you are on. The scan starts strictly after it. */
  readonly fromIndex: number
  /**
   * `evalByPly[p]` is the evaluation *after* move `p`, White's perspective.
   * **Sparse on purpose**: gaps are normal, and are not zeros.
   */
  readonly evalByPly: readonly (PositionEval | undefined)[] | undefined
  /**
   * The evaluation of the position the game starts from — without it a move at
   * ply 0 has nothing to be compared against, the same reason
   * `keyMoments.selectKeyMoments` takes one.
   */
  readonly startEval?: PositionEval
}

/**
 * The next question whose move changed the result, scanning forward from where
 * you are.
 *
 * Forward only, and the *first* one rather than the worst one: this is a "next"
 * button, so it has to land on the position that comes next. Ranking the
 * candidates would put the reader somewhere further down the game than the move
 * they were about to reach, and choosing which of two result-changing moves
 * matters more is the severity judgment this module does not make.
 */
export function nextImportantMove(input: NextImportantInput): NextImportant {
  const { plies, fromIndex, evalByPly, startEval } = input

  /** The WDL either side of the move at `ply`, or null when either is missing. */
  const around = (ply: number): { before: Wdl; after: Wdl } | null => {
    const before = ply === 0 ? startEval : evalByPly?.[ply - 1]
    const after = evalByPly?.[ply]
    if (!before?.wdl || !after?.wdl) return null
    return { before: before.wdl, after: after.wdl }
  }

  let measured = 0
  let unmeasured = 0
  let target: ImportantMove | null = null

  for (let index = Math.max(-1, fromIndex) + 1; index < plies.length; index++) {
    const ply = plies[index]
    if (ply === undefined) continue
    const pair = around(ply)
    if (!pair) {
      unmeasured++
      continue
    }
    measured++
    // Keep scanning past the first hit rather than returning early: the counts
    // describe the whole of what lies ahead, and a caller that wants to say
    // "3 of the 11 positions ahead were never analysed" needs all of it.
    if (!target && changedResultCategory(pair.before, pair.after)) {
      target = {
        index,
        ply,
        before: resultCategory(pair.before),
        after: resultCategory(pair.after),
      }
    }
  }

  return { target, measured, unmeasured }
}
