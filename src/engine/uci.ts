import type { Score } from '../domain/types'

// Pure parsers for the UCI lines Stockfish streams. Kept separate from the
// Worker plumbing so they're directly unit-testable.

/**
 * Extract the score from an `info … score cp N` / `score mate N` line. Bound
 * lines (`lowerbound`/`upperbound`) are ignored so callers keep the last
 * *complete* score before `bestmove`.
 */
export function parseScore(line: string): Score | null {
  if (/\b(lower|upper)bound\b/.test(line)) return null
  const m = line.match(/\bscore (cp|mate) (-?\d+)/)
  if (!m) return null
  const value = parseInt(m[2]!, 10)
  return m[1] === 'mate' ? { type: 'mate', value } : { type: 'cp', value }
}

/**
 * Parse a `bestmove …` line. Returns null if the line isn't a bestmove line at
 * all; returns `{ move: null }` for `bestmove (none)` (a terminal position).
 */
export function parseBestMove(line: string): { move: string | null } | null {
  const m = line.match(/^bestmove (\S+)/)
  if (!m) return null
  return { move: m[1] === '(none)' ? null : m[1]! }
}
