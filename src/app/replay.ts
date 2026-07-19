import type { Color, Tier } from '../domain/types'
import { annotationForSwing, moverColorAt, type Annotation } from '../domain/annotation'
import { evalSwingAt } from './gameAnalysis'
import type { CoachEntry, PositionEval } from '../domain/gameRecord'
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
  /**
   * Win% this move gave up, from the mover's side. Derived from the whole-game
   * analysis, so unlike `swing` it covers **every** move — including the
   * opponent's, and your own moves the coach never graded.
   */
  evalSwing?: number
  /** `?!`/`?`/`??` from `evalSwing`; absent when the move was fine or unmeasured. */
  annotation?: Annotation
}

export interface ReplayRow {
  n: number
  w?: ReplayMove
  b?: ReplayMove
}

/**
 * `evalByPly` can be overridden so a whole-game analysis in flight (#68) lights
 * up the move list as it goes, rather than only after it is persisted.
 */
export function buildReplayMoves(
  game: StoredGame,
  evalByPly: (PositionEval | undefined)[] | undefined = game.evalByPly,
): ReplayMove[] {
  // Index the coach log by ply once — it only covers your moves, and a linear
  // scan per move would be quadratic on a long game.
  const byPly = new Map<number, CoachEntry>()
  for (const e of game.coachLog ?? []) byPly.set(e.ply, e)

  return game.sanHistory.map((san, ply) => {
    const coach = byPly.get(ply)
    // Measured from the mover's own side, so a glyph means the same thing on
    // both halves of the board.
    const swing = evalSwingAt(evalByPly, ply, moverColorAt(ply))
    return {
      ply,
      san,
      tier: coach?.tier,
      swing: coach?.swing,
      bestMoveSan: coach?.bestMoveSan,
      score: evalByPly?.[ply]?.label,
      evalSwing: swing,
      annotation: annotationForSwing(swing),
    }
  })
}

/**
 * Your worst moves, biggest first — the "what should I study" list.
 *
 * Only *your* moves: the point is your own improvement, and a list dominated by
 * the opponent's blunders would bury it. Moves the analysis couldn't measure are
 * omitted rather than assumed fine.
 */
export function movesWorthStudying(
  moves: readonly ReplayMove[],
  yourColor: Color,
  limit = 5,
): ReplayMove[] {
  return moves
    .filter((m) => moverColorAt(m.ply) === yourColor && m.annotation !== undefined)
    .sort((a, b) => (b.evalSwing ?? 0) - (a.evalSwing ?? 0))
    .slice(0, limit)
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
