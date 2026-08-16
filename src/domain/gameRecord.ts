import type { Tier, Wdl } from './types'

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
  /**
   * Win/draw/loss for the position, **White's perspective** like `whitePct`
   * (#161). Absent means "not recorded" — every pass run before this field
   * existed, and any position the engine did not report one for.
   *
   * ## Why the real thing is stored rather than approximated
   *
   * Skipping *ahead* to the next move that changed the result needs the result
   * picture for positions you have not reached, and #161 named two ways to get
   * one. The other was to derive it from `whitePct` with thresholds, which needs
   * no new field — and which is wrong in exactly the positions the feature
   * exists for. A cp→win% sigmoid has no term for draw likelihood, so an
   * opposite-coloured-bishop endgame at +2.0 comes out looking like a position
   * White is winning, and the whole point of asking for WDL was to stop the app
   * saying that. An approximation that fails precisely where the distinction
   * matters is not a cheaper version of the feature; it is a confident wrong
   * answer wearing its clothes.
   *
   * ## Why it did not cost a schema version
   *
   * The issue expected a Dexie bump, and #152 was in flight over
   * `src/persist/**` at the time, so it was worth checking rather than assuming.
   * It does not: `db.ts` declares `dbAnalysis: 'key'`, so the store is keyed and
   * indexed on `key` alone and an eval is an unindexed value inside the record.
   * IndexedDB stores structured clones, so a new **optional** field on a value
   * object is read back by old and new code alike. That is the forward-compatible
   * -records rule in `docs/architecture.md` doing its job, and it is the reason
   * this shipped without touching the persistence layer or colliding with #152.
   *
   * The corollary is the part a reader has to keep hold of: **a stored analysis
   * that predates this field is not a game where nothing changed the result.**
   * It is a game we cannot answer the question for, and
   * `domain/resultCategory.nextImportantMove` counts those separately so a screen
   * can say which of the two it means.
   */
  wdl?: Wdl
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
