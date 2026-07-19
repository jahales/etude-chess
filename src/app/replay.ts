import type { Tier } from '../domain/types'
import type { CoachEntry } from '../domain/gameRecord'
import type { StoredGame } from '../persist/db'

/**
 * Replaying a stored game reads only what was saved with it (#46) — no engine
 * calls. Everything here is pure so the replay screen is just a cursor over
 * derived data.
 */

/** One move of a stored game, with whatever the coach recorded about it. */
export interface ReplayMove {
  /** Index into `sanHistory`. */
  ply: number
  san: string
  /** Present only for *your* moves, and only if the coach graded them. */
  tier?: Tier
  swing?: number
  bestMoveSan?: string | null
  /** Evaluation *after* this move, White's perspective. */
  score?: string
}

export interface ReplayRow {
  n: number
  w?: ReplayMove
  b?: ReplayMove
}

export function buildReplayMoves(game: StoredGame): ReplayMove[] {
  // Index the coach log by ply once — it only covers your moves, and a linear
  // scan per move would be quadratic on a long game.
  const byPly = new Map<number, CoachEntry>()
  for (const e of game.coachLog ?? []) byPly.set(e.ply, e)

  return game.sanHistory.map((san, ply) => {
    const coach = byPly.get(ply)
    return {
      ply,
      san,
      tier: coach?.tier,
      swing: coach?.swing,
      bestMoveSan: coach?.bestMoveSan,
      score: game.evalByPly?.[ply]?.label,
    }
  })
}

/**
 * Pair the moves into numbered rows.
 *
 * This assumes the game starts at move 1 with White, which is true of every
 * `kind: 'game'` record. Play-outs (#48) start mid-game and will need both a
 * move-number offset and a possible empty first White slot — that's a real
 * design question, not a boolean, so it is left to that issue rather than
 * half-encoded here.
 */
export function replayRows(moves: readonly ReplayMove[]): ReplayRow[] {
  const rows: ReplayRow[] = []
  for (const move of moves) {
    const n = Math.floor(move.ply / 2) + 1
    let row = rows[rows.length - 1]
    if (!row || row.n !== n) {
      row = { n }
      rows.push(row)
    }
    if (move.ply % 2 === 0) row.w = move
    else row.b = move
  }
  return rows
}

/**
 * The coach entry for the currently selected move, if there is one.
 * `cursor` counts moves played, so the selected move is `cursor - 1` and a
 * cursor of 0 (the start position) selects nothing.
 */
export function coachAtCursor(game: StoredGame, cursor: number): CoachEntry | undefined {
  if (cursor <= 0) return undefined
  return game.coachLog?.find((e) => e.ply === cursor - 1)
}

/** Clamp a cursor into `[0, moves]` so navigation can't run off either end. */
export function clampCursor(cursor: number, moves: number): number {
  return Math.max(0, Math.min(cursor, moves))
}
