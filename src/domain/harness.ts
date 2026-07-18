import { Chess } from 'chess.js'
import type { Color } from './types'

// The guess-the-move harness: turn a master game into a sequence of quiz
// positions (the hero side's non-trivial moves). See docs/v0.1.0-plan.md.

export interface ParsedGame {
  headers: Record<string, string>
  /** Moves in SAN order. */
  sanMoves: string[]
  result: string
  white: string
  black: string
}

export interface QuizItem {
  /** FEN of the position the learner must move from. */
  fen: string
  /** 0-based ply index in the game. */
  ply: number
  /** 1-based full-move number (for display). */
  moveNumber: number
  sideToMove: Color
  /** The master's move, SAN. */
  masterMoveSan: string
  /** The master's move, UCI/LAN (e.g. "e2e4"). */
  masterMoveUci: string
}

export interface QuizOptions {
  /** The side the learner plays (guesses moves for). */
  heroColor: Color
  /** Don't quiz before this ply — skips opening theory. Default 8 (after move 4). */
  startPly?: number
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
  const chess = new Chess()
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
