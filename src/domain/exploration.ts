import { Chess } from 'chess.js'
import type { Color } from './types'
// Runtime imports inside src/domain carry an explicit .ts so the off-app Node
// scripts can load these modules under type stripping (architecture.md).
import { replayPositions } from './replay.ts'

/**
 * Walking an engine line on the board, Lichess-style (#131).
 *
 * A *pure* reducer, in the shape `sessionMachine` and `replay` are written in:
 * no React, no engine, and no chess.js state held between calls — every
 * position is re-derived from `rootFen` + `line`, for the same reason `replay`
 * never stores one. A stored board is a second source of truth that drifts from
 * the moves it is supposed to follow.
 *
 * `null` is "not exploring": the board shows the game.
 */
export interface Exploration {
  /** The real position this hangs off. Leaving lands here, and so does cursor 0. */
  readonly rootFen: string
  /** SAN moves from the root; each is legal in the position before it. */
  readonly line: readonly string[]
  /** How many of `line` are on the board. 0 is `rootFen` itself. */
  readonly cursor: number
}

export type ExplorationAction =
  /**
   * A move inside an engine line was clicked. `fen` is the position the line was
   * computed for, `moves` its SAN, `ply` the 0-based index clicked.
   */
  | { type: 'ENTER'; fen: string; moves: readonly string[]; ply: number }
  /** Your own move, played on `fen` — branching off (#11's free exploration). */
  | { type: 'PLAY'; fen: string; from: string; to: string; promotion?: string }
  /** Arrow keys and the ‹ › transport. */
  | { type: 'STEP'; delta: number }
  | { type: 'SEEK'; cursor: number }
  | { type: 'LEAVE' }

// ---------- selectors ----------

/** Every position of the exploration: index `i` is the board after `i` moves. */
export function explorationPositions(e: Exploration): string[] {
  return replayPositions(e.line, e.rootFen)
}

/** The position on the board right now. */
export function explorationFen(e: Exploration): string {
  const positions = explorationPositions(e)
  // The reducer only ever stores moves it has replayed, so the cursor is always
  // in range. The fallback is for a value built by hand: a throw in here lands
  // inside a render, and the exploration is exactly the state that changes fast.
  return positions[e.cursor] ?? positions[positions.length - 1]!
}

/**
 * Is the board showing something other than the game?
 *
 * Cursor 0 *is* the game position, so an exploration parked there is not off it
 * — flagging it would make the "this is not the game" marker a lie, and a marker
 * that is sometimes a lie stops being read.
 */
export function isOffGame(e: Exploration | null): boolean {
  return e !== null && e.cursor > 0
}

export interface ExploredMove {
  /** Index into `line`. The cursor that lands *after* this move is `index + 1`. */
  index: number
  san: string
  moveNumber: number
  side: Color
}

/**
 * The line with move numbers, so it reads as chess ("24…Rxh2+ 25.Kxh2") rather
 * than as a list. Numbering comes off the root's own FEN — an exploration
 * almost never starts at move one.
 */
export function explorationMoves(e: Exploration): ExploredMove[] {
  const fields = e.rootFen.split(' ')
  const startSide: Color = fields[1] === 'b' ? 'b' : 'w'
  const startNumber = Number(fields[5]) || 1
  return e.line.map((san, index) => {
    const white = startSide === 'w' ? index % 2 === 0 : index % 2 === 1
    // Black's move shares White's number, so a line beginning on Black's move
    // only reaches the next number one ply later.
    const elapsed = startSide === 'w' ? Math.floor(index / 2) : Math.floor((index + 1) / 2)
    return { index, san, moveNumber: startNumber + elapsed, side: white ? 'w' : 'b' }
  })
}

/**
 * `from`→`to` as SAN in this position, or null if it isn't legal.
 *
 * Exported so the reducer and the board's drag handler — which needs a
 * synchronous accept/reject — share one definition of legality, the way
 * `sessionMachine.resolveMove` does for the guess board.
 */
export function moveSan(fen: string, from: string, to: string, promotion = 'q'): string | null {
  const chess = new Chess(fen)
  try {
    return chess.move({ from, to, promotion }).san
  } catch {
    return null
  }
}

// ---------- reducer ----------

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}

function seek(e: Exploration, cursor: number): Exploration {
  const next = clamp(cursor, 0, e.line.length)
  // Same object when nothing moved, so stepping past either end is genuinely a
  // no-op rather than a re-render that re-runs the engine.
  return next === e.cursor ? e : { ...e, cursor: next }
}

/**
 * The prefix of `sans` that actually replays from `fen`, in chess.js's own
 * spelling.
 *
 * An engine PV is rendered to SAN against a position and a stale one stops
 * being legal part-way through. Half a line beats a throw inside the reducer,
 * which is the same call `replay.replayPositions` makes about stored games.
 */
function legalLine(fen: string, sans: readonly string[]): string[] {
  const chess = new Chess(fen)
  const out: string[] = []
  for (const san of sans) {
    try {
      out.push(chess.move(san).san)
    } catch {
      break
    }
  }
  return out
}

/**
 * Where a move made *on* `fen` attaches to the exploration.
 *
 * This is architecture.md's engine/board sync rule expressed inside the
 * reducer. A click on an engine line carries the position that line was
 * computed for; it extends the current line only if that is the position the
 * cursor is standing on. Anything else — a panel still showing the previous
 * position's lines — roots a **fresh** exploration at the position the moves
 * really belong to, so the board can never walk a variation the engine was not
 * asked about. The failure this prevents is silent: no crash, just a plausible
 * line played from the wrong square.
 */
function spliceAt(
  state: Exploration | null,
  fen: string,
): { rootFen: string; prefix: readonly string[] } {
  if (state && explorationFen(state) === fen) {
    return { rootFen: state.rootFen, prefix: state.line.slice(0, state.cursor) }
  }
  return { rootFen: fen, prefix: [] }
}

export function explorationReducer(
  state: Exploration | null,
  action: ExplorationAction,
): Exploration | null {
  switch (action.type) {
    case 'ENTER': {
      const { rootFen, prefix } = spliceAt(state, action.fen)
      const added = legalLine(action.fen, action.moves)
      // A line with nothing legal in it would leave an "exploration" sitting on
      // the game position, which the UI would then label as not the game.
      if (added.length === 0) return state
      return {
        rootFen,
        line: [...prefix, ...added],
        // Clicking a move always walks at least that far, so an exploration is
        // never a synonym for the position it started from.
        cursor: prefix.length + clamp(action.ply + 1, 1, added.length),
      }
    }

    case 'PLAY': {
      const { rootFen, prefix } = spliceAt(state, action.fen)
      const san = moveSan(action.fen, action.from, action.to, action.promotion)
      if (!san) return state
      // Branching truncates: the moves the old line had ahead of the cursor
      // belong to a variation you have just left.
      return { rootFen, line: [...prefix, san], cursor: prefix.length + 1 }
    }

    case 'STEP':
      return state ? seek(state, state.cursor + action.delta) : state

    case 'SEEK':
      return state ? seek(state, action.cursor) : state

    case 'LEAVE':
      return null

    default:
      return state
  }
}
