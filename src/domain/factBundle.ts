import { Chess } from 'chess.js'
import type { Color } from './types'
import type { MoveGrade } from './grade'

// The "fact bundle": everything the coach knows about a move, computed in code.
// v0.1.0 renders it as a rules-based "why"; later the same bundle is what an LLM
// paraphrases/grades (docs/decisions/0012-llm-grounded-explainer.md). The LLM is
// never allowed to invent any of these facts.

const PIECE_VALUE: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 100 }
const PIECE_NAME: Record<string, string> = {
  p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king',
}

export interface HangingPiece {
  square: string
  piece: string
  cheapestAttacker: number
  defended: boolean
}

/**
 * Heuristic hanging/underdefended detection for `color`'s pieces: a piece is
 * flagged if it's attacked and either undefended or its cheapest attacker is
 * worth less than it. This is NOT full SEE — it ignores pins and multi-piece
 * exchange ordering (a known first-pass limitation, docs/research/llm-integration.md §2b).
 */
export function findHangingPieces(chess: Chess, color: Color): HangingPiece[] {
  const enemy: Color = color === 'w' ? 'b' : 'w'
  const out: HangingPiece[] = []
  for (const row of chess.board()) {
    for (const sq of row) {
      if (!sq || sq.color !== color || sq.type === 'k') continue
      const attackers = chess.attackers(sq.square, enemy)
      if (attackers.length === 0) continue
      const defenders = chess.attackers(sq.square, color)
      const cheapestAttacker = Math.min(
        ...attackers.map((a) => PIECE_VALUE[chess.get(a)!.type] ?? 0),
      )
      const pieceVal = PIECE_VALUE[sq.type] ?? 0
      if (defenders.length === 0 || cheapestAttacker < pieceVal) {
        out.push({
          square: sq.square,
          piece: sq.type,
          cheapestAttacker,
          defended: defenders.length > 0,
        })
      }
    }
  }
  return out
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
  masterMoveSan: string
  grade: MoveGrade
  /** The mover's pieces left hanging after the played move (heuristic). */
  hangingAfterMove: HangingPiece[]
  matchedMaster: boolean
}

export interface FactBundleInput {
  /** Position the learner moved from. */
  fen: string
  /** The move the learner played (SAN), already validated as legal. */
  userMoveSan: string
  /** Engine best move (UCI/LAN), or null if unavailable. */
  bestMoveUci: string | null
  masterMoveSan: string
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
    masterMoveSan: input.masterMoveSan,
    grade: input.grade,
    hangingAfterMove: findHangingPieces(chess, sideToMove),
    matchedMaster: applied.san === input.masterMoveSan,
  }
}

/** A short, rules-based plain-language "why" for the reveal. */
export function explain(b: FactBundle): string {
  const parts: string[] = []

  if (b.grade.tier === 'A') {
    parts.push(
      b.matchedMaster
        ? "That's the move — you matched the master."
        : "Solid — as strong as the master's choice.",
    )
  } else if (b.grade.tier === 'B') {
    parts.push('Playable, but it gives something back.')
  } else {
    parts.push('This is a mistake.')
  }

  if (b.grade.tier !== 'A' && b.hangingAfterMove.length > 0) {
    const h = b.hangingAfterMove[0]!
    const name = PIECE_NAME[h.piece] ?? 'piece'
    parts.push(`It leaves your ${name} on ${h.square} ${h.defended ? 'underdefended' : 'hanging'}.`)
  }

  if (b.grade.tier !== 'A') {
    const engineNote =
      b.bestMoveSan && b.bestMoveSan !== b.masterMoveSan
        ? ` (the engine prefers ${b.bestMoveSan})`
        : ''
    parts.push(`The master played ${b.masterMoveSan}${engineNote}.`)
    parts.push(`That's about ${Math.round(b.grade.swing)}% of your winning chances.`)
  }

  return parts.join(' ')
}

/**
 * Grounded facts as plain text for the ADR-0012 "clipboard handoff": the learner
 * pastes this into their own ChatGPT/Claude. Contains only computed facts.
 */
export function factBundleToText(b: FactBundle): string {
  const side = b.sideToMove === 'w' ? 'White' : 'Black'
  const hanging =
    b.hangingAfterMove.length > 0
      ? b.hangingAfterMove
          .map((h) => `${PIECE_NAME[h.piece] ?? h.piece} on ${h.square}${h.defended ? ' (underdefended)' : ' (undefended)'}`)
          .join(', ')
      : 'none detected'
  return [
    `Position (FEN): ${b.fen}`,
    `Side to move: ${side}`,
    `My move: ${b.userMoveSan} (tier ${b.grade.tier}, gave up ~${Math.round(b.grade.swing)}% winning chances)`,
    `Master's move: ${b.masterMoveSan}`,
    `Engine's best: ${b.bestMoveSan ?? 'n/a'}`,
    `Pieces hanging after my move: ${hanging}`,
    '',
    `In 1–2 sentences a ~1200-rated player would understand, explain why ${b.masterMoveSan} is better than ${b.userMoveSan} here. Do not invent moves; use only the facts above.`,
  ].join('\n')
}
