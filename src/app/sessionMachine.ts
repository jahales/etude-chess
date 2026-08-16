import { Chess, type Square } from 'chess.js'
import type { PackGame } from '../content/games'
import { detectOpening } from '../content/openings'
import { parseGame, heroColorFromResult, buildQuiz, type QuizItem } from '../domain/harness'
import { buildFactBundle, type FactBundle } from '../domain/factBundle'
import type { Attempt } from '../domain/session'
import type { GradedMove } from '../engine/grading'
import type { AnalysisLine } from '../engine/analyser'
import type { Color, Score, Wdl } from '../domain/types'
import type { PositionEval } from '../domain/gameRecord'
import { nextImportantMove, whiteWdl, type NextImportant } from '../domain/resultCategory'

// The application layer (ADR 0015): a *pure* reducer for the guess→commit→grade→
// reveal→next state machine. No engine calls, no I/O, no Date.now — the async
// engine work lives in useGuessSession and dispatches results here. This is what
// makes the orchestration unit-testable (issue #18).

export const OPENING_CUTOFF_PLY = 8

/**
 * What a completed pass over this game already knows (#161).
 *
 * Carried on the session so the reveal can offer to skip *forward* — which
 * needs evaluations for positions the learner has not reached, and those exist
 * only because #133's pass computed them. Optional, because the curated pack
 * has no pass and never will.
 */
export interface SessionAnalysis {
  /** `evalByPly[p]` is the evaluation after move `p`, White's. Sparse on purpose. */
  evalByPly: readonly (PositionEval | undefined)[] | undefined
  startEval?: PositionEval
}

export interface Session {
  game: PackGame
  quiz: QuizItem[]
  heroColor: Color
  opening: string | null
  /**
   * True when the caller chose the plies (#144's critical positions).
   *
   * Recorded rather than re-derived because the skip control must not appear on
   * that path: every position in a focused session was selected *because* it
   * cost win%, so "skip to the next important move" would be offering to skip
   * past a list of important moves. Whole-game is the only session where some
   * questions are worth more of your attention than others.
   */
  focused: boolean
  /** The pass's evaluations, when this game has been analysed. */
  analysis?: SessionAnalysis
}
export interface PendingMove {
  san: string
  from: string
  to: string
  afterFen: string
  /** Promotion piece for a promoting move ('q' by default); ignored otherwise. */
  promotion: string
}
/**
 * The move you actually played, as something to read rather than only to grade
 * (#151).
 *
 * `score` is the position your move leaves, **from the mover's perspective** —
 * the same normalisation `GradedMove.playedScoreMover` carries, so the screen
 * turns it into White's the one way everything else does (`whiteScoreLabel`).
 * It is *additional information*, never a second verdict: the grade is the tier
 * on the fact bundle, computed from win% swing (ADR 0010, constitution §9), and
 * a centipawn number is not that.
 */
export interface PlayedMove {
  san: string
  score: Score
  /** The engine's continuation, UCI, from the position after your move. */
  pv: string[]
}

/**
 * The result the position was heading for, before your move and after it — both
 * **White's perspective**, like every other number on screen (#161).
 *
 * One value holding both rather than two optional fields, because a single
 * reading answers nothing: the whole point is the comparison, and the skill's
 * rule (`game-review` §4) is stated as one — *if it reads `1000/0/0` before and
 * after, the move cost win% but never risked the result*. Present only when the
 * engine reported both, so an adapter that cannot supply WDL simply reveals
 * exactly what it revealed before.
 */
export interface ResultShift {
  before: Wdl
  after: Wdl
}

export interface Result {
  fb: FactBundle
  bestMoveUci: string | null
  played: PlayedMove
  /** Absent when the engine reported no WDL — never a claim that nothing moved. */
  resultShift?: ResultShift
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
  | {
      type: 'START_GAME'
      game: PackGame
      sessionId: string
      /**
       * Ask about **only** these plies (#144's critical positions). Absent is
       * the whole game, which is every other caller.
       *
       * A list of plies rather than a list of items, because the reducer must
       * keep building the quiz itself: `domain/reviewPlan.criticalOffer` makes a
       * promise about how many questions there will be by running the same pure
       * `buildQuiz`, and handing prebuilt items in would let the promise and the
       * session drift apart with nothing to notice it.
       */
      focusPlies?: readonly number[]
      /**
       * What a completed pass already computed for this game (#161). Absent for
       * the curated pack, and for a game nobody has analysed.
       */
      analysis?: SessionAnalysis
    }
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
  /** Jump forward to the next question whose move changed the result (#161). */
  | { type: 'SKIP_TO_IMPORTANT' }

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

/**
 * Where "skip to the next important move" would land, or **null when the
 * control has no business existing** (#161).
 *
 * Two different nulls collapsed into one on purpose, because both mean "do not
 * render this", and neither may be turned into a sentence:
 *
 * - a **focused** session — #144's critical positions, where every question was
 *   already chosen for costing win%. Offering to skip ahead there implies some
 *   of them are filler.
 * - a session with **no pass behind it** — the curated pack. Nothing has ever
 *   computed a WDL for those positions, so there is no question to answer.
 *
 * What it must never do is collapse the *third* case, which is a real answer and
 * is returned rather than nulled: a game that was analysed, where the positions
 * ahead have no recorded WDL. That is "we cannot tell", and `NextImportant`
 * keeps the counts a screen needs to say so instead of saying "nothing left".
 *
 * **This is not the same reading as `Result.resultShift`, and the two are never
 * differenced against each other.** They answer different questions about
 * different moves: `resultShift` is the move *you* played, measured by the live
 * grading searches, while this is the move played *in the game*, measured by the
 * stored pass at the pass's budget. On a position where you matched the game
 * they can still disagree, because the budgets differ — and comparing
 * evaluations from two budgets manufactures swings out of nothing
 * (docs/architecture.md). Each comparison stays inside the pass that produced
 * both of its halves, which is what keeps that rule intact here.
 */
export function nextImportant(state: SessionState): NextImportant | null {
  const session = state.session
  if (!session || session.focused || !session.analysis) return null
  return nextImportantMove({
    plies: session.quiz.map((item) => item.ply),
    fromIndex: state.index,
    evalByPly: session.analysis.evalByPly,
    ...(session.analysis.startEval ? { startEval: session.analysis.startEval } : {}),
  })
}

// ---------- reducer ----------

/**
 * Resolve `from`→`to` in a position into a legal PendingMove, or null. Pure and
 * exported so the reducer and the drag handler (which needs a synchronous
 * accept/reject) share one definition of move legality.
 */
export function resolveMove(
  fen: string,
  from: string,
  to: string,
  promotion = 'q',
): PendingMove | null {
  const chess = new Chess(fen)
  try {
    const mv = chess.move({ from, to, promotion })
    return { san: mv.san, from, to, afterFen: chess.fen(), promotion }
  } catch {
    return null
  }
}

/** Apply `from`→`to` to the current item's position; returns the pending move or null. */
function tryPending(
  state: SessionState,
  from: string,
  to: string,
  promotion = 'q',
): PendingMove | null {
  const item = currentItem(state)
  return item ? resolveMove(item.fen, from, to, promotion) : null
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
      // A game that names its own side wins: the curated pack is all decisive
      // and derives the winner's side from the result, but an imported game may
      // be a draw or unfinished, and then the side is a choice the caller made
      // rather than a fact of the game (#55, `domain/studyGame.studySides`).
      const heroColor = action.game.heroColor ?? heroColorFromResult(parsed.result) ?? 'w'
      // The opening cutoff skips theory nobody chose to be asked about. A
      // focused session's plies were *selected* — each one measurably cost win%
      // — so applying the cutoff there would silently drop a blunder on move
      // three from a list presented as "the positions that decided this game"
      // (`domain/reviewPlan.CRITICAL_START_PLY` is the same constant, and the
      // reason is written out there).
      const focus = action.focusPlies
      const quiz = buildQuiz(parsed.sanMoves, {
        heroColor,
        startPly: focus ? 0 : OPENING_CUTOFF_PLY,
        // An imported study or endgame does not begin from the initial position;
        // without this the replay throws on its first move, inside the reducer.
        ...(parsed.startFen ? { startFen: parsed.startFen } : {}),
      }).filter((item) => !focus || focus.includes(item.ply))
      const opening = detectOpening(parsed.sanMoves)
      return {
        ...initialState,
        screen: 'play',
        session: {
          game: action.game,
          quiz,
          heroColor,
          opening,
          focused: !!focus,
          ...(action.analysis ? { analysis: action.analysis } : {}),
        },
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
      if (!item || !state.pending || !state.session) return state
      const fb = buildFactBundle({
        fen: item.fen,
        userMoveSan: state.pending.san,
        bestMoveUci: action.graded.bestMoveUci,
        gameMoveSan: item.masterMoveSan,
        // Read off the game, never re-derived here or in the reveal: the game
        // knows whose moves it holds and the session does not (#158).
        moveSource: state.session.game.moveSource,
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
      // Both readings come off the two searches that graded the move, and both
      // are turned into White's here — the one place that knows whose move it
      // was. `playedWdlMover` is already the mover's, so both take the *same*
      // `sideToMove`; flipping only one of them would report a reversal on every
      // move. Set only as a pair: one half of a comparison is not a comparison.
      const { bestWdl, playedWdlMover } = action.graded
      const resultShift: ResultShift | undefined =
        bestWdl && playedWdlMover
          ? {
              before: whiteWdl(bestWdl, item.sideToMove),
              after: whiteWdl(playedWdlMover, item.sideToMove),
            }
          : undefined
      return {
        ...state,
        phase: 'reveal',
        result: {
          fb,
          bestMoveUci: action.graded.bestMoveUci,
          // Straight off the grading result: both halves came out of the search
          // that graded the move, so nothing here costs a second look (#151).
          played: {
            san: action.graded.userMoveSan,
            score: action.graded.playedScoreMover,
            pv: action.graded.afterPv,
          },
          ...(resultShift ? { resultShift } : {}),
        },
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

    case 'SKIP_TO_IMPORTANT': {
      const target = nextImportant(state)?.target
      // No target is not an error and not a summary: the control is disabled in
      // that case, and a stray dispatch must leave the learner exactly where
      // they are rather than ending their session for them.
      if (!target) return state
      return {
        ...state,
        // The same clearing `NEXT` does, for the same reason — every one of
        // these belongs to the position being left behind, and `positionWhitePct`
        // in particular is an engine reading of a board that is about to change.
        pending: null,
        selected: null,
        reason: '',
        result: null,
        lines: [],
        positionWhitePct: null,
        index: target.index,
        phase: 'guess',
      }
    }

    default:
      return state
  }
}
