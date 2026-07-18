import { useCallback, useEffect, useReducer, useRef } from 'react'
import { Chess } from 'chess.js'
import type { PackGame } from '../content/games'
import { gradeAfterMove } from '../engine/grading'
import { DEFAULT_NODES } from '../engine/analyser'
import { whiteWinPercent } from '../domain/winPercent'
import { saveAttempt } from '../persist/db'
import { useAnalyser } from '../ui/useAnalyser'
import { sessionReducer, initialState, currentItem, type SessionState } from './sessionMachine'

// Binds the pure session reducer to the engine and persistence. Components read
// `state` and call the returned handlers; all async/side-effecting work is here.
export function useGuessSession() {
  const { analyser, ready, error } = useAnalyser()
  const [state, dispatch] = useReducer(sessionReducer, initialState)

  // Live "who's ahead" eval for the current position (fast, low node budget).
  useEffect(() => {
    if (state.screen !== 'play' || !state.session || !analyser || !ready) return
    const item = state.session.quiz[state.index]
    if (!item) return
    let cancelled = false
    dispatch({ type: 'SET_POSITION_EVAL', whitePct: null })
    analyser
      .evaluate(item.fen, { nodes: 250_000 })
      .then((ev) => {
        if (!cancelled) dispatch({ type: 'SET_POSITION_EVAL', whitePct: whiteWinPercent(ev.score, item.sideToMove) })
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [state.screen, state.session, state.index, analyser, ready])

  // Persist each newly recorded attempt (best-effort).
  const persistedRef = useRef(0)
  useEffect(() => {
    if (!state.session || state.attempts.length <= persistedRef.current) return
    const attempt = state.attempts[state.attempts.length - 1]!
    void saveAttempt({
      ...attempt,
      gameId: state.session.game.id,
      sessionId: state.sessionId,
      createdAt: Date.now(),
    })
    persistedRef.current = state.attempts.length
  }, [state.attempts, state.session, state.sessionId])

  const startGame = useCallback(
    (game: PackGame) => dispatch({ type: 'START_GAME', game, sessionId: `s${Date.now()}` }),
    [],
  )
  const goHome = useCallback(() => dispatch({ type: 'GO_HOME' }), [])
  const clickSquare = useCallback((square: string) => dispatch({ type: 'CLICK_SQUARE', square }), [])
  const takeBack = useCallback(() => dispatch({ type: 'TAKE_BACK' }), [])
  const setReason = useCallback((reason: string) => dispatch({ type: 'SET_REASON', reason }), [])
  const next = useCallback(() => dispatch({ type: 'NEXT' }), [])

  // Drag: validate synchronously (react-chessboard needs a boolean) and dispatch.
  const tryMove = useCallback(
    (from: string, to: string): boolean => {
      const item = currentItem(state)
      if (!item || state.phase !== 'guess') return false
      try {
        new Chess(item.fen).move({ from, to, promotion: 'q' })
      } catch {
        return false
      }
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
      const lines = await analyser.analyseLines(item.fen, { nodes: DEFAULT_NODES, multipv: 3 })
      const first = lines[0]
      const best = first
        ? { score: first.score, bestMove: first.pv[0] ?? null }
        : { score: { type: 'cp' as const, value: 0 }, bestMove: null }
      const graded = await gradeAfterMove(analyser, item.fen, state.pending.san, best, {
        nodes: DEFAULT_NODES,
      })
      dispatch({
        type: 'GRADE_RESULT',
        graded,
        lines,
        whitePct: whiteWinPercent(best.score, item.sideToMove),
      })
    } catch (e) {
      console.error('grading failed', e)
      dispatch({ type: 'GRADING_FAILED' })
    }
  }, [state, analyser])

  return {
    state,
    engineReady: ready,
    engineError: error,
    startGame,
    goHome,
    clickSquare,
    tryMove,
    takeBack,
    setReason,
    commit,
    next,
  } satisfies { state: SessionState } & Record<string, unknown>
}
