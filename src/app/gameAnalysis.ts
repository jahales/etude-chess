import { meanAccuracy } from '../domain/accuracy'
import { swingFromWhitePercent } from '../domain/winPercent'
import type { PositionEval } from '../domain/gameRecord'
import type { StoredGame } from '../persist/db'

/**
 * Batch-analysing a whole stored game: which positions still need work, and how
 * far along we are. Pure — the hook drives the engine, this decides what to ask
 * it and how to fold the answers back in.
 *
 * The pass is typed **structurally** (`AnalysableGame`), so the one pass covers
 * a game you played against Maia and a game you imported (#133) — they live in
 * different tables and share no field but the moves. The figures about *your
 * play* below (`yourPlies`, `accuracyReport`) deliberately stay on `StoredGame`:
 * a coach log and a side of yours are things only a game you played has.
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
 * What an earlier pass recorded: when it finished, and at what budget.
 *
 * Its own type, and taken structurally, because the two fields are kept in two
 * places. A game you played carries them on its own row (`StoredGame`); a game
 * you *imported* keeps them in a table beside the row (`persist/dbGames`'s
 * `DbGameAnalysis`, and `db.ts`'s v7 comment says why). Neither is the pass's
 * business — it only needs to know whether the stored work still counts.
 *
 * Both optional, and absent means "not recorded" rather than an error: v0.2
 * records predate the fields entirely, and a game nobody has analysed simply
 * has nothing to say.
 */
export interface AnalysisRecord {
  /** When a full-game pass last completed. Absent ⇒ never analysed. */
  analysedAt?: number
  /** Nodes per position that pass used, so a later pass can tell if it must redo the work. */
  analysisNodes?: number
}

/**
 * A game this pass can walk: the moves, plus what an earlier pass recorded.
 *
 * `StoredGame` satisfies it, and so does an imported row once its movetext has
 * been split — the same trick `domain/studyGame.DatabaseGame` uses, so one pass
 * serves a game you played and a game you imported without either table
 * learning about the other (#133).
 */
export interface AnalysableGame extends AnalysisRecord {
  sanHistory: readonly string[]
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
  game: AnalysableGame,
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
export function isAnalysed(record: AnalysisRecord, nodes = BATCH_NODES): boolean {
  return record.analysedAt != null && record.analysisNodes === nodes
}

/** Which colour moved at this ply, for a game starting at move 1 with White. */
function moverAt(ply: number): 'w' | 'b' {
  return ply % 2 === 0 ? 'w' : 'b'
}

/**
 * The plies you moved on. One definition, because every figure about *your*
 * play is a mean over this set and two of them disagreeing about which moves
 * were yours would be invisible until the numbers contradicted each other.
 *
 * Assumes the game starts at move 1 with White — true of every `kind: 'game'`
 * record, and the reason a play-out (#48) is not measured by these figures.
 */
export function yourPlies(game: StoredGame): number[] {
  return game.sanHistory
    .map((_, ply) => ply)
    .filter((ply) => moverAt(ply) === game.yourColor)
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
  const plies = yourPlies(game)
  const total = plies.length

  if (isAnalysed(game)) {
    const swings = plies
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
 *
 * What this decides is *which two readings* to difference; the arithmetic itself
 * is `domain/winPercent`'s, which `domain/keyMoments` (#132) also rests on. Two
 * modules differencing evaluations under their own sign conventions is a bug
 * that reads as a plausible number.
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
  return swingFromWhitePercent(before.whitePct, after.whitePct, yourColor)
}
