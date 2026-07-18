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

export interface InfoLine {
  /** MultiPV rank (1 = best); 1 when the engine omits the field. */
  multipv: number
  score: Score
  /** Principal variation as UCI moves, e.g. ['e2e4','e7e5']. */
  pv: string[]
}

/**
 * Parse a full `info … multipv N … score … pv …` line for MultiPV analysis.
 * Returns null unless the line carries both a (non-bound) score and a pv.
 */
export function parseInfoLine(line: string): InfoLine | null {
  if (!line.startsWith('info')) return null
  const score = parseScore(line) // already rejects bound lines
  if (!score) return null
  const pvMatch = line.match(/\bpv (.+)$/)
  if (!pvMatch) return null
  const pv = pvMatch[1]!.trim().split(/\s+/)
  const mpv = line.match(/\bmultipv (\d+)/)
  return { multipv: mpv ? parseInt(mpv[1]!, 10) : 1, score, pv }
}
