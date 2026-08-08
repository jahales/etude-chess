// Stockfish's `eval` command prints what each piece is worth *in this position*
// — its NNUE-derived contribution, not a textbook 3-for-a-knight. That is the
// closest a modern engine comes to explaining itself, and it answers a question
// a centipawn score cannot: which piece changed.
//
// Read it with care. The number is roughly "how much worse would the position be
// without this piece", so it moves for reasons that are not about that piece at
// all, and two positions a move apart are not strictly comparable. It is
// evidence to look at, not a verdict — see the caveat in the review skill.

export interface PieceValue {
  /** As Stockfish prints it: uppercase is White, lowercase is Black. */
  piece: string
  /** Algebraic square, e.g. 'b4'. */
  square: string
  /** Signed as Stockfish prints it: positive favours White. */
  value: number
}

const HEADER = 'NNUE derived piece values'
/** A grid row is `|` then 8 cells then `|` — ten parts once split. */
const GRID_PARTS = 10
const RANKS = 8

/**
 * Parse the piece-value grid out of `eval` output.
 *
 * Kings are absent from the result: Stockfish leaves their cell blank, because
 * "the position without this king" is not a position.
 */
export function parsePieceValues(output: string): PieceValue[] {
  const lines = output.split(/\r?\n/)
  const start = lines.findIndex((l) => l.includes(HEADER))
  if (start === -1) return []

  // Only the grid rows, and only the first 16 of them — the `eval` output goes
  // on to print a bucket table that is also drawn with pipes but has four
  // columns, so both the shape check and the count are doing work here.
  const rows = lines
    .slice(start + 1)
    .filter((l) => l.startsWith('|') && l.split('|').length === GRID_PARTS)
    .slice(0, RANKS * 2)

  const out: PieceValue[] = []
  for (let rank = 0; rank * 2 + 1 < rows.length; rank++) {
    const pieces = rows[rank * 2]!.split('|').slice(1, 9)
    const values = rows[rank * 2 + 1]!.split('|').slice(1, 9)
    for (let file = 0; file < RANKS; file++) {
      const piece = pieces[file]?.trim()
      const raw = values[file]?.trim()
      if (!piece || !raw) continue
      const value = Number(raw)
      if (Number.isNaN(value)) continue
      out.push({ piece, square: `${'abcdefgh'[file]}${RANKS - rank}`, value })
    }
  }
  return out
}

/**
 * What changed between two positions, keyed by piece. Values are absolute
 * (how much that piece is worth to its own side) so the two colours read the
 * same way round.
 */
export interface PieceValueChange {
  piece: string
  from: string | null
  to: string | null
  before: number | null
  after: number | null
  delta: number
}

/**
 * Line up two piece-value tables so a move's effect is readable.
 *
 * Pieces are matched by kind and colour in descending value order rather than by
 * square, because the point of the comparison is a move — the piece that matters
 * most is the one that just changed square.
 */
export function comparePieceValues(
  before: readonly PieceValue[],
  after: readonly PieceValue[],
): PieceValueChange[] {
  const bucket = (list: readonly PieceValue[]) => {
    const byPiece = new Map<string, PieceValue[]>()
    for (const p of list) {
      const group = byPiece.get(p.piece) ?? []
      group.push(p)
      byPiece.set(p.piece, group)
    }
    for (const group of byPiece.values()) group.sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
    return byPiece
  }

  const b = bucket(before)
  const a = bucket(after)
  const changes: PieceValueChange[] = []
  for (const piece of new Set([...b.keys(), ...a.keys()])) {
    const bs = b.get(piece) ?? []
    const as = a.get(piece) ?? []
    for (let i = 0; i < Math.max(bs.length, as.length); i++) {
      const from = bs[i] ?? null
      const to = as[i] ?? null
      const beforeAbs = from ? Math.abs(from.value) : null
      const afterAbs = to ? Math.abs(to.value) : null
      changes.push({
        piece,
        from: from?.square ?? null,
        to: to?.square ?? null,
        before: beforeAbs,
        after: afterAbs,
        delta: (afterAbs ?? 0) - (beforeAbs ?? 0),
      })
    }
  }
  return changes.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta))
}
