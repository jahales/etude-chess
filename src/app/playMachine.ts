import { Chess, type Square } from 'chess.js'
import type { Color, Tier } from '../domain/types'
import type { CoachVerdict } from '../domain/coach'
import type { MaiaLevel } from '../engine/maia/opponent'

// Application layer for **play vs Maia** with the in-game coach (ADR 0017): a *pure*
// reducer. Every one of your moves is graded before Maia replies —
//   yourTurn → (you move) → grading → coached (verdict + take-back/continue) → thinking
// Async work (Stockfish grade, Maia move) lives in usePlaySession and dispatches
// COACH_RESULT / MAIA_MOVED back here. No engine/I/O/Date.now — mirrors sessionMachine.

export type PlayStatus = 'yourTurn' | 'grading' | 'coached' | 'thinking' | 'over'
export type GameOutcome = 'you' | 'maia' | 'draw'
export type EndReason =
  | 'checkmate'
  | 'stalemate'
  | 'insufficient'
  | 'threefold'
  | 'fifty-move'
  | 'resignation'

export interface PlayResult {
  outcome: GameOutcome
  reason: EndReason
}

/** Your move, applied to a temp position but not yet committed to the game. */
export interface PendingPlayMove {
  from: string
  to: string
  san: string
  afterFen: string
  promotion: string
}

/** One coached move of yours, for the running log + post-game review. */
export interface CoachEntry {
  ply: number
  san: string
  tier?: Tier
  swing?: number
}

export interface PlayState {
  screen: 'home' | 'play'
  yourColor: Color
  level: MaiaLevel
  /** FEN after each committed ply; positions[0] is the start, last is current. */
  positions: string[]
  /** SAN of each committed move, in order. */
  sanHistory: string[]
  status: PlayStatus
  selected: string | null
  pending: PendingPlayMove | null
  verdict: CoachVerdict | null
  /** "Who's ahead" for the displayed position, White's perspective (0–100). */
  evalWhitePct: number | null
  coachLog: CoachEntry[]
  result: PlayResult | null
  gameId: string
  /** Increments on every committed move; a change signals the hook to act. */
  ply: number
}

const START_FEN = new Chess().fen()

export const initialPlayState: PlayState = {
  screen: 'home',
  yourColor: 'w',
  level: 1300,
  positions: [START_FEN],
  sanHistory: [],
  status: 'yourTurn',
  selected: null,
  pending: null,
  verdict: null,
  evalWhitePct: null,
  coachLog: [],
  result: null,
  gameId: '',
  ply: 0,
}

export type PlayAction =
  | { type: 'NEW_GAME'; yourColor: Color; level: MaiaLevel; gameId: string }
  | { type: 'GO_HOME' }
  | { type: 'SELECT_SQUARE'; square: string }
  | { type: 'MOVE'; from: string; to: string; promotion?: string }
  | { type: 'COACH_RESULT'; verdict: CoachVerdict; evalWhitePct: number | null }
  | { type: 'GRADING_FAILED' }
  | { type: 'TAKE_BACK' }
  | { type: 'CONTINUE' }
  | { type: 'MAIA_MOVED'; uci: string }
  | { type: 'RESIGN' }
  | { type: 'SET_EVAL'; whitePct: number | null }

// ---------- selectors ----------

export function currentFen(state: PlayState): string {
  return state.positions[state.positions.length - 1] ?? START_FEN
}
/** Board to show: your pending move while it's being coached, else the live position. */
export function displayFen(state: PlayState): string {
  return state.pending ? state.pending.afterFen : currentFen(state)
}
export function sideToMove(state: PlayState): Color {
  return new Chess(currentFen(state)).turn()
}
/** Side to move in the *displayed* position (accounts for a pending, uncommitted move). */
export function shownSideToMove(state: PlayState): Color {
  return new Chess(displayFen(state)).turn()
}
export function maiaColor(state: PlayState): Color {
  return state.yourColor === 'w' ? 'b' : 'w'
}
/**
 * Prior positions, most-recent-first, for Maia's history planes (excludes current).
 * Capped at 7 — the encoder fills 8 frames (current + up to 7 history), so sending
 * the whole game each move would just be wasted serialization.
 */
export function historyForMaia(state: PlayState): string[] {
  return state.positions.slice(-8, -1).reverse()
}

// ---------- move helpers ----------

function resultAfter(chess: Chess, mover: Color, yourColor: Color): PlayResult | null {
  if (!chess.isGameOver()) return null
  if (chess.isCheckmate()) return { outcome: mover === yourColor ? 'you' : 'maia', reason: 'checkmate' }
  if (chess.isStalemate()) return { outcome: 'draw', reason: 'stalemate' }
  if (chess.isInsufficientMaterial()) return { outcome: 'draw', reason: 'insufficient' }
  if (chess.isThreefoldRepetition()) return { outcome: 'draw', reason: 'threefold' }
  return { outcome: 'draw', reason: 'fifty-move' }
}

/** Is `from`→`to` legal for the side to move? (Synchronous drag validation.) */
export function isLegalMove(fen: string, from: string, to: string, promotion = 'q'): boolean {
  try {
    new Chess(fen).move({ from, to, promotion })
    return true
  } catch {
    return false
  }
}

/** Resolve your move into a pending move (not committed), or null if illegal. */
function resolvePending(fen: string, from: string, to: string, promotion = 'q'): PendingPlayMove | null {
  const chess = new Chess(fen)
  try {
    const mv = chess.move({ from, to, promotion })
    return { from, to, san: mv.san, afterFen: chess.fen(), promotion }
  } catch {
    return null
  }
}

// ---------- reducer ----------

export function playReducer(state: PlayState, action: PlayAction): PlayState {
  switch (action.type) {
    case 'NEW_GAME':
      return {
        ...initialPlayState,
        screen: 'play',
        yourColor: action.yourColor,
        level: action.level,
        gameId: action.gameId,
        status: action.yourColor === 'w' ? 'yourTurn' : 'thinking',
      }

    case 'GO_HOME':
      return { ...initialPlayState }

    case 'MOVE': {
      if (state.status !== 'yourTurn') return state
      const pending = resolvePending(currentFen(state), action.from, action.to, action.promotion)
      return pending ? { ...state, pending, selected: null, status: 'grading' } : state
    }

    case 'SELECT_SQUARE': {
      if (state.status !== 'yourTurn') return state
      const square = action.square
      const chess = new Chess(currentFen(state))
      const owns = (sq: string) => chess.get(sq as Square)?.color === state.yourColor
      if (state.selected) {
        if (square === state.selected) return { ...state, selected: null }
        const pending = resolvePending(currentFen(state), state.selected, square)
        if (pending) return { ...state, pending, selected: null, status: 'grading' }
        return { ...state, selected: owns(square) ? square : null }
      }
      return { ...state, selected: owns(square) ? square : null }
    }

    case 'COACH_RESULT':
      if (state.status !== 'grading') return state
      return { ...state, status: 'coached', verdict: action.verdict, evalWhitePct: action.evalWhitePct }

    case 'GRADING_FAILED':
      if (state.status !== 'grading') return state
      return { ...state, status: 'coached', verdict: null }

    case 'TAKE_BACK':
      if (state.status !== 'coached') return state
      return { ...state, pending: null, verdict: null, status: 'yourTurn' }

    case 'CONTINUE': {
      if (state.status !== 'coached' || !state.pending) return state
      const chess = new Chess(state.pending.afterFen)
      const result = resultAfter(chess, state.yourColor, state.yourColor)
      const entry: CoachEntry = {
        ply: state.ply,
        san: state.pending.san,
        tier: state.verdict?.tier,
        swing: state.verdict?.swing,
      }
      return {
        ...state,
        positions: [...state.positions, state.pending.afterFen],
        sanHistory: [...state.sanHistory, state.pending.san],
        coachLog: [...state.coachLog, entry],
        pending: null,
        verdict: null,
        status: result ? 'over' : 'thinking',
        result,
        ply: state.ply + 1,
      }
    }

    case 'MAIA_MOVED': {
      if (state.status !== 'thinking') return state
      const chess = new Chess(currentFen(state))
      let san: string
      try {
        san = chess.move({
          from: action.uci.slice(0, 2),
          to: action.uci.slice(2, 4),
          promotion: action.uci[4] ?? 'q',
        }).san
      } catch {
        return state
      }
      const result = resultAfter(chess, maiaColor(state), state.yourColor)
      return {
        ...state,
        positions: [...state.positions, chess.fen()],
        sanHistory: [...state.sanHistory, san],
        status: result ? 'over' : 'yourTurn',
        result,
        ply: state.ply + 1,
      }
    }

    case 'RESIGN':
      if (state.status === 'over') return state
      return {
        ...state,
        pending: null,
        verdict: null,
        status: 'over',
        result: { outcome: 'maia', reason: 'resignation' },
      }

    case 'SET_EVAL':
      return { ...state, evalWhitePct: action.whitePct }

    default:
      return state
  }
}
