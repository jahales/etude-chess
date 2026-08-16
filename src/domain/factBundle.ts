import { Chess, type Move } from 'chess.js'
import type { Color } from './types'
import type { MoveGrade } from './grade'
// Extension deliberate — see the note in grade.ts. mistakeKind.ts pulls this in,
// and the review script loads that under Node's type stripping.
import { seeCaptureGain } from './see.ts'
import { moveWording, AS_STRONG_AS_ENGINE, type MoveSource } from './moveSource.ts'

// The "fact bundle": everything the coach knows about a move, computed in code.
// v0.1.0 renders it as a rules-based "why"; later the same bundle is what an LLM
// paraphrases/grades (docs/decisions/0012-llm-grounded-explainer.md). The LLM is
// never allowed to invent any of these facts.

export const PIECE_NAME: Record<string, string> = {
  p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king',
}

export interface HangingPiece {
  square: string
  piece: string
  /** Material `color` loses if the opponent captures here, per SEE. */
  loss: number
}

/**
 * Hanging/underdefended pieces of `color`, via Static Exchange Evaluation
 * (`seeCaptureGain`): a piece is flagged when the opponent can win material by
 * capturing it, accounting for the full value-ordered exchange (docs/decisions/0012).
 */
export function findHangingPieces(chess: Chess, color: Color): HangingPiece[] {
  const out: HangingPiece[] = []
  for (const row of chess.board()) {
    for (const sq of row) {
      if (!sq || sq.color !== color || sq.type === 'k') continue
      const loss = seeCaptureGain(chess, sq.square)
      if (loss > 0) out.push({ square: sq.square, piece: sq.type, loss })
    }
  }
  return out
}

/** Material value used to net a capture against the recapture that answers it. */
const PIECE_VALUE: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 }

/**
 * Hanging pieces after `applied` was played, **net of what that move captured**.
 *
 * `findHangingPieces` is a static read of the position, so mid-exchange it calls
 * a perfectly normal capture a blunder: after `1.e4 d5 2.exd5` it reports the d5
 * pawn as hanging, and after the Exchange Ruy `4.Bxc6` it reports the bishop —
 * both even trades, and the second is main-line theory. The recapture isn't a
 * loss, it's the other half of a trade the player already chose.
 *
 * So for the piece that just moved, the material it won is subtracted from what
 * the opponent can win back. Even trades drop out; genuinely bad ones survive
 * with their true cost (take a knight with a rook and lose the rook: 5 − 3 = 2).
 * Every other piece is judged statically, as before — a queen you left en prise
 * while doing something else is still a queen you left en prise.
 */
export function hangingAfterMove(chess: Chess, color: Color, applied: Move): HangingPiece[] {
  const won = applied.captured ? (PIECE_VALUE[applied.captured] ?? 0) : 0
  return findHangingPieces(chess, color).flatMap((h) => {
    if (h.square !== applied.to) return [h]
    const net = h.loss - won
    return net > 0 ? [{ ...h, loss: net }] : []
  })
}

/** Convert a UCI/LAN move (e.g. "g1f3", "e7e8q") to SAN in the given position. */
export function uciToSan(fen: string, uci: string): string | null {
  const chess = new Chess(fen)
  try {
    const move = chess.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion: uci.length > 4 ? uci[4] : undefined,
    })
    return move.san
  } catch {
    return null
  }
}

export interface FactBundle {
  fen: string
  sideToMove: Color
  userMoveSan: string
  bestMoveSan: string | null
  /**
   * The move actually played in the game at this position — by a master, by you,
   * or by whoever else's game this is. `moveSource` is what says which, and
   * nothing here may call it a master's without asking (#158).
   */
  gameMoveSan: string
  /** Who played `gameMoveSan`, and so what every sentence below may call it. */
  moveSource: MoveSource
  grade: MoveGrade
  /** The mover's pieces left hanging after the played move (heuristic). */
  hangingAfterMove: HangingPiece[]
  /** Your move *was* the game's move. Agreement, not a grade — the tier is the grade. */
  matchedGameMove: boolean
}

export interface FactBundleInput {
  /** Position the learner moved from. */
  fen: string
  /** The move the learner played (SAN), already validated as legal. */
  userMoveSan: string
  /** Engine best move (UCI/LAN), or null if unavailable. */
  bestMoveUci: string | null
  /** The move played in the game (SAN) — `QuizItem.masterMoveSan`, historically named. */
  gameMoveSan: string
  /** Carried on the `StudyGame`, decided where the game was built (#158). */
  moveSource: MoveSource
  grade: MoveGrade
}

export function buildFactBundle(input: FactBundleInput): FactBundle {
  const chess = new Chess(input.fen)
  const sideToMove = chess.turn() as Color
  const applied = chess.move(input.userMoveSan)
  return {
    fen: input.fen,
    sideToMove,
    userMoveSan: applied.san,
    bestMoveSan: input.bestMoveUci ? uciToSan(input.fen, input.bestMoveUci) : null,
    gameMoveSan: input.gameMoveSan,
    moveSource: input.moveSource,
    grade: input.grade,
    hangingAfterMove: hangingAfterMove(chess, sideToMove, applied),
    matchedGameMove: applied.san === input.gameMoveSan,
  }
}

/**
 * A short, rules-based plain-language "why" for the reveal.
 *
 * Two things here are claims rather than phrasing, and #158 got both wrong:
 * **who played the game's move** (`moveWording`, never "the master" unless it
 * was one) and **what graded yours** (Stockfish, never the game's move). So the
 * Tier-A verdict for a move that differs from the game's is about the engine —
 * "as strong as the master's choice" was measured against nothing of the sort.
 */
export function explain(b: FactBundle): string {
  const w = moveWording(b.moveSource)
  const parts: string[] = []

  if (b.grade.tier === 'A') {
    parts.push(b.matchedGameMove ? w.matched : AS_STRONG_AS_ENGINE)
  } else if (b.grade.tier === 'B') {
    parts.push('Playable, but it gives something back.')
  } else {
    parts.push('This is a mistake.')
  }

  if (b.grade.tier !== 'A' && b.hangingAfterMove.length > 0) {
    const h = b.hangingAfterMove[0]!
    const name = PIECE_NAME[h.piece] ?? 'piece'
    parts.push(`It leaves your ${name} on ${h.square} hanging (about ${h.loss} point${h.loss === 1 ? '' : 's'}).`)
  }

  if (b.grade.tier !== 'A') {
    if (b.matchedGameMove) {
      // You already played this move once and it is still a mistake. Repeating
      // "in the game you played Qa5+" under a line that just said you played
      // Qa5+ reads as two different moves; the engine's is the only new fact.
      if (b.bestMoveSan && b.bestMoveSan !== b.userMoveSan) {
        parts.push(`The engine prefers ${b.bestMoveSan}.`)
      }
    } else {
      const engineNote =
        b.bestMoveSan && b.bestMoveSan !== b.gameMoveSan
          ? ` (the engine prefers ${b.bestMoveSan})`
          : ''
      parts.push(`${w.sentence} ${b.gameMoveSan}${engineNote}.`)
    }
    parts.push(`That's about ${Math.round(b.grade.swing)}% of your winning chances.`)
  }

  return parts.join(' ')
}

/**
 * Grounded facts as plain text for the ADR-0012 "clipboard handoff": the learner
 * pastes this into their own ChatGPT/Claude. Contains only computed facts.
 *
 * **This is the text #158 was worst in**, and the reason is that nobody reads it
 * before it is pasted. `Master's move: e4` about a 1100-rated blitz move hands
 * an LLM a false premise it will then reason confidently from, and the closing
 * instruction — "explain why <the game's move> is better than <mine>" — asserted
 * something no part of this app has measured: grading compares your move with
 * **Stockfish's**, never with the move played in the game (`engine/grading.ts`).
 * So the game's move is labelled by who played it, the comparison is asked
 * against the engine, and the bundle says outright which of the two graded you.
 */
export function factBundleToText(b: FactBundle): string {
  const side = b.sideToMove === 'w' ? 'White' : 'Black'
  const hanging =
    b.hangingAfterMove.length > 0
      ? b.hangingAfterMove
          .map((h) => `${PIECE_NAME[h.piece] ?? h.piece} on ${h.square} (loses ~${h.loss})`)
          .join(', ')
      : 'none detected'
  // Comparing my move with a better one is the useful question, and only the
  // engine supplies one. With no engine move, or with mine already the engine's,
  // there is nothing to be "better than" and asking for it invites an invention.
  const better = b.bestMoveSan && b.bestMoveSan !== b.userMoveSan ? b.bestMoveSan : null
  const ask = better
    ? `explain why ${better} is better than ${b.userMoveSan} here`
    : `explain what ${b.userMoveSan} achieves here`
  return [
    `Position (FEN): ${b.fen}`,
    `Side to move: ${side}`,
    `My move: ${b.userMoveSan} (tier ${b.grade.tier}, gave up ~${Math.round(b.grade.swing)}% winning chances)`,
    `${moveWording(b.moveSource).field}: ${b.gameMoveSan}`,
    `Engine's best: ${b.bestMoveSan ?? 'n/a'}`,
    `Pieces hanging after my move: ${hanging}`,
    '',
    'The tier came from comparing my move with the engine\'s best. The move played in the game is context, not the standard I was graded against.',
    `In 1–2 sentences a ~1200-rated player would understand, ${ask}. Do not invent moves; use only the facts above.`,
  ].join('\n')
}
