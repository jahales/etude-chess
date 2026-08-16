import { Chess } from 'chess.js'
import type { Color } from './types'

// The guess-the-move harness: turn a game into a sequence of quiz positions (the
// hero side's non-trivial moves). See docs/v0.1.0-plan.md. It was a *master*
// game until #55 made the attached database a source too, and the naming below
// still reads that way — see `QuizItem.masterMoveSan`.

export interface ParsedGame {
  headers: Record<string, string>
  /** Moves in SAN order. */
  sanMoves: string[]
  result: string
  white: string
  black: string
  /**
   * The position the moves start from, when the PGN named one.
   *
   * Surfaced here rather than left in `headers` so that `buildQuiz` can be
   * given it without every caller remembering the tag exists. `parseGame`
   * honours `[SetUp]`/`[FEN]` by itself; `buildQuiz` takes bare SAN and cannot,
   * so the two had to be joined up somewhere and this is the seam.
   */
  startFen?: string
}

export interface QuizItem {
  /** FEN of the position the learner must move from. */
  fen: string
  /** 0-based ply index in the game. */
  ply: number
  /** 1-based full-move number (for display). */
  moveNumber: number
  sideToMove: Color
  /**
   * The move actually played in the game at this position, SAN.
   *
   * The *name* is v0.1.0's, when the pack of master games was the only thing a
   * quiz could be built from; the field is right and the word is not. Since #55
   * a quiz item is as likely to hold a club player's move, and since #158 what
   * to *call* it travels separately, on `StudyGame.moveSource` — this is a
   * quizzed position and knows nothing about whose game it came out of.
   */
  masterMoveSan: string
  /** The same move, UCI/LAN (e.g. "e2e4"). Same caveat about the name. */
  masterMoveUci: string
}

export interface QuizOptions {
  /** The side the learner plays (guesses moves for). */
  heroColor: Color
  /** Don't quiz before this ply — skips opening theory. Default 8 (after move 4). */
  startPly?: number
  /**
   * The position the moves start from, when it is not the standard one.
   *
   * `parseGame` reads a PGN and so honours `[SetUp]`/`[FEN]` on its own, but
   * this takes bare SAN and replayed it from the initial position regardless —
   * so an imported study or endgame threw `Invalid move` on its first move and
   * the caller reported the file as unreadable (#55 follow-up).
   */
  startFen?: string
}

export const DEFAULT_START_PLY = 8

/** Parse a single-game PGN. Throws (via chess.js) on invalid PGN. */
export function parseGame(pgn: string): ParsedGame {
  const chess = new Chess()
  chess.loadPgn(pgn)
  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries(chess.header())) {
    if (v != null) headers[k] = v
  }
  return {
    headers,
    sanMoves: chess.history(),
    result: headers.Result ?? '*',
    white: headers.White ?? 'White',
    black: headers.Black ?? 'Black',
    ...(headers.FEN ? { startFen: headers.FEN } : {}),
  }
}

/** The winning side plays the quiz; draws have no obvious hero. */
export function heroColorFromResult(result: string): Color | null {
  if (result === '1-0') return 'w'
  if (result === '0-1') return 'b'
  return null
}

/**
 * A position is quizzed only when it's the hero's turn, past the opening cutoff,
 * and there's a real choice to make (more than one legal move). Pure so the rule
 * is directly testable.
 */
export function shouldQuiz(
  sideToMove: Color,
  heroColor: Color,
  ply: number,
  legalMoveCount: number,
  startPly: number,
): boolean {
  return sideToMove === heroColor && ply >= startPly && legalMoveCount > 1
}

/** Replay the game, emitting a quiz item at each of the hero's non-trivial moves. */
export function buildQuiz(sanMoves: string[], options: QuizOptions): QuizItem[] {
  const startPly = options.startPly ?? DEFAULT_START_PLY
  const chess = options.startFen ? new Chess(options.startFen) : new Chess()
  const items: QuizItem[] = []
  for (let ply = 0; ply < sanMoves.length; ply++) {
    const san = sanMoves[ply]!
    const sideToMove = chess.turn() as Color
    const legalMoveCount = chess.moves().length
    const fen = chess.fen()
    const applied = chess.move(san) // throws if the game data is invalid
    if (shouldQuiz(sideToMove, options.heroColor, ply, legalMoveCount, startPly)) {
      items.push({
        fen,
        ply,
        moveNumber: Math.floor(ply / 2) + 1,
        sideToMove,
        masterMoveSan: san,
        masterMoveUci: applied.lan,
      })
    }
  }
  return items
}
