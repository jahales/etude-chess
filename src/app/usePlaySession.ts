import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import type { Color } from '../domain/types'
import { coachVerdict } from '../domain/coach'
import { whiteWinPercent } from '../domain/winPercent'
import { whiteScoreLabel } from '../domain/notation'
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

// Modest sampling keeps Maia human-like with variety across games.
const MAIA_TEMPERATURE = 0.5
// Grade your move for a reliable A/B/C tier; keep it snappy for move-by-move play.
const GRADE_NODES = 400_000
// Cheap "who's ahead" refresh for the eval bar + move scores.
const EVAL_NODES = 120_000
// "Show me" engine lines (a few, deeper) — computed only on request.
const LINES_NODES = 500_000
const LINES_MULTIPV = 3

// Binds the pure play reducer to Maia (opponent, lazy per level) and Stockfish (the
// shared referee) for the ambient in-game coach (ADR 0017): you move → Maia replies →
// your move is graded and (optionally) every position is scored. Mirrors useGuessSession.
export function usePlaySession(engine: AnalyserState) {
  const { analyser } = engine
  const [state, dispatch] = useReducer(playReducer, initialPlayState)
  const [showEval, setShowEval] = useState(true)
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

  const gradeKeyRef = useRef('')

  const newGame = useCallback(
    (opts: { yourColor: Color; level: MaiaLevel }) => {
      ensureOpponent(opts.level)
      gradeKeyRef.current = ''
      dispatch({ type: 'NEW_GAME', yourColor: opts.yourColor, level: opts.level, gameId: `m${Date.now()}` })
    },
    [ensureOpponent],
  )

  // Coach: grade your move as soon as it's committed. Keyed to the move (ply+SAN), NOT
  // to status — Maia often replies before the grade finishes, and cancelling on that
  // status change would drop the verdict. The reducer ignores a stale result; gradeKeyRef
  // dedupes so a move is graded once (reset on take-back / new game).
  useEffect(() => {
    const len = state.sanHistory.length
    if (len === 0 || !analyser) return
    const ply = len - 1
    const isYours = (ply % 2 === 0) === (state.yourColor === 'w')
    if (!isYours) return
    const yourSan = state.sanHistory[ply]!
    const key = `${ply}:${yourSan}`
    if (gradeKeyRef.current === key) return
    gradeKeyRef.current = key
    const fenBefore = state.positions[ply]!
    const yourColor = state.yourColor
    evaluateAndGrade(analyser, fenBefore, yourSan, { nodes: GRADE_NODES })
      .then((graded) => {
        dispatch({
          type: 'COACH_RESULT',
          ply,
          fenBefore,
          yourMoveSan: yourSan,
          verdict: coachVerdict({ fen: fenBefore, userMoveSan: yourSan, grade: graded.grade, bestMoveUci: graded.bestMoveUci }),
        })
        dispatch({
          type: 'SET_EVAL',
          ply,
          eval: {
            whitePct: whiteWinPercent(graded.playedScoreMover, yourColor),
            label: whiteScoreLabel(graded.playedScoreMover, yourColor),
          },
        })
      })
      .catch(() => {}) // engine hiccup: no verdict, game plays on
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.sanHistory.length, analyser, state.yourColor])

  // Maia's reply.
  useEffect(() => {
    if (state.status !== 'thinking' || !opponentRef.current) return
    const opp = opponentRef.current
    const fen = currentFen(state)
    let cancelled = false
    opp
      .move(fen, { temperature: MAIA_TEMPERATURE, history: historyForMaia(state) })
      .then((m) => {
        if (cancelled) return
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
  }, [state.status, state.sanHistory.length])

  // Score the current position for the eval bar/list — only when eval is shown.
  useEffect(() => {
    const len = state.sanHistory.length
    if (state.status !== 'yourTurn' || len === 0 || !showEval || !analyser) return
    const ply = len - 1
    const perspective = sideToMove(state)
    let cancelled = false
    analyser
      .evaluate(currentFen(state), { nodes: EVAL_NODES })
      .then((r) => {
        if (!cancelled)
          dispatch({
            type: 'SET_EVAL',
            ply,
            eval: { whitePct: whiteWinPercent(r.score, perspective), label: whiteScoreLabel(r.score, perspective) },
          })
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.status, state.sanHistory.length, showEval, analyser])

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

  // "Show me": fetch the engine's lines for the position you moved from, on request.
  const revealLines = useCallback(async () => {
    if (state.lines.length) {
      dispatch({ type: 'SET_LINES', lines: state.lines }) // re-open without re-analysing
      return
    }
    if (!analyser || !state.lastCoach) return
    try {
      const lines = await analyser.analyseLines(state.lastCoach.fenBefore, {
        nodes: LINES_NODES,
        multipv: LINES_MULTIPV,
      })
      dispatch({ type: 'SET_LINES', lines })
    } catch {
      /* leave collapsed */
    }
  }, [analyser, state.lastCoach, state.lines])

  const hideLines = useCallback(() => dispatch({ type: 'HIDE_LINES' }), [])
  const goHome = useCallback(() => dispatch({ type: 'GO_HOME' }), [])
  const selectSquare = useCallback((square: string) => dispatch({ type: 'SELECT_SQUARE', square }), [])
  const takeBack = useCallback(() => {
    gradeKeyRef.current = '' // allow the replayed move to be graded again
    dispatch({ type: 'TAKE_BACK' })
  }, [])
  const resign = useCallback(() => dispatch({ type: 'RESIGN' }), [])
  const drawGame = useCallback(() => dispatch({ type: 'DRAW_GAME' }), [])

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
    showEval,
    setShowEval,
    newGame,
    goHome,
    selectSquare,
    tryMove,
    takeBack,
    resign,
    drawGame,
    revealLines,
    hideLines,
  } satisfies { state: PlayState } & Record<string, unknown>
}
