// Endgame ground truth. Below eight pieces the result of a position is not an
// opinion — it is a solved fact, and Syzygy knows it. For a player whose losses
// concentrate in the endgame this is worth more than any evaluation: it turns
// "the engine likes this" into "this is a win, and this move throws it".
//
// Pure: the caller does the fetching (scripts/review/game.mjs uses Lichess's
// public tablebase API), this decides what the answer means.

/** Syzygy is solved to seven pieces, kings included. */
export const TABLEBASE_MAX_PIECES = 7

/** Count the pieces in a FEN's board field. */
export function pieceCount(fen: string): number {
  const board = fen.split(' ')[0] ?? ''
  return [...board].filter((c) => /[pnbrqkPNBRQK]/.test(c)).length
}

export function tablebaseEligible(fen: string): boolean {
  const n = pieceCount(fen)
  return n > 0 && n <= TABLEBASE_MAX_PIECES
}

/**
 * The categories Lichess returns, from the point of view of the side to move.
 * `cursed-win` and `blessed-loss` are wins and losses that the fifty-move rule
 * turns into draws — worth naming rather than rounding off, because a player
 * who does not know the rule applies will not understand the result.
 */
export type TablebaseCategory =
  | 'win'
  | 'cursed-win'
  | 'draw'
  | 'blessed-loss'
  | 'loss'
  | 'unknown'

export interface TablebaseMove {
  uci: string
  san: string
  /** From the point of view of the player to move *after* this move. */
  category: TablebaseCategory
  dtz: number | null
  dtm: number | null
}

export interface TablebaseResult {
  category: TablebaseCategory
  dtz: number | null
  dtm: number | null
  moves: readonly TablebaseMove[]
}

/** How good a result is for the side to move — higher is better. */
const RANK: Record<TablebaseCategory, number> = {
  win: 4,
  'cursed-win': 3,
  draw: 2,
  'blessed-loss': 1,
  loss: 0,
  unknown: -1,
}

/**
 * A move's result for the *mover*. The API reports each move's category from the
 * opponent's side — the position after it — so a move that leaves the opponent
 * lost is a win. Getting this backwards would label every winning move a blunder.
 */
export function resultForMover(move: TablebaseMove): TablebaseCategory {
  const flip: Record<TablebaseCategory, TablebaseCategory> = {
    win: 'loss',
    'cursed-win': 'blessed-loss',
    draw: 'draw',
    'blessed-loss': 'cursed-win',
    loss: 'win',
    unknown: 'unknown',
  }
  return flip[move.category]
}

export interface TablebaseVerdict {
  /** The position's result with best play, from the side to move. */
  category: TablebaseCategory
  /** Moves that preserve the best available result, fastest first. */
  best: TablebaseMove[]
  /** The played move, if it was among those listed. */
  played: TablebaseMove | null
  /** Did the played move keep the best result available? Null if not found. */
  playedHolds: boolean | null
  /** How far the played move fell — e.g. 'win' to 'draw'. Null when it held. */
  threwAwayTo: TablebaseCategory | null
}

/**
 * Judge a position and, optionally, the move played in it.
 *
 * Ordering within the best moves is by DTZ — distance to zeroing, the metric
 * Syzygy actually stores — smallest magnitude first, which is the move that
 * makes the most progress toward the conversion.
 */
export function judgeTablebase(
  result: TablebaseResult,
  playedSan?: string,
): TablebaseVerdict {
  const rated = result.moves.map((m) => ({ move: m, outcome: resultForMover(m) }))
  const bestRank = rated.reduce((top, r) => Math.max(top, RANK[r.outcome]), -1)
  const best = rated
    .filter((r) => RANK[r.outcome] === bestRank)
    .sort((a, b) => Math.abs(a.move.dtz ?? Infinity) - Math.abs(b.move.dtz ?? Infinity))
    .map((r) => r.move)

  const played = playedSan ? (result.moves.find((m) => m.san === playedSan) ?? null) : null
  const playedOutcome = played ? RANK[resultForMover(played)] : null
  const playedHolds = playedOutcome === null ? null : playedOutcome === bestRank

  return {
    category: result.category,
    best,
    played,
    playedHolds,
    threwAwayTo: played && playedHolds === false ? resultForMover(played) : null,
  }
}
