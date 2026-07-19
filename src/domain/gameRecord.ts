import type { Tier } from './types'

/**
 * The vocabulary a played game is *recorded* in — shared by the reducer that
 * produces it (`src/app/playMachine`), the adapter that stores it
 * (`src/persist/db`), and the screens that read it back.
 *
 * These live in the domain rather than in the reducer because the persistence
 * adapter must not depend on the application layer: an adapter that imports
 * reducer types makes the on-disk schema a hostage to reducer refactors, and
 * inverts the dependency direction ADR 0015 sets out (domain ← app ← adapters).
 */

/** A position's engine eval (White's perspective) for the bar + move-list scores. */
export interface PositionEval {
  whitePct: number
  label: string
}

/**
 * One coached move of yours in the game as played — the basis for the move-list
 * tiers, accuracy, and the post-game review. Take-backs prune these, so this is
 * always the final line: accuracy reflects the game you actually played, while
 * the separate take-back count is what penalises fiddling (ADR 0017).
 */
export interface CoachEntry {
  ply: number
  /** Position you moved from (for phase detection + the review). */
  fen: string
  san: string
  tier: Tier
  swing: number
  bestMoveSan: string | null
}
