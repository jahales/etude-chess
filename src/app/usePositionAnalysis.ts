import { useCallback, useEffect, useRef, useState } from 'react'
import type { AnalysisLine } from '../engine/analyser'
import { whiteWinPercent } from '../domain/winPercent'
import { whiteScoreLabel } from '../domain/notation'
import { sideToMoveOf } from '../domain/replay'
import type { PositionEval } from '../domain/gameRecord'
import type { AnalyserState } from './useAnalyser'

/**
 * Analyse whatever position is on the board, on demand.
 *
 * Both session hooks already drive the engine for their own loops; this is the
 * standalone case — "tell me about *this* position" — which is what replay and
 * any future board screen needs. Keeping it here rather than in a component
 * means the staleness rule lives in one place.
 */
export interface PositionAnalysis {
  /** Result for the FEN currently requested, or undefined before the first run. */
  evaluation?: PositionEval
  lines: AnalysisLine[]
  analysing: boolean
  /** Engine unavailable, so the caller can hide the affordance rather than fail. */
  available: boolean
  analyse: () => void
  clear: () => void
}

export const ANALYSIS_NODES = 500_000
export const ANALYSIS_MULTIPV = 3

export function usePositionAnalysis(
  engine: AnalyserState,
  fen: string,
  opts: { nodes?: number; multipv?: number } = {},
): PositionAnalysis {
  const { nodes = ANALYSIS_NODES, multipv = ANALYSIS_MULTIPV } = opts
  const [result, setResult] = useState<{ fen: string; evaluation: PositionEval; lines: AnalysisLine[] } | null>(null)
  const [analysing, setAnalysing] = useState(false)

  // Which FEN the in-flight request was for. The engine is slow enough that the
  // board can move on before a result lands — the same staleness rule the
  // reducers enforce, applied here (see the SET_EVAL/SET_LINES guards).
  const pendingRef = useRef<string | null>(null)

  // Stepping to a new position invalidates the old answer rather than showing it
  // against the wrong board.
  useEffect(() => {
    setResult((r) => (r && r.fen === fen ? r : null))
  }, [fen])

  const analyse = useCallback(() => {
    const analyser = engine.analyser
    if (!analyser || !engine.ready) return
    pendingRef.current = fen
    setAnalysing(true)
    analyser
      .analyseLines(fen, { nodes, multipv })
      .then((lines) => {
        if (pendingRef.current !== fen) return // the board moved on
        const best = lines[0]
        if (!best) return
        const perspective = sideToMoveOf(fen)
        setResult({
          fen,
          evaluation: {
            whitePct: whiteWinPercent(best.score, perspective),
            label: whiteScoreLabel(best.score, perspective),
          },
          lines,
        })
      })
      .catch(() => {})
      .finally(() => {
        if (pendingRef.current === fen) setAnalysing(false)
      })
  }, [engine.analyser, engine.ready, fen, nodes, multipv])

  const clear = useCallback(() => {
    pendingRef.current = null
    setResult(null)
    setAnalysing(false)
  }, [])

  return {
    evaluation: result?.fen === fen ? result.evaluation : undefined,
    lines: result?.fen === fen ? result.lines : [],
    analysing,
    available: Boolean(engine.analyser) && engine.ready,
    analyse,
    clear,
  }
}
