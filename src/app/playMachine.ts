import { Chess, type Square } from 'chess.js'
import type { Color } from '../domain/types'
// Re-exported so existing importers keep working; the definitions live in the
// domain so the persistence adapter never has to import this reducer.
export type { CoachEntry, PositionEval } from '../domain/gameRecord'
import type { CoachEntry, PositionEval } from '../domain/gameRecord'
import type { CoachVerdict } from '../domain/coach'
import type { AnalysisLine } from '../engine/analyser'
import type { MaiaLevel } from '../engine/maia/opponent'
import { detectOpening } from '../content/openings'
import { meanAccuracy } from '../domain/accuracy'

// Application layer for **play vs Maia** with the ambient in-game coach (ADR 0017): a
// *pure* reducer. You move → Maia replies immediately → the coach shows feedback on your
// move (take back the pair if you want); no acknowledge gate. Async work (Stockfish
// grade + per-position eval, Maia's move, on-demand engine lines) lives in
// usePlaySession and dispatches back here. No engine/I/O/Date.now — mirrors sessionMachine.

export type PlayStatus = 'yourTurn' | 'thinking' | 'over'
export type GameOutcome = 'you' | 'maia' | 'draw'
export type EndReason =
  | 'checkmate'
  | 'stalemate'
  | 'insufficient'
  | 'threefold'
  | 'fifty-move'
  | 'resignation'
  | 'agreement'

export interface PlayResult {
  outcome: GameOutcome
  reason: EndReason
}

/** Coach feedback on your most recent move, shown while it's your turn again. */
export interface LastCoach {
  ply: number
  fenBefore: string
  yourMoveSan: string
  verdict: CoachVerdict
}

export interface PlayState {
  screen: 'home' | 'play'
  yourColor: Color
  level: MaiaLevel
  positions: string[]
  sanHistory: string[]
  status: PlayStatus
  selected: string | null
  lastCoach: LastCoach | null
  /** Your coached moves in the final line (take-backs prune them). */
  coachLog: CoachEntry[]
  /** How many times you took a move back this game — the "did you commit?" metric. */
  takebacks: number
  /** Eval after each committed move, indexed by sanHistory move index (White's view). */
  evalByPly: (PositionEval | undefined)[]
  /** "Show me": engine lines for lastCoach.fenBefore, revealed only on request. */
  showMe: boolean
  lines: AnalysisLine[]
  result: PlayResult | null
  gameId: string
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
  lastCoach: null,
  coachLog: [],
  takebacks: 0,
  evalByPly: [],
  showMe: false,
  lines: [],
  result: null,
  gameId: '',
}

export type PlayAction =
  | { type: 'NEW_GAME'; yourColor: Color; level: MaiaLevel; gameId: string }
  | { type: 'GO_HOME' }
  | { type: 'SELECT_SQUARE'; square: string }
  | { type: 'MOVE'; from: string; to: string; promotion?: string }
  | { type: 'MAIA_MOVED'; uci: string }
  | { type: 'COACH_RESULT'; ply: number; fenBefore: string; yourMoveSan: string; verdict: CoachVerdict }
  | { type: 'SET_EVAL'; ply: number; fen: string; eval: PositionEval }
  | { type: 'SET_LINES'; fen: string; lines: AnalysisLine[] }
  | { type: 'HIDE_LINES' }
  | { type: 'TAKE_BACK' }
  | { type: 'RESIGN' }
  | { type: 'DRAW_GAME' }

// ---------- selectors ----------

export function currentFen(state: PlayState): string {
  return state.positions[state.positions.length - 1] ?? START_FEN
}
/** Board to show (no pending move in the ambient flow — always the live position). */
export function displayFen(state: PlayState): string {
  return currentFen(state)
}
export function sideToMove(state: PlayState): Color {
  return new Chess(currentFen(state)).turn()
}
export function maiaColor(state: PlayState): Color {
  return state.yourColor === 'w' ? 'b' : 'w'
}
/** Prior positions, most-recent-first, for Maia's history planes (capped at 7). */
export function historyForMaia(state: PlayState): string[] {
  return state.positions.slice(-8, -1).reverse()
}
/** Engine eval of the current position, or undefined if not computed / eval hidden. */
export function currentEval(state: PlayState): PositionEval | undefined {
  return state.evalByPly[state.sanHistory.length - 1]
}
/** Whether the last pair (your move + Maia's reply) can be taken back. */
export function canTakeBack(state: PlayState): boolean {
  return state.status === 'yourTurn' && state.sanHistory.length >= 2
}
/** Named opening for the moves played so far, if recognised. */
export function openingName(state: PlayState): string | null {
  return detectOpening(state.sanHistory)
}
/** This game's accuracy (0–100) over your moves in the final line. */
export function gameAccuracy(state: PlayState): number {
  return meanAccuracy(state.coachLog.map((e) => e.swing))
}

/** Your moves in the game so far, whether or not the coach finished grading them. */
export function yourMoveCount(state: PlayState): number {
  const yourTurnAt = state.yourColor === 'w' ? 0 : 1
  return state.sanHistory.filter((_, ply) => ply % 2 === yourTurnAt).length
}
/** Fraction of your moves you took back (0 = committed every time; can exceed 1). */
export function takebackRate(state: PlayState): number {
  return state.coachLog.length === 0 ? 0 : state.takebacks / state.coachLog.length
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

/** Apply your move immediately (no pending), handing the turn to Maia. Null if illegal. */
function commitYourMove(state: PlayState, from: string, to: string, promotion = 'q'): PlayState | null {
  if (state.status !== 'yourTurn') return null
  const chess = new Chess(currentFen(state))
  let san: string
  try {
    san = chess.move({ from, to, promotion }).san
  } catch {
    return null
  }
  const result = resultAfter(chess, state.yourColor, state.yourColor)
  return {
    ...state,
    positions: [...state.positions, chess.fen()],
    sanHistory: [...state.sanHistory, san],
    selected: null,
    status: result ? 'over' : 'thinking',
    result,
    lastCoach: null, // feedback on the *previous* move is now stale
    showMe: false,
    lines: [],
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
      return commitYourMove(state, action.from, action.to, action.promotion) ?? state

    case 'SELECT_SQUARE': {
      if (state.status !== 'yourTurn') return state
      const square = action.square
      const chess = new Chess(currentFen(state))
      const owns = (sq: string) => chess.get(sq as Square)?.color === state.yourColor
      if (state.selected) {
        if (square === state.selected) return { ...state, selected: null }
        const moved = commitYourMove(state, state.selected, square)
        if (moved) return moved
        return { ...state, selected: owns(square) ? square : null }
      }
      return { ...state, selected: owns(square) ? square : null }
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
      }
    }

    case 'COACH_RESULT': {
      // Ignore a late grade for a move that's since been taken back / replaced.
      if (state.sanHistory[action.ply] !== action.yourMoveSan) return state
      const entry: CoachEntry = {
        ply: action.ply,
        fen: action.fenBefore,
        san: action.yourMoveSan,
        tier: action.verdict.tier,
        swing: action.verdict.swing,
        bestMoveSan: action.verdict.bestMoveSan,
      }
      return {
        ...state,
        lastCoach: {
          ply: action.ply,
          fenBefore: action.fenBefore,
          yourMoveSan: action.yourMoveSan,
          verdict: action.verdict,
        },
        coachLog: [...state.coachLog.filter((e) => e.ply !== action.ply), entry],
        showMe: false,
        lines: [],
      }
    }

    case 'SET_EVAL': {
      // Drop a stale eval: it must be for the position that still stands after that ply
      // (a take-back + different replay changes positions[ply+1]). Keeps the engine in
      // sync with the board by construction.
      if (action.ply < 0 || state.positions[action.ply + 1] !== action.fen) return state
      const evalByPly = state.evalByPly.slice()
      evalByPly[action.ply] = action.eval
      return { ...state, evalByPly }
    }

    case 'SET_LINES':
      // Drop stale lines: only show them if they were computed for the position the coach
      // card is still displaying (else the PV would be illegal in the current position).
      if (!state.lastCoach || state.lastCoach.fenBefore !== action.fen) return state
      return { ...state, lines: action.lines, showMe: true }

    case 'HIDE_LINES':
      return { ...state, showMe: false }

    case 'TAKE_BACK': {
      if (!canTakeBack(state)) return state
      const newLen = state.sanHistory.length - 2 // undo your move + Maia's reply
      return {
        ...state,
        positions: state.positions.slice(0, newLen + 1),
        sanHistory: state.sanHistory.slice(0, newLen),
        coachLog: state.coachLog.filter((e) => e.ply < newLen),
        evalByPly: state.evalByPly.slice(0, newLen),
        takebacks: state.takebacks + 1,
        lastCoach: null,
        showMe: false,
        lines: [],
        status: 'yourTurn',
      }
    }

    case 'RESIGN':
      if (state.status === 'over') return state
      return { ...state, selected: null, status: 'over', result: { outcome: 'maia', reason: 'resignation' } }

    case 'DRAW_GAME':
      if (state.status === 'over') return state
      return { ...state, selected: null, status: 'over', result: { outcome: 'draw', reason: 'agreement' } }

    default:
      return state
  }
}
