import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import type { PackGame } from '../content/games'
import { evaluateAndGrade } from '../engine/grading'
import type { AnalysisLine } from '../engine/analyser'
import { whiteWinPercent } from '../domain/winPercent'
import { saveAttempt } from '../persist/db'
import type { AnalyserState } from './useAnalyser'
import {
  sessionReducer,
  initialState,
  currentItem,
  resolveMove,
  type SessionState,
} from './sessionMachine'
import { DEFAULT_SETTINGS, liveEvalNodes, type AnalysisSettings } from './settings'

// Binds the pure session reducer to the engine (shared from App) and persistence.
// Components read `state` and call the returned handlers; all async work is here.
export function useGuessSession(engine: AnalyserState) {
  const { analyser, ready, error } = engine
  const [state, dispatch] = useReducer(sessionReducer, initialState)
  const [settings, setSettings] = useState<AnalysisSettings>(DEFAULT_SETTINGS)

  // Live "who's ahead" eval for the current position (fast, low node budget).
  useEffect(() => {
    if (state.screen !== 'play' || !state.session || !analyser || !ready) return
    const item = state.session.quiz[state.index]
    if (!item) return
    let cancelled = false
    dispatch({ type: 'SET_POSITION_EVAL', whitePct: null })
    analyser
      .evaluate(item.fen, { nodes: liveEvalNodes(settings) })
      .then((ev) => {
        if (!cancelled) dispatch({ type: 'SET_POSITION_EVAL', whitePct: whiteWinPercent(ev.score, item.sideToMove) })
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [state.screen, state.session, state.index, analyser, ready, settings])

  // Persist each newly recorded attempt (best-effort). The counter is scoped to a
  // sessionId and reset when a new session starts, so a later game's early attempts
  // aren't skipped just because an earlier game had more (review finding #1).
  const persistedRef = useRef({ sessionId: '', count: 0 })
  useEffect(() => {
    if (!state.session) return
    const p = persistedRef.current
    if (p.sessionId !== state.sessionId) {
      p.sessionId = state.sessionId
      p.count = 0
    }
    if (state.attempts.length <= p.count) return
    const attempt = state.attempts[state.attempts.length - 1]!
    void saveAttempt({
      ...attempt,
      gameId: state.session.game.id,
      sessionId: state.sessionId,
      createdAt: Date.now(),
    })
    p.count = state.attempts.length
  }, [state.attempts, state.session, state.sessionId])

  const startGame = useCallback(
    (game: PackGame) => dispatch({ type: 'START_GAME', game, sessionId: `s${Date.now()}` }),
    [],
  )
  const goHome = useCallback(() => dispatch({ type: 'GO_HOME' }), [])
  const clickSquare = useCallback((square: string) => dispatch({ type: 'CLICK_SQUARE', square }), [])
  const takeBack = useCallback(() => dispatch({ type: 'TAKE_BACK' }), [])
  const setPromotion = useCallback((piece: string) => dispatch({ type: 'SET_PROMOTION', piece }), [])
  const setReason = useCallback((reason: string) => dispatch({ type: 'SET_REASON', reason }), [])
  const next = useCallback(() => dispatch({ type: 'NEXT' }), [])

  // Drag: validate synchronously (react-chessboard needs a boolean) via the same
  // resolver the reducer uses, then dispatch.
  const tryMove = useCallback(
    (from: string, to: string): boolean => {
      const item = currentItem(state)
      if (!item || state.phase !== 'guess' || !resolveMove(item.fen, from, to)) return false
      dispatch({ type: 'TRY_MOVE', from, to })
      return true
    },
    [state],
  )

  const commit = useCallback(async () => {
    const item = currentItem(state)
    if (!item || !state.pending || !analyser) return
    dispatch({ type: 'START_GRADING' })
    try {
      // Grade at a fixed MultiPV=1 (both best and played) so the tier never depends
      // on how many lines the learner chose to display (review finding #3).
      const graded = await evaluateAndGrade(analyser, item.fen, state.pending.san, {
        nodes: settings.nodes,
      })
      // Display lines are a separate concern; only run the multi-line search if asked.
      const lines: AnalysisLine[] =
        settings.multipv > 1
          ? await analyser.analyseLines(item.fen, { nodes: settings.nodes, multipv: settings.multipv })
          : [
              {
                multipv: 1,
                score: graded.bestScore,
                pv: graded.bestMoveUci ? [graded.bestMoveUci] : [],
              },
            ]
      dispatch({
        type: 'GRADE_RESULT',
        graded,
        lines,
        whitePct: whiteWinPercent(graded.bestScore, item.sideToMove),
      })
    } catch (e) {
      console.error('grading failed', e)
      dispatch({ type: 'GRADING_FAILED' })
    }
  }, [state, analyser, settings])

  return {
    state,
    settings,
    setSettings,
    engineReady: ready,
    engineError: error,
    startGame,
    goHome,
    clickSquare,
    tryMove,
    takeBack,
    setPromotion,
    setReason,
    commit,
    next,
  } satisfies { state: SessionState } & Record<string, unknown>
}
