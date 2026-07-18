import { Chess, type Square } from 'chess.js'
import type { Color } from '../domain/types'
import type { MaiaLevel } from '../engine/maia/opponent'

// Application layer for **play vs Maia** (v0.2): a *pure* reducer for a full game
// against the human-like opponent. No engine calls, no I/O, no Date.now — the async
// Maia move lives in usePlaySession and dispatches MAIA_MOVED back here. Mirrors
// sessionMachine (ADR 0015). Unlike guess-the-move there's no commit/reason step:
// you just play; the coached review happens after the game (ADR 0013).

export type PlayStatus = 'yourTurn' | 'thinking' | 'over'
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

export interface PlayState {
  screen: 'home' | 'play'
  yourColor: Color
  level: MaiaLevel
  /** FEN after each ply; positions[0] is the start position, last is current. */
  positions: string[]
  /** SAN of each move played, in order. */
  sanHistory: string[]
  status: PlayStatus
  selected: string | null
  result: PlayResult | null
  gameId: string
  /** Increments on every applied move; a change signals the hook to act. */
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
  result: null,
  gameId: '',
  ply: 0,
}

export type PlayAction =
  | { type: 'NEW_GAME'; yourColor: Color; level: MaiaLevel; gameId: string }
  | { type: 'GO_HOME' }
  | { type: 'SELECT_SQUARE'; square: string }
  | { type: 'MOVE'; from: string; to: string; promotion?: string }
  | { type: 'MAIA_MOVED'; uci: string }
  | { type: 'RESIGN' }

// ---------- selectors ----------

export function currentFen(state: PlayState): string {
  return state.positions[state.positions.length - 1] ?? START_FEN
}
export function sideToMove(state: PlayState): Color {
  return new Chess(currentFen(state)).turn()
}
export function maiaColor(state: PlayState): Color {
  return state.yourColor === 'w' ? 'b' : 'w'
}
/** Prior positions, most-recent-first, for Maia's history planes (excludes current). */
export function historyForMaia(state: PlayState): string[] {
  return state.positions.slice(0, -1).reverse()
}

// ---------- move application ----------

function resultAfter(chess: Chess, mover: Color, yourColor: Color): PlayResult | null {
  if (!chess.isGameOver()) return null
  if (chess.isCheckmate()) return { outcome: mover === yourColor ? 'you' : 'maia', reason: 'checkmate' }
  if (chess.isStalemate()) return { outcome: 'draw', reason: 'stalemate' }
  if (chess.isInsufficientMaterial()) return { outcome: 'draw', reason: 'insufficient' }
  if (chess.isThreefoldRepetition()) return { outcome: 'draw', reason: 'threefold' }
  return { outcome: 'draw', reason: 'fifty-move' }
}

/** Is `from`→`to` a legal move for the side to move? (Synchronous drag validation.) */
export function isLegalMove(fen: string, from: string, to: string, promotion = 'q'): boolean {
  try {
    new Chess(fen).move({ from, to, promotion })
    return true
  } catch {
    return false
  }
}

/** Apply one move (from either side) to `state`, or return null if illegal / wrong turn. */
function applyMove(state: PlayState, from: string, to: string, promotion = 'q'): PlayState | null {
  if (state.status !== 'yourTurn' && state.status !== 'thinking') return null
  const fen = currentFen(state)
  const chess = new Chess(fen)
  const mover = chess.turn()
  // Guard turn ownership: only your move on yourTurn, only Maia's on thinking.
  if (state.status === 'yourTurn' && mover !== state.yourColor) return null
  if (state.status === 'thinking' && mover === state.yourColor) return null
  let san: string
  try {
    san = chess.move({ from, to, promotion }).san
  } catch {
    return null
  }
  const result = resultAfter(chess, mover, state.yourColor)
  const status: PlayStatus = result
    ? 'over'
    : mover === state.yourColor
      ? 'thinking'
      : 'yourTurn'
  return {
    ...state,
    positions: [...state.positions, chess.fen()],
    sanHistory: [...state.sanHistory, san],
    selected: null,
    status,
    result,
    ply: state.ply + 1,
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

    case 'MOVE':
      if (state.status !== 'yourTurn') return state
      return applyMove(state, action.from, action.to, action.promotion) ?? state

    case 'MAIA_MOVED':
      if (state.status !== 'thinking') return state
      return (
        applyMove(state, action.uci.slice(0, 2), action.uci.slice(2, 4), action.uci[4] ?? 'q') ?? state
      )

    case 'SELECT_SQUARE': {
      if (state.status !== 'yourTurn') return state
      const square = action.square
      const chess = new Chess(currentFen(state))
      const owns = (sq: string) => chess.get(sq as Square)?.color === state.yourColor
      if (state.selected) {
        if (square === state.selected) return { ...state, selected: null }
        const moved = applyMove(state, state.selected, square)
        if (moved) return moved
        return { ...state, selected: owns(square) ? square : null }
      }
      return { ...state, selected: owns(square) ? square : null }
    }

    case 'RESIGN':
      if (state.status === 'over') return state
      return { ...state, status: 'over', result: { outcome: 'maia', reason: 'resignation' } }

    default:
      return state
  }
}
