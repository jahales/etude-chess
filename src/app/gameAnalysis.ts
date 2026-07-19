import { meanAccuracy } from '../domain/accuracy'
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
export function pliesNeedingAnalysis(
  game: StoredGame,
  nodes = BATCH_NODES,
  /**
   * Positions actually reconstructable from the move list. A record whose SAN
   * cannot be fully replayed has fewer, and asking for the rest means the pass
   * can never reach 100% — so it would never mark itself complete and would redo
   * every position on each attempt, forever.
   */
  replayablePositions = game.sanHistory.length + 1,
): number[] {
  if (isAnalysed(game, nodes)) return []
  const measurable = Math.max(0, Math.min(game.sanHistory.length, replayablePositions - 1))
  return Array.from({ length: measurable }, (_, ply) => ply)
}

/** Whether a completed pass at this budget already covers the game. */
export function isAnalysed(game: StoredGame, nodes = BATCH_NODES): boolean {
  return game.analysedAt != null && game.analysisNodes === nodes
}

/** Which colour moved at this ply, for a game starting at move 1 with White. */
function moverAt(ply: number): 'w' | 'b' {
  return ply % 2 === 0 ? 'w' : 'b'
}

/**
 * A game's accuracy **and how much of the game it covers**.
 *
 * The coverage is the point. `coachLog` only holds moves the coach finished
 * grading before the game ended, so resigning (or simply moving fast) leaves it
 * holding a subset — usually the early, good moves — and the mean over that
 * subset reads far too high. A game could show "99.18% accuracy" directly above
 * a move flagged as a 16% mistake (#74).
 *
 * So: prefer a completed analysis pass, which covers every move by construction.
 * Fall back to the coach log, and report how many moves the figure actually rests
 * on so the UI can say when it is partial rather than implying it is the whole
 * game.
 */
export interface AccuracyReport {
  accuracy: number
  /** Your moves the figure is computed from. */
  covered: number
  /** Your moves in the game. */
  total: number
  source: 'analysis' | 'coach'
  /** True when the figure rests on every move you played. */
  complete: boolean
}

export function accuracyReport(game: StoredGame): AccuracyReport {
  const yourPlies = game.sanHistory
    .map((_, ply) => ply)
    .filter((ply) => moverAt(ply) === game.yourColor)
  const total = yourPlies.length

  if (isAnalysed(game)) {
    const swings = yourPlies
      .map((ply) => evalSwingAt(game.evalByPly, ply, game.yourColor, game.startEval))
      .filter((s): s is number => s !== undefined)
      // A move that gained ground is not better than perfect; clamp so it can't
      // pull a mediocre game's mean upward.
      .map((s) => Math.max(0, s))
    return {
      accuracy: meanAccuracy(swings),
      covered: swings.length,
      total,
      source: 'analysis',
      complete: swings.length === total,
    }
  }

  const swings = (game.coachLog ?? []).map((e) => e.swing)
  return {
    accuracy: meanAccuracy(swings),
    covered: swings.length,
    total,
    source: 'coach',
    complete: swings.length === total,
  }
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
 * How the game's evaluation moved across the move at `ply`, in win% — positive
 * means the mover gave up ground. This is what "where did the game turn" reads
 * off, and what per-move accuracy is computed from.
 *
 * Needs the evaluation on *both* sides of the move. For ply 0 that is the start
 * position, which `evalByPly` cannot hold (it is indexed by the move each
 * evaluation follows) — hence `startEval`. Without it the first move of every
 * game is permanently unmeasurable.
 */
export function evalSwingAt(
  evals: (PositionEval | undefined)[] | undefined,
  ply: number,
  yourColor: 'w' | 'b',
  startEval?: PositionEval,
): number | undefined {
  const before = ply === 0 ? startEval : evals?.[ply - 1]
  const after = evals?.[ply]
  if (!before || !after) return undefined
  const delta = after.whitePct - before.whitePct
  // whitePct is always White's perspective, so Black's losses are positive deltas.
  return yourColor === 'w' ? -delta : delta
}
