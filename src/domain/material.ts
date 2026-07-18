import { Chess } from 'chess.js'

// Material balance from a FEN — pure, no engine. Powers the quick-glance
// "who's ahead in material" strip (#3).

const VALUE: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 }
const FULL_SET: Record<string, number> = { p: 8, n: 2, b: 2, r: 2, q: 1 }

export interface Material {
  whiteValue: number
  blackValue: number
  /** whiteValue − blackValue; positive means White is up material. */
  diff: number
  /** Black pieces White has captured (piece types, e.g. ['p','n']). */
  capturedByWhite: string[]
  /** White pieces Black has captured. */
  capturedByBlack: string[]
}

export function materialBalance(fen: string): Material {
  const board = new Chess(fen).board()
  const white: Record<string, number> = {}
  const black: Record<string, number> = {}
  let whiteValue = 0
  let blackValue = 0
  for (const row of board) {
    for (const sq of row) {
      if (!sq) continue
      const counts = sq.color === 'w' ? white : black
      counts[sq.type] = (counts[sq.type] ?? 0) + 1
      if (sq.color === 'w') whiteValue += VALUE[sq.type] ?? 0
      else blackValue += VALUE[sq.type] ?? 0
    }
  }
  return {
    whiteValue,
    blackValue,
    diff: whiteValue - blackValue,
    capturedByWhite: missing(black), // black pieces no longer on the board
    capturedByBlack: missing(white),
  }
}

/**
 * Piece types (with multiplicity) actually captured from a side, inferred from a
 * FEN. Extra non-pawn pieces beyond the starting set came from promotions, and
 * each one consumed a pawn that therefore was *not* captured — so we discount the
 * missing-pawn count by the number of promotions (otherwise a promoted pawn would
 * show up as a phantom captured pawn).
 */
function missing(onBoard: Record<string, number>): string[] {
  let promotions = 0
  for (const type of ['n', 'b', 'r', 'q']) {
    promotions += Math.max(0, (onBoard[type] ?? 0) - (FULL_SET[type] ?? 0))
  }
  const out: string[] = []
  for (const type of Object.keys(FULL_SET)) {
    let gone = (FULL_SET[type] ?? 0) - (onBoard[type] ?? 0)
    if (type === 'p') gone -= promotions
    for (let i = 0; i < gone; i++) out.push(type)
  }
  return out
}
