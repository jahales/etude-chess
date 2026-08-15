import type { PositionEval } from './gameRecord'
import type { Color, Tier } from './types'
// Extensions deliberate, and load-bearing — see the note in grade.ts.
import { TIER_A_MAX_SWING, TIER_B_MAX_SWING, tierForSwing } from './grade.ts'
import { swingFromWhitePercent } from './winPercent.ts'

/**
 * Which positions in a game are worth re-deciding (#132).
 *
 * Studying an imported game quizzes **every** hero move past the opening cutoff
 * (`harness.ts:shouldQuiz`). On the owner's own session of 2026-08-14 that was
 * ~30 questions a game, of which ~26 were Tier A: moves with nothing to learn,
 * asked at the same weight as the move that lost the game. This is the rule
 * that picks the handful that decided it, each carrying *why* it was picked so
 * a screen can say so rather than presenting a bare list.
 *
 * Four things it deliberately does not do:
 *
 * - **It does not grade.** The thresholds are `grade.ts`'s tier boundaries and
 *   the arithmetic is win% swing — the same rule the coach, the `?!`/`?`/`??`
 *   glyphs and the blunder rate already run on. A second scale here would let
 *   one move be a mistake on this screen and fine on the next, which discredits
 *   both (constitution §9, ADR 0010).
 * - **It does not fill in gaps.** Evaluations are sparse: a pass can be partial,
 *   and #133's pass over an imported game starts out entirely empty. A move
 *   without an evaluation on *both* sides of it is unmeasurable and is skipped.
 *   Reading a missing evaluation as "unchanged" is the single easiest way to
 *   produce a confident, wrong "you played this perfectly".
 * - **It does not find "the critical position where you found the only move".**
 *   Telling an only-move from one of six equally good moves needs the breadth of
 *   a multi-line search, and the whole-game pass computes one line per position
 *   at a deliberately modest budget (`app/gameAnalysis.ts:BATCH_NODES`). The
 *   data does not exist, so the moment is not offered — the same restraint
 *   `annotation.ts` applies to `!`.
 * - **It does not render or wire anything.** The screen that consumes this is a
 *   later issue; the rule ships first so it can be tested on its own.
 *
 * The input is declared **structurally**, the way `studyGame.ts`'s
 * `DatabaseGame` is: a stored played game satisfies it, so will an analysed
 * database row, and the domain stays free of both adapters.
 */

/**
 * How many moments a game is worth by default.
 *
 * A session-length choice, not a measured one — say so if it is ever put on
 * screen (constitution §12). Two things bound it. Below: the owner's real games
 * carry roughly four non-Tier-A moves, so a smaller cap would routinely drop a
 * genuine mistake and the trainer would be quietly incomplete. Above: a
 * collapse can leave fifteen, and a fifteen-question queue is one you abandon
 * halfway — which costs the moves at the *bottom* of the list, the very ones
 * the ranking says matter least, so a low cap loses nothing that finishing the
 * queue would have taught. Six sits above the typical count and well under the
 * point where a game becomes a chore.
 */
export const DEFAULT_KEY_MOMENT_CAP = 6

/**
 * Why a position was picked.
 *
 * `missed-punish` is not a severity — it is a different lesson. "They handed
 * you something and you did not take it" is a failure to notice a change in the
 * position; an unprovoked mistake is not. Severity still travels on `tier`.
 */
export type KeyMomentReason = 'blunder' | 'mistake' | 'missed-punish'

/** The opponent's mistake that set up a `missed-punish`. */
export interface Chance {
  readonly ply: number
  readonly san: string
  /** Win% *they* gave up. More than `TIER_B_MAX_SWING`, or it would not be a gift. */
  readonly swing: number
}

export interface KeyMoment {
  /** 0-based ply of the hero's move. */
  readonly ply: number
  readonly san: string
  readonly reason: KeyMomentReason
  /** Win% this move gave up. Above `TIER_A_MAX_SWING`, or it would not be here. */
  readonly swing: number
  /** The tier that swing earns, so the label can name the lesson without hiding the size. */
  readonly tier: Tier
  /** Present only on a `missed-punish`. */
  readonly chance?: Chance
}

/**
 * The moments, **and how much of the game they were chosen from**.
 *
 * The coverage is the point, because an empty `moments` has two very different
 * meanings and the caller has to be able to tell them apart:
 *
 * - `measured === 0` — nothing was measurable. Usually "not analysed yet".
 * - `measured > 0` and no moments — analysed this far, and you played clean.
 *
 * Reporting only the list would make the second indistinguishable from the
 * first, and "nothing to study" is a claim we would be making without evidence.
 */
export interface KeyMoments {
  readonly moments: readonly KeyMoment[]
  /** Your moves whose cost could be measured — an evaluation on both sides of the move. */
  readonly measured: number
  /** Your moves in the game. */
  readonly total: number
  /**
   * True when every move you played was measured. False over a game with no
   * moves of yours: 0 of 0 is not a game we looked at closely.
   */
  readonly complete: boolean
}

export interface KeyMomentsInput {
  /** The side being trained. Moments are only ever about their decisions. */
  readonly heroColor: Color
  readonly sanHistory: readonly string[]
  /**
   * `evalByPly[p]` is the evaluation *after* move `p`, White's perspective.
   * **Sparse on purpose**: gaps are normal and are not zeros.
   */
  readonly evalByPly: readonly (PositionEval | undefined)[] | undefined
  /**
   * The evaluation of the position the game starts from. Without it the first
   * move has nothing to be differenced against and is permanently unmeasurable
   * — the same reason `app/gameAnalysis.ts:evalSwingAt` takes one.
   */
  readonly startEval?: PositionEval
  /**
   * Who moves at ply 0. Defaults to White, which is every played game, but an
   * imported study or endgame can begin on Black's move (#128 keeps a game's
   * starting position). Assuming parity instead would silently select the
   * *opponent's* moves as the hero's, and the list would look perfectly normal.
   */
  readonly firstMover?: Color
}

/**
 * The handful of positions worth re-deciding, worst first.
 *
 * Ranked by what the move cost and nothing else: the reason labels the lesson,
 * it does not reweight the ranking, because weighting one kind of mistake above
 * another is exactly the second scale this must not invent. Ties break by
 * playing order so the list is stable across runs.
 */
export function selectKeyMoments(
  input: KeyMomentsInput,
  cap = DEFAULT_KEY_MOMENT_CAP,
): KeyMoments {
  const { heroColor, sanHistory, evalByPly, startEval, firstMover = 'w' } = input
  const moverAt = (ply: number): Color =>
    ply % 2 === 0 ? firstMover : firstMover === 'w' ? 'b' : 'w'

  /**
   * What the move at `ply` cost its mover, or `undefined` when either side of
   * it is missing. Unmeasurable and clean are different answers and this is
   * where they stay different.
   */
  const swingAt = (ply: number): number | undefined => {
    const before = ply === 0 ? startEval : evalByPly?.[ply - 1]
    const after = evalByPly?.[ply]
    if (!before || !after) return undefined
    return swingFromWhitePercent(before.whitePct, after.whitePct, moverAt(ply))
  }

  const moments: KeyMoment[] = []
  let measured = 0
  let total = 0

  for (let ply = 0; ply < sanHistory.length; ply++) {
    const san = sanHistory[ply]
    if (san === undefined || moverAt(ply) !== heroColor) continue
    total++

    const swing = swingAt(ply)
    if (swing === undefined) continue
    measured++
    if (swing <= TIER_A_MAX_SWING) continue

    // Moves alternate, so the previous ply is always the opponent's. It counts
    // as a gift only if it was *measured* to have cost them more than a
    // concession — a gap there says nothing about what they handed over, and a
    // guess would put the wrong lesson on the position.
    const theirSwing = ply > 0 ? swingAt(ply - 1) : undefined
    const theirSan = sanHistory[ply - 1]
    const gift =
      theirSwing !== undefined && theirSwing > TIER_B_MAX_SWING && theirSan !== undefined
        ? { ply: ply - 1, san: theirSan, swing: theirSwing }
        : undefined

    moments.push({
      ply,
      san,
      reason: gift ? 'missed-punish' : swing > TIER_B_MAX_SWING ? 'blunder' : 'mistake',
      swing,
      tier: tierForSwing(swing),
      ...(gift ? { chance: gift } : {}),
    })
  }

  moments.sort((a, b) => b.swing - a.swing || a.ply - b.ply)
  return {
    // Clamped, because a negative cap must not mean "everything but the worst".
    moments: moments.slice(0, Math.max(0, cap)),
    measured,
    total,
    complete: total > 0 && measured === total,
  }
}
