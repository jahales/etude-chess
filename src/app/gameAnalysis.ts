import type { PositionEval } from '../domain/gameRecord'
import type { StoredGame } from '../persist/db'

/**
 * Batch-analysing a whole stored game: which positions still need work, and how
 * far along we are. Pure — the hook drives the engine, this decides what to ask
 * it and how to fold the answers back in.
 */

/**
 * Nodes per position for a full-game pass. Lower than the live coach's grading
 * budget on purpose: the point here is *coverage* of every position, not depth
 * on one. Deep analysis stays available per-position on request.
 */
export const BATCH_NODES = 150_000

export interface AnalysisProgress {
  done: number
  total: number
  /** True once every position has an evaluation from a completed pass. */
  complete: boolean
}

/**
 * Plies still needing an evaluation.
 *
 * `evalByPly[p]` is the evaluation *after* move `p`, so a game of n moves needs
 * plies `0..n-1`. Evaluations recorded live are kept only when the whole game was
 * already analysed at the same budget — otherwise the pass redoes them, because
 * mixing node counts would make the resulting scores (and the annotation glyphs
 * derived from them) inconsistent across a single game for no visible reason.
 */
export function pliesNeedingAnalysis(game: StoredGame, nodes = BATCH_NODES): number[] {
  if (isAnalysed(game, nodes)) return []
  return game.sanHistory.map((_, ply) => ply)
}

/** Whether a completed pass at this budget already covers the game. */
export function isAnalysed(game: StoredGame, nodes = BATCH_NODES): boolean {
  return game.analysedAt != null && game.analysisNodes === nodes
}

/** Fold one position's result into the eval array without mutating the original. */
export function withEvalAt(
  evals: (PositionEval | undefined)[] | undefined,
  ply: number,
  evaluation: PositionEval,
): (PositionEval | undefined)[] {
  const next = (evals ?? []).slice()
  next[ply] = evaluation
  return next
}

export function progressOf(done: number, total: number): AnalysisProgress {
  return { done, total, complete: total > 0 && done >= total }
}

/**
 * How the game's evaluation moved across your move at `ply`, in win% —
 * positive means it went against you. This is what "where did the game turn"
 * reads off, and it needs both surrounding evaluations, so the first move of a
 * game (no prior evaluation) has no swing.
 */
export function evalSwingAt(
  evals: (PositionEval | undefined)[] | undefined,
  ply: number,
  yourColor: 'w' | 'b',
): number | undefined {
  const before = ply === 0 ? undefined : evals?.[ply - 1]
  const after = evals?.[ply]
  if (!before || !after) return undefined
  const delta = after.whitePct - before.whitePct
  // whitePct is always White's perspective, so Black's losses are positive deltas.
  return yourColor === 'w' ? -delta : delta
}
