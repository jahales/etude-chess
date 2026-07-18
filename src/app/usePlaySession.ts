import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import type { Color } from '../domain/types'
import { MaiaOnnxOpponent, maiaModelUrl } from '../engine/maia/maiaOpponent'
import { DEFAULT_LEVEL, type MaiaLevel } from '../engine/maia/opponent'
import { saveGame } from '../persist/db'
import {
  playReducer,
  initialPlayState,
  currentFen,
  historyForMaia,
  isLegalMove,
  type PlayState,
} from './playMachine'

// How adventurously Maia plays: 0 ≈ its single most-likely human move; higher samples
// the policy for natural variety across games. Modest sampling keeps it human-like.
const MAIA_TEMPERATURE = 0.5

// Binds the pure play reducer to the Maia opponent (lazy-loaded per level) and
// persistence. Mirrors useGuessSession; Maia is loaded only when a game starts, so
// the ~13.5 MB wasm + model never touch the guess-the-move path (ADR 0016).
export function usePlaySession() {
  const [state, dispatch] = useReducer(playReducer, initialPlayState)
  const opponentRef = useRef<MaiaOnnxOpponent | null>(null)
  const levelRef = useRef<MaiaLevel | null>(null)
  const [maiaReady, setMaiaReady] = useState(false)
  const [maiaError, setMaiaError] = useState<string | null>(null)

  // Create (or swap, on a level change) the Maia worker.
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
      dispatch({
        type: 'NEW_GAME',
        yourColor: opts.yourColor,
        level: opts.level,
        gameId: `m${Date.now()}`,
      })
    },
    [ensureOpponent],
  )

  // When it's Maia's turn, ask the worker for a move. `ply` changes on every move, so
  // each new thinking turn triggers exactly once.
  useEffect(() => {
    if (state.status !== 'thinking') return
    const opp = opponentRef.current
    if (!opp) return
    let cancelled = false
    opp
      .move(currentFen(state), { temperature: MAIA_TEMPERATURE, history: historyForMaia(state) })
      .then((m) => {
        if (!cancelled) dispatch({ type: 'MAIA_MOVED', uci: m.uci })
      })
      .catch((e) => {
        if (!cancelled) setMaiaError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.status, state.ply])

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

  // Tear down the worker on unmount.
  useEffect(() => () => opponentRef.current?.dispose(), [])

  const goHome = useCallback(() => dispatch({ type: 'GO_HOME' }), [])
  const selectSquare = useCallback((square: string) => dispatch({ type: 'SELECT_SQUARE', square }), [])
  const resign = useCallback(() => dispatch({ type: 'RESIGN' }), [])

  // Drag: validate synchronously (react-chessboard needs a boolean), then dispatch.
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
    defaultLevel: DEFAULT_LEVEL,
    newGame,
    goHome,
    selectSquare,
    tryMove,
    resign,
  } satisfies { state: PlayState } & Record<string, unknown>
}
