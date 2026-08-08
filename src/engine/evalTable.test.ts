import { describe, expect, it } from 'vitest'
import { comparePieceValues, parsePieceValues } from './evalTable'

// Real `eval` output from Stockfish 18 for the position after 40.Rh3 in the
// reviewed game (6k1/p4ppn/8/4P3/1r3PK1/7R/7P/8 b - - 2 40), trimmed to the
// tables. Handwriting this fixture would only prove the parser matches my idea
// of the format.
const SEPARATOR = '+-------+-------+-------+-------+-------+-------+-------+-------+'
const EVAL_OUTPUT = [
  'info string NNUE evaluation using nn-c288c895ea92.nnue',
  '',
  ' NNUE derived piece values:',
  SEPARATOR,
  '|       |       |       |       |       |       |   k   |       |',
  '|       |       |       |       |       |       |       |       |',
  SEPARATOR,
  '|   p   |       |       |       |       |   p   |   p   |   n   |',
  '| -1.21 |       |       |       |       | -2.16 | -2.18 | -3.89 |',
  SEPARATOR,
  '|       |       |       |       |       |       |       |       |',
  '|       |       |       |       |       |       |       |       |',
  SEPARATOR,
  '|       |       |       |       |   P   |       |       |       |',
  '|       |       |       |       | +0.76 |       |       |       |',
  SEPARATOR,
  '|       |   r   |       |       |       |   P   |   K   |       |',
  '|       | -8.00 |       |       |       | +1.39 |       |       |',
  SEPARATOR,
  '|       |       |       |       |       |       |       |   R   |',
  '|       |       |       |       |       |       |       | +3.95 |',
  SEPARATOR,
  '|       |       |       |       |       |       |       |   P   |',
  '|       |       |       |       |       |       |       | +0.31 |',
  SEPARATOR,
  '|       |       |       |       |       |       |       |       |',
  '|       |       |       |       |       |       |       |       |',
  SEPARATOR,
  '',
  ' NNUE network contributions (Black to move)',
  '+------------+------------+------------+------------+',
  '|   Bucket   |  Material  | Positional |   Total    |',
  '+------------+------------+------------+------------+',
  '|  2         |  +  1.98   |  +  1.94   |  +  3.92   | <-- this bucket is used',
  '+------------+------------+------------+------------+',
  '',
  'NNUE evaluation        -3.92 (white side)',
].join('\n')

describe('reading the piece-value grid out of `eval`', () => {
  const values = parsePieceValues(EVAL_OUTPUT)

  it('places each piece on the right square, counting ranks from the top', () => {
    expect(values.find((p) => p.piece === 'r')).toEqual({ piece: 'r', square: 'b4', value: -8 })
    expect(values.find((p) => p.piece === 'R')).toEqual({ piece: 'R', square: 'h3', value: 3.95 })
    expect(values.find((p) => p.piece === 'n')).toEqual({ piece: 'n', square: 'h7', value: -3.89 })
  })

  it('keeps the sign Stockfish prints, so positive still favours White', () => {
    expect(values.filter((p) => p.value < 0).map((p) => p.piece).sort()).toEqual([
      'n',
      'p',
      'p',
      'p',
      'r',
    ])
  })

  it('leaves the kings out, because a position without one is not a position', () => {
    expect(values.some((p) => p.piece.toLowerCase() === 'k')).toBe(false)
  })

  it('does not mistake the bucket table below it for more of the board', () => {
    // It is drawn with pipes too. Nine pieces on the board, two of them kings.
    expect(values).toHaveLength(9)
    expect(values.some((p) => p.square === undefined || Number.isNaN(p.value))).toBe(false)
  })

  it('returns nothing for output that has no grid in it', () => {
    expect(parsePieceValues('bestmove e2e4')).toEqual([])
    expect(parsePieceValues('')).toEqual([])
  })
})

/** Build `eval` grid output from `{ square: [piece, value] }`, for the cases a real dump cannot reach. */
function grid(pieces: Record<string, [string, number | null]>): string {
  const rows = [' NNUE derived piece values:', SEPARATOR]
  for (let rank = 8; rank >= 1; rank--) {
    const pieceCells = []
    const valueCells = []
    for (const file of 'abcdefgh') {
      const at = pieces[`${file}${rank}`]
      pieceCells.push(at ? `   ${at[0]}   ` : '       ')
      const v = at?.[1]
      valueCells.push(v == null ? '       ' : ` ${v < 0 ? '-' : '+'}${Math.abs(v).toFixed(2)} `)
    }
    rows.push(`|${pieceCells.join('|')}|`, `|${valueCells.join('|')}|`, SEPARATOR)
  }
  return rows.join('\n')
}

describe('comparing two positions piece by piece', () => {
  it('reports both sides in absolute terms, so the numbers read the same way round', () => {
    // The retreat the review flagged: an active rook on b4 goes back to b8.
    const before = parsePieceValues(grid({ b4: ['r', -8], h3: ['R', 3.95] }))
    const after = parsePieceValues(grid({ b8: ['r', -7.69], a3: ['R', 4.62] }))
    const changes = comparePieceValues(before, after)

    const black = changes.find((c) => c.piece === 'r')!
    expect(black).toMatchObject({ from: 'b4', to: 'b8', before: 8, after: 7.69 })
    expect(black.delta).toBeCloseTo(-0.31, 5)

    // White's rook improved. Both are stated as "worth to its own side", so the
    // sign of the delta means the same thing for each colour.
    const white = changes.find((c) => c.piece === 'R')!
    expect(white).toMatchObject({ from: 'h3', to: 'a3', before: 3.95, after: 4.62 })
    expect(white.delta).toBeCloseTo(0.67, 5)
  })

  it('sorts the biggest change first, whichever piece it was', () => {
    const before = parsePieceValues(grid({ b4: ['r', -8], h3: ['R', 3.95] }))
    const after = parsePieceValues(grid({ b8: ['r', -7.69], a6: ['R', 4.81] }))
    const [top] = comparePieceValues(before, after)
    expect(top!.piece).toBe('R')
    expect(top!.delta).toBeCloseTo(0.86, 5)
  })

  it('shows a captured piece as a loss of its whole value, not as absent', () => {
    // Dropping it from the comparison would hide the largest change on the board.
    const before = parsePieceValues(grid({ b4: ['r', -8], h3: ['R', 3.95] }))
    const after = parsePieceValues(grid({ b4: ['r', -8] }))
    const gone = comparePieceValues(before, after).find((c) => c.piece === 'R')!
    expect(gone).toMatchObject({ from: 'h3', to: null, before: 3.95, after: null })
    expect(gone.delta).toBeCloseTo(-3.95, 5)
  })

  it('matches the pieces of a kind by value, so a promotion does not scramble them', () => {
    const before = parsePieceValues(grid({ a1: ['R', 5], h1: ['R', 3] }))
    const after = parsePieceValues(grid({ a8: ['R', 6], h1: ['R', 3] }))
    const [biggest] = comparePieceValues(before, after)
    expect(biggest).toMatchObject({ piece: 'R', from: 'a1', to: 'a8', delta: 1 })
  })
})
