import { Chess } from 'chess.js'
import type { Analyser, AnalyseOptions } from './analyser'
import type { EngineEvaluation, Score } from '../domain/types'
import { gradeMove, type MoveGrade } from '../domain/grade'
import { negate } from '../domain/winPercent'

export interface GradedMove {
  grade: MoveGrade
  bestMoveUci: string | null
  bestScore: Score
  /** The played move's eval, normalised to the mover's perspective. */
  playedScoreMover: Score
  afterFen: string
  userMoveSan: string
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
  if (chess.isCheckmate()) {
    playedScoreMover = { type: 'mate', value: 1 } // the mover delivered mate
  } else if (chess.isGameOver()) {
    playedScoreMover = { type: 'cp', value: 0 } // stalemate / draw
  } else {
    const played = await analyser.evaluate(chess.fen(), opts)
    playedScoreMover = negate(played.score)
  }

  return {
    grade: gradeMove(best.score, playedScoreMover),
    bestMoveUci: best.bestMove,
    bestScore: best.score,
    playedScoreMover,
    afterFen: chess.fen(),
    userMoveSan: applied.san,
  }
}
