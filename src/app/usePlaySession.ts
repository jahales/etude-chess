import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import type { Color } from '../domain/types'
import { coachVerdict } from '../domain/coach'
import { whiteWinPercent } from '../domain/winPercent'
import { evaluateAndGrade } from '../engine/grading'
import { MaiaOnnxOpponent, maiaModelUrl } from '../engine/maia/maiaOpponent'
import { DEFAULT_LEVEL, type MaiaLevel } from '../engine/maia/opponent'
import type { AnalyserState } from '../ui/useAnalyser'
import { saveGame } from '../persist/db'
import {
  playReducer,
  initialPlayState,
  currentFen,
  historyForMaia,
  isLegalMove,
  sideToMove,
  type PlayState,
} from './playMachine'

// How adventurously Maia plays: 0 ≈ its single most-likely human move; higher samples
// the policy for natural variety. Modest sampling keeps it human-like across games.
const MAIA_TEMPERATURE = 0.5
// Grading nodes: enough for a reliable A/B/C tier, kept snappy for move-by-move play.
const GRADE_NODES = 500_000
// Cheap "who's ahead" refresh for the live eval bar.
const LIVE_NODES = 120_000

// Binds the pure play reducer to Maia (opponent, lazy per level) and Stockfish (the
// shared referee, from App) — every one of your moves is graded before Maia replies
// (ADR 0017). Mirrors useGuessSession; the Maia worker/wasm load only when a game starts.
export function usePlaySession(engine: AnalyserState) {
  const { analyser } = engine
  const [state, dispatch] = useReducer(playReducer, initialPlayState)
  const opponentRef = useRef<MaiaOnnxOpponent | null>(null)
  const levelRef = useRef<MaiaLevel | null>(null)
  const [maiaReady, setMaiaReady] = useState(false)
  const [maiaError, setMaiaError] = useState<string | null>(null)

  const ensureOpponent = useCallback((level: MaiaLevel): MaiaOnnxOpponent => {
    if (opponentRef.current && levelRef.current === level) return opponentRef.current
    opponentRef.current?.dispose()
    const opp = new MaiaOnnxOpponent(maiaModelUrl(level))
    opponentRef.current = opp
    levelRef.current = level
    setMaiaReady(false)
    setMaiaError(null)
    opp
      .ready()
      .then(() => setMaiaReady(true))
      .catch((e) => setMaiaError(e instanceof Error ? e.message : String(e)))
    return opp
  }, [])

  const newGame = useCallback(
    (opts: { yourColor: Color; level: MaiaLevel }) => {
      ensureOpponent(opts.level)
      dispatch({ type: 'NEW_GAME', yourColor: opts.yourColor, level: opts.level, gameId: `m${Date.now()}` })
    },
    [ensureOpponent],
  )

  // Grade each of your moves (the coach). Runs once per staged pending move.
  useEffect(() => {
    if (state.status !== 'grading' || !state.pending) return
    if (!analyser) {
      // Engine failed to start → don't strand the move on "grading"; play on uncoached.
      if (engine.error) dispatch({ type: 'GRADING_FAILED' })
      return
    }
    const fenBefore = currentFen(state)
    const userSan = state.pending.san
    const yourColor = state.yourColor
    let cancelled = false
    evaluateAndGrade(analyser, fenBefore, userSan, { nodes: GRADE_NODES })
      .then((graded) => {
        if (cancelled) return
        const verdict = coachVerdict({
          fen: fenBefore,
          userMoveSan: userSan,
          grade: graded.grade,
          bestMoveUci: graded.bestMoveUci,
        })
        dispatch({
          type: 'COACH_RESULT',
          verdict,
          evalWhitePct: whiteWinPercent(graded.playedScoreMover, yourColor),
        })
      })
      .catch(() => {
        if (!cancelled) dispatch({ type: 'GRADING_FAILED' })
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.status, state.pending?.afterFen, analyser, engine.error])

  // When it's Maia's turn, ask the worker for a move.
  useEffect(() => {
    if (state.status !== 'thinking' || !opponentRef.current) return
    const opp = opponentRef.current
    const fen = currentFen(state)
    let cancelled = false
    opp
      .move(fen, { temperature: MAIA_TEMPERATURE, history: historyForMaia(state) })
      .then((m) => {
        if (cancelled) return
        // Safety net: decodePolicy only emits legal moves, but never freeze on 'thinking'
        // if that ever fails — surface it instead of silently hanging.
        if (!isLegalMove(fen, m.uci.slice(0, 2), m.uci.slice(2, 4), m.uci[4] ?? 'q')) {
          setMaiaError(`Maia returned an unexpected move (${m.uci})`)
          return
        }
        dispatch({ type: 'MAIA_MOVED', uci: m.uci })
      })
      .catch((e) => {
        if (!cancelled) setMaiaError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.status, state.ply])

  // Live "who's ahead" for the current position when it's your move.
  useEffect(() => {
    if (state.status !== 'yourTurn' || !analyser || !state.gameId) return
    const fen = currentFen(state)
    const perspective = sideToMove(state)
    let cancelled = false
    analyser
      .evaluate(fen, { nodes: LIVE_NODES })
      .then((ev) => {
        if (!cancelled) dispatch({ type: 'SET_EVAL', whitePct: whiteWinPercent(ev.score, perspective) })
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.status, state.ply, analyser])

  // Persist a finished game once (best-effort).
  const savedRef = useRef('')
  useEffect(() => {
    if (state.status !== 'over' || !state.result || savedRef.current === state.gameId) return
    savedRef.current = state.gameId
    void saveGame({
      gameId: state.gameId,
      yourColor: state.yourColor,
      level: state.level,
      sanHistory: state.sanHistory,
      outcome: state.result.outcome,
      reason: state.result.reason,
      createdAt: Date.now(),
    })
  }, [state.status, state.result, state.gameId, state.yourColor, state.level, state.sanHistory])

  useEffect(() => () => opponentRef.current?.dispose(), [])

  const goHome = useCallback(() => dispatch({ type: 'GO_HOME' }), [])
  const selectSquare = useCallback((square: string) => dispatch({ type: 'SELECT_SQUARE', square }), [])
  const takeBack = useCallback(() => dispatch({ type: 'TAKE_BACK' }), [])
  const continueMove = useCallback(() => dispatch({ type: 'CONTINUE' }), [])
  const resign = useCallback(() => dispatch({ type: 'RESIGN' }), [])

  const tryMove = useCallback(
    (from: string, to: string): boolean => {
      if (state.status !== 'yourTurn' || !isLegalMove(currentFen(state), from, to)) return false
      dispatch({ type: 'MOVE', from, to })
      return true
    },
    [state],
  )

  return {
    state,
    maiaReady,
    maiaError,
    engineReady: engine.ready,
    defaultLevel: DEFAULT_LEVEL,
    newGame,
    goHome,
    selectSquare,
    tryMove,
    takeBack,
    continueMove,
    resign,
  } satisfies { state: PlayState } & Record<string, unknown>
}
