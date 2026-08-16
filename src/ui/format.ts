import type { CSSProperties } from 'react'
import type { QuizItem } from '../domain/harness'
import type { Color, Tier } from '../domain/types'

export const TIER_TEXT: Record<Tier, string> = {
  A: 'Well played',
  B: 'Inaccuracy',
  C: 'Mistake',
}

export const TIER_CLASS: Record<Tier, string> = {
  A: 'tier-a',
  B: 'tier-b',
  C: 'tier-c',
}

// Reveal-arrow colours: the move played in the game (green), engine best (blue),
// your move (amber). The green one is only a *master's* move when the game came
// from the curated pack — `domain/moveSource.ts` is what says which, and it says
// it in words rather than in colours. `ARROW_MASTER` keeps its v0.1.0 name
// because renaming a constant is not what #158 was about; the colours did not
// move and neither did which arrow is which.
export const ARROW_MASTER = '#3e7d57'
export const ARROW_ENGINE = '#2a6a87'
export const ARROW_USER = '#b0821f'

export function uciSquares(uci: string): { from: string; to: string } {
  return { from: uci.slice(0, 2), to: uci.slice(2, 4) }
}

/**
 * The mark on the two squares of the move that produced the position (#160).
 *
 * A **ring, not a fill, and not a colour**, decided by looking at a reveal with
 * all three arrows on it rather than from the convention:
 *
 * - A fourth arrow is what the issue rules out, and it is right to — three
 *   coloured lines already cross the board at the reveal.
 * - Lichess's and chess.com's yellow wash does not survive *this* board. Its
 *   squares are warm brown (react-chessboard's default, which the app keeps),
 *   so a warm yellow at any honest opacity lands within a shade of them; and on
 *   the destination square — which by definition has a piece standing on it —
 *   the piece covers about four fifths of the square, leaving a wash nothing to
 *   read on. Tried at 0.55 and 0.62 on the live board: the empty square read,
 *   the occupied one did not.
 * - A ring hugs the square's edge, so the piece cannot hide it, and it is a
 *   different *kind* of mark from an arrow — a reader never has to ask which of
 *   the four annotations it is. Ink rather than a hue for the same reason:
 *   green, blue and amber each already mean a specific move here, and a
 *   fourth colour would look like a fourth claim.
 */
export const LAST_MOVE_MARK: CSSProperties = {
  boxShadow: 'inset 0 0 0 3px rgba(25, 30, 26, 0.5)',
}

/**
 * Square styles marking the move that led to the position on the board.
 *
 * No move — the first position of a game, or of a `[SetUp]`/`[FEN]` one (#128)
 * — is an empty map, which renders as nothing. So is a UCI too short to name
 * two squares, rather than a ring on `""`.
 */
export function lastMoveSquareStyles(uci?: string | null): Record<string, CSSProperties> {
  if (!uci || uci.length < 4) return {}
  const { from, to } = uciSquares(uci)
  return { [from]: LAST_MOVE_MARK, [to]: LAST_MOVE_MARK }
}

/**
 * How the move played into a quiz position reads in prose: "5…dxe5".
 *
 * Null when there was none, so the caller renders nothing rather than a label
 * with a blank where a move should be. The board's ring is invisible to a
 * screen reader and says only *which squares*; this says which move.
 */
export function priorMoveLabel(item: QuizItem): string | null {
  if (!item.priorMoveSan) return null
  // The move before the one being asked about, so one ply back — and by the
  // other side, since a quiz position is always the hero's turn.
  const ply = item.ply - 1
  const side: Color = ply % 2 === 0 ? 'w' : 'b'
  return `${moveLabel(Math.floor(ply / 2) + 1, side)}${item.priorMoveSan}`
}

export function sideName(c: Color): string {
  return c === 'w' ? 'White' : 'Black'
}

export function moveLabel(moveNumber: number, side: Color): string {
  return side === 'w' ? `${moveNumber}.` : `${moveNumber}…`
}
