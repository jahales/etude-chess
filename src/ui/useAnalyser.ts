import { useEffect, useState } from 'react'
import { StockfishAnalyser } from '../engine/stockfish'
import type { Analyser } from '../engine/analyser'

export interface AnalyserState {
  analyser: Analyser | null
  ready: boolean
  error: string | null
}

/** Create one Stockfish worker for the app's lifetime; expose readiness. */
export function useAnalyser(): AnalyserState {
  const [state, setState] = useState<AnalyserState>({ analyser: null, ready: false, error: null })

  useEffect(() => {
    let disposed = false
    let engine: StockfishAnalyser
    try {
      engine = new StockfishAnalyser()
    } catch {
      setState({ analyser: null, ready: false, error: 'Could not start the chess engine.' })
      return
    }
    setState({ analyser: engine, ready: false, error: null })
    engine
      .ready()
      .then(() => {
        if (!disposed) setState({ analyser: engine, ready: true, error: null })
      })
      .catch(() => {
        if (!disposed) setState({ analyser: engine, ready: false, error: 'The engine failed to start.' })
      })
    return () => {
      disposed = true
      engine.dispose()
    }
  }, [])

  return state
}
