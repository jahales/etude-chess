import { Chess, type Square } from 'chess.js'
import type { PackGame } from '../content/games'
import { detectOpening } from '../content/openings'
import { parseGame, heroColorFromResult, buildQuiz, type QuizItem } from '../domain/harness'
import { buildFactBundle, type FactBundle } from '../domain/factBundle'
import type { Attempt } from '../domain/session'
import type { GradedMove } from '../engine/grading'
import type { AnalysisLine } from '../engine/analyser'
import type { Color } from '../domain/types'

// The application layer (ADR 0015): a *pure* reducer for the guess→commit→grade→
// reveal→next state machine. No engine calls, no I/O, no Date.now — the async
// engine work lives in useGuessSession and dispatches results here. This is what
// makes the orchestration unit-testable (issue #18).

export const OPENING_CUTOFF_PLY = 8

export interface Session {
  game: PackGame
  quiz: QuizItem[]
  heroColor: Color
  opening: string | null
}
export interface PendingMove {
  san: string
  from: string
  to: string
  afterFen: string
  /** Promotion piece for a promoting move ('q' by default); ignored otherwise. */
  promotion: string
}
export interface Result {
  fb: FactBundle
  bestMoveUci: string | null
}

export type Screen = 'home' | 'play' | 'summary'
export type Phase = 'guess' | 'grading' | 'reveal'

export interface SessionState {
  screen: Screen
  session: Session | null
  index: number
  phase: Phase
  pending: PendingMove | null
  selected: string | null
  reason: string
  result: Result | null
  lines: AnalysisLine[]
  positionWhitePct: number | null
  attempts: Attempt[]
  sessionId: string
}

export const initialState: SessionState = {
  screen: 'home',
  session: null,
  index: 0,
  phase: 'guess',
  pending: null,
  selected: null,
  reason: '',
  result: null,
  lines: [],
  positionWhitePct: null,
  attempts: [],
  sessionId: '',
}

export type Action =
  | { type: 'START_GAME'; game: PackGame; sessionId: string }
  | { type: 'GO_HOME' }
  | { type: 'CLICK_SQUARE'; square: string }
  | { type: 'TRY_MOVE'; from: string; to: string; promotion?: string }
  | { type: 'TAKE_BACK' }
  | { type: 'SET_PROMOTION'; piece: string }
  | { type: 'SET_REASON'; reason: string }
  | { type: 'START_GRADING' }
  | { type: 'GRADE_RESULT'; graded: GradedMove; lines: AnalysisLine[]; whitePct: number }
  | { type: 'GRADING_FAILED' }
  | { type: 'SET_POSITION_EVAL'; whitePct: number | null }
  | { type: 'NEXT' }

// ---------- selectors ----------

export function currentItem(state: SessionState): QuizItem | null {
  return state.session?.quiz[state.index] ?? null
}
export function displayFen(state: SessionState): string {
  const item = currentItem(state)
  if (!item) return new Chess().fen()
  return state.phase === 'reveal' ? item.fen : state.pending?.afterFen ?? item.fen
}
export function isLast(state: SessionState): boolean {
  return !!state.session && state.index + 1 >= state.session.quiz.length
}

// ---------- reducer ----------

/** Apply `from`→`to` to the current item's position; returns the pending move or null. */
function tryPending(
  state: SessionState,
  from: string,
  to: string,
  promotion = 'q',
): PendingMove | null {
  const item = currentItem(state)
  if (!item) return null
  const chess = new Chess(item.fen)
  try {
    const mv = chess.move({ from, to, promotion })
    return { san: mv.san, from, to, afterFen: chess.fen(), promotion }
  } catch {
    return null
  }
}

/** True if the pending move is a pawn promotion (SAN carries "="). */
export function isPromotion(pending: PendingMove | null): boolean {
  return !!pending && pending.san.includes('=')
}

function pieceColorAt(state: SessionState, square: string): Color | null {
  const item = currentItem(state)
  if (!item) return null
  const pc = new Chess(item.fen).get(square as Square)
  return pc ? pc.color : null
}

export function sessionReducer(state: SessionState, action: Action): SessionState {
  switch (action.type) {
    case 'START_GAME': {
      const parsed = parseGame(action.game.pgn)
      const heroColor = heroColorFromResult(parsed.result) ?? 'w'
      const quiz = buildQuiz(parsed.sanMoves, { heroColor, startPly: OPENING_CUTOFF_PLY })
      const opening = detectOpening(parsed.sanMoves)
      return {
        ...initialState,
        screen: 'play',
        session: { game: action.game, quiz, heroColor, opening },
        sessionId: action.sessionId,
      }
    }

    case 'GO_HOME':
      return { ...initialState }

    case 'TRY_MOVE': {
      if (state.phase !== 'guess') return state
      const pending = tryPending(state, action.from, action.to, action.promotion)
      return pending ? { ...state, pending, selected: null } : state
    }

    case 'CLICK_SQUARE': {
      if (state.phase !== 'guess' || state.pending || !state.session) return state
      const square = action.square
      if (state.selected) {
        if (square === state.selected) return { ...state, selected: null }
        const pending = tryPending(state, state.selected, square)
        if (pending) return { ...state, pending, selected: null }
        // illegal: reselect if it's the hero's own piece, else clear
        return { ...state, selected: pieceColorAt(state, square) === state.session.heroColor ? square : null }
      }
      return {
        ...state,
        selected: pieceColorAt(state, square) === state.session.heroColor ? square : null,
      }
    }

    case 'TAKE_BACK':
      return { ...state, pending: null, selected: null }

    case 'SET_PROMOTION': {
      if (!state.pending || state.phase !== 'guess') return state
      const pending = tryPending(state, state.pending.from, state.pending.to, action.piece)
      return pending ? { ...state, pending } : state
    }

    case 'SET_REASON':
      return { ...state, reason: action.reason }

    case 'START_GRADING':
      return state.pending ? { ...state, phase: 'grading' } : state

    case 'GRADE_RESULT': {
      const item = currentItem(state)
      if (!item || !state.pending) return state
      const fb = buildFactBundle({
        fen: item.fen,
        userMoveSan: state.pending.san,
        bestMoveUci: action.graded.bestMoveUci,
        masterMoveSan: item.masterMoveSan,
        grade: action.graded.grade,
      })
      const attempt: Attempt = {
        itemIndex: state.index,
        moveNumber: item.moveNumber,
        sideToMove: item.sideToMove,
        fen: item.fen,
        userMoveSan: state.pending.san,
        masterMoveSan: item.masterMoveSan,
        reason: state.reason,
        tier: action.graded.grade.tier,
        swing: action.graded.grade.swing,
      }
      return {
        ...state,
        phase: 'reveal',
        result: { fb, bestMoveUci: action.graded.bestMoveUci },
        lines: action.lines,
        positionWhitePct: action.whitePct,
        attempts: [...state.attempts, attempt],
      }
    }

    case 'GRADING_FAILED':
      return { ...state, phase: 'guess' }

    case 'SET_POSITION_EVAL':
      return { ...state, positionWhitePct: action.whitePct }

    case 'NEXT': {
      if (!state.session) return state
      const cleared = { ...state, pending: null, selected: null, reason: '', result: null, lines: [] }
      if (isLast(state)) return { ...cleared, screen: 'summary' }
      return { ...cleared, index: state.index + 1, phase: 'guess', positionWhitePct: null }
    }

    default:
      return state
  }
}
