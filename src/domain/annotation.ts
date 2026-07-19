import { TIER_A_MAX_SWING, TIER_B_MAX_SWING } from './grade'

/**
 * Classical move annotations, derived only from what we can actually measure.
 *
 * We ship the three that follow from win%-swing and nothing else:
 *
 * - `?!` inaccuracy, `?` mistake, `??` blunder — each a threshold on how much
 *   win probability the move gave up.
 * - **Not `!!`, `!?` or `!`.** `!!` and `!?` are human judgments about beauty and
 *   speculative/practical value; no engine number implies them. `!` is
 *   defensible as *only-move*, but that needs a multi-line search per position,
 *   which the whole-game pass deliberately doesn't do — so it waits until we
 *   can compute it rather than being guessed at.
 *
 * The reason for the restraint: a glyph is a claim. Chess.com's "Brilliant" is
 * the cautionary case — frequently wrong, and it costs more trust than it buys.
 * A learner who cannot check us has to be able to rely on what we do say
 * (constitution §9, §12).
 */
export type Annotation = '?!' | '?' | '??'

/** Above this, a mistake is a blunder. Splits the existing Tier C for resolution. */
export const BLUNDER_MIN_SWING = 30

export const ANNOTATION_NAME: Record<Annotation, string> = {
  '?!': 'Inaccuracy',
  '?': 'Mistake',
  '??': 'Blunder',
}

/**
 * The annotation for a move that gave up `swing` win-percentage points, or
 * `undefined` for a move good enough not to be marked.
 *
 * Thresholds are the existing tier boundaries, so a move the coach called an
 * inaccuracy is never glyphed as a mistake — two parts of the app disagreeing
 * about the same move would undermine both.
 */
export function annotationForSwing(swing: number | undefined): Annotation | undefined {
  if (swing == null || swing <= TIER_A_MAX_SWING) return undefined
  if (swing <= TIER_B_MAX_SWING) return '?!'
  return swing >= BLUNDER_MIN_SWING ? '??' : '?'
}

/** Which colour moved at this ply, for a game that starts at move 1 with White. */
export function moverColorAt(ply: number): 'w' | 'b' {
  return ply % 2 === 0 ? 'w' : 'b'
}
