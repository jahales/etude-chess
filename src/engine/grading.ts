import { Chess } from 'chess.js'
import type { Analyser, AnalyseOptions } from './analyser'
import type { EngineEvaluation, Score, Wdl } from '../domain/types'
import { gradeMove, type MoveGrade } from '../domain/grade'
import { negate } from '../domain/winPercent'
import { flipWdl } from '../domain/resultCategory'

export interface GradedMove {
  grade: MoveGrade
  bestMoveUci: string | null
  bestScore: Score
  /** The played move's eval, normalised to the mover's perspective. */
  playedScoreMover: Score
  afterFen: string
  userMoveSan: string
  /**
   * How the engine says the game goes on **after your move** — UCI, from
   * `afterFen`, so `afterPv[0]` is the reply to what you played (#151).
   *
   * This is the second search's principal variation, which used to be dropped:
   * the search that produced `playedScoreMover` had already computed it. Empty
   * when the move ended the game, and empty when the adapter reported no line —
   * a caller may not read "no continuation" as "nothing follows".
   */
  afterPv: string[]
  /**
   * Win/draw/loss for the position you were asked about, side-to-move's
   * perspective — the same perspective as `bestScore`. Absent when the adapter
   * did not report one (#161).
   */
  bestWdl?: Wdl
  /**
   * Win/draw/loss for the position your move leaves, normalised to the
   * **mover's** perspective exactly as `playedScoreMover` is, so the two
   * readings can be compared across the move without one of them being the
   * mirror of the other.
   */
  playedWdlMover?: Wdl
}

/**
 * Grade a user's move by evaluating the position twice: once for the best line,
 * and once after the played move (negated back to the mover's perspective). This
 * grades *any* move — not just ones the engine happened to list — which is what
 * lets an engine-equal alternative earn full credit (docs/decisions/0004, 0014).
 * Terminal positions after the move are scored without the engine.
 */
export async function evaluateAndGrade(
  analyser: Analyser,
  fen: string,
  userMoveSan: string,
  opts?: AnalyseOptions,
): Promise<GradedMove> {
  const best = await analyser.evaluate(fen, opts)
  return gradeAfterMove(analyser, fen, userMoveSan, best, opts)
}

/**
 * Grade against an already-computed best evaluation — lets the UI reuse the top
 * line from `analyseLines` instead of evaluating the position twice.
 */
export async function gradeAfterMove(
  analyser: Analyser,
  fen: string,
  userMoveSan: string,
  best: EngineEvaluation,
  opts?: AnalyseOptions,
): Promise<GradedMove> {
  const chess = new Chess(fen)
  const applied = chess.move(userMoveSan) // throws if illegal; the UI only submits legal moves

  let playedScoreMover: Score
  // The continuation comes off the *same* search as the score, never a second
  // one: grading is two searches and #151 is explicit that it stays two. A
  // terminal position keeps its empty line, since there is nothing to play on.
  let afterPv: string[] = []
  // WDL rides along with both, and is normalised to the mover the same way the
  // score is (#161).
  let playedWdlMover: Wdl | undefined
  if (chess.isCheckmate()) {
    playedScoreMover = { type: 'mate', value: 1 } // the mover delivered mate
    // Not an estimate and not the engine's opinion — the game is over and the
    // mover won. Synthesised rather than left absent because absent means "not
    // reported", and a delivered mate is the one position whose result is a
    // fact of the rules. The same goes for the draw below.
    playedWdlMover = { win: 1000, draw: 0, loss: 0 }
  } else if (chess.isGameOver()) {
    playedScoreMover = { type: 'cp', value: 0 } // stalemate / draw
    playedWdlMover = { win: 0, draw: 1000, loss: 0 }
  } else {
    const played = await analyser.evaluate(chess.fen(), opts)
    playedScoreMover = negate(played.score)
    afterPv = played.pv ?? (played.bestMove ? [played.bestMove] : [])
    // `played` is from the opponent's point of view — they are to move — so the
    // flip is what makes "before" and "after" comparable at all.
    if (played.wdl) playedWdlMover = flipWdl(played.wdl)
  }

  return {
    grade: gradeMove(best.score, playedScoreMover),
    bestMoveUci: best.bestMove,
    bestScore: best.score,
    playedScoreMover,
    afterFen: chess.fen(),
    userMoveSan: applied.san,
    afterPv,
    ...(best.wdl ? { bestWdl: best.wdl } : {}),
    ...(playedWdlMover ? { playedWdlMover } : {}),
  }
}
