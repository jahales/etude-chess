import { useCallback, useEffect, useRef, useState } from 'react'
import { whiteWinPercent } from '../domain/winPercent'
import { whiteScoreLabel } from '../domain/notation'
import { sideToMoveOf } from '../domain/replay'
import type { PositionEval } from '../domain/gameRecord'
import { saveAnalysis, type StoredGame } from '../persist/db'
import type { AnalyserState } from './useAnalyser'
import {
  BATCH_NODES,
  isAnalysed,
  pliesNeedingAnalysis,
  progressOf,
  withEvalAt,
  type AnalysisProgress,
} from './gameAnalysis'

/**
 * Analyse every position of a stored game in one pass (#68).
 *
 * Replay already analyses one position on request; this is the coverage version
 * that lights up the whole move list. It runs in the shared Stockfish worker, so
 * it goes one position at a time and stays interruptible — the user keeps
 * stepping through the game while results fill in behind them.
 */
export interface GameAnalysis {
  /** Evaluations known so far — the stored ones, plus whatever this pass has produced. */
  evalByPly: (PositionEval | undefined)[] | undefined
  /** Evaluation of the position before move 0, once the pass has computed it. */
  startEval: PositionEval | undefined
  progress: AnalysisProgress | null
  running: boolean
  /** Already covered by a completed pass at this budget. */
  analysed: boolean
  available: boolean
  start: () => void
  cancel: () => void
}

export function useGameAnalysis(
  engine: AnalyserState,
  game: StoredGame,
  positions: readonly string[],
): GameAnalysis {
  const [evalByPly, setEvalByPly] = useState(game.evalByPly)
  const [startEval, setStartEval] = useState(game.startEval)
  const [progress, setProgress] = useState<AnalysisProgress | null>(null)
  const [running, setRunning] = useState(false)
  // Completion has to be tracked here as well as read off the record: we persist
  // the finished pass, but the `game` prop is owned by the caller and doesn't
  // refresh, so deriving "analysed" from it alone would leave the screen
  // claiming the work was still outstanding until you navigated away and back.
  const [completedHere, setCompletedHere] = useState(false)

  // Set while a pass is in flight; clearing it is how cancel and unmount stop it.
  const runIdRef = useRef(0)

  // A different game means different results; never carry them across.
  useEffect(() => {
    runIdRef.current++
    setEvalByPly(game.evalByPly)
    setStartEval(game.startEval)
    setProgress(null)
    setRunning(false)
    setCompletedHere(false)
  }, [game.gameId, game.evalByPly])

  // Abandon an in-flight pass when the screen goes away, so a background walk of
  // 60 positions doesn't keep the worker busy after the user has moved on.
  useEffect(() => () => void runIdRef.current++, [])

  const start = useCallback(() => {
    const analyser = engine.analyser
    if (!analyser || !engine.ready || running) return
    const plies = pliesNeedingAnalysis(game, BATCH_NODES, positions.length)
    if (plies.length === 0) return

    const runId = ++runIdRef.current
    setRunning(true)
    setProgress(progressOf(0, plies.length))

    void (async () => {
      // Accumulated locally as well as in state: the save at the end needs the
      // whole set, and reading it back out of state would race the last update.
      let acc = game.evalByPly
      let startEval = game.startEval
      let done = 0

      // The start position, so move 1 has something to be measured against.
      // Without it the first move of every game is permanently unscorable (#74).
      if (!startEval && positions[0]) {
        try {
          const { score } = await analyser.evaluate(positions[0], { nodes: BATCH_NODES })
          startEval = {
            whitePct: whiteWinPercent(score, sideToMoveOf(positions[0])),
            label: whiteScoreLabel(score, sideToMoveOf(positions[0])),
          }
        } catch {
          // Non-fatal: the first move simply stays unmeasured.
        }
      }
      if (runIdRef.current !== runId) return
      for (const ply of plies) {
        if (runIdRef.current !== runId) return // cancelled or unmounted
        // positions[ply + 1] is the position *after* move `ply`, which is what
        // evalByPly is indexed by. A truncated replay simply has fewer.
        const fen = positions[ply + 1]
        if (!fen) break
        try {
          const { score } = await analyser.evaluate(fen, { nodes: BATCH_NODES })
          const perspective = sideToMoveOf(fen)
          acc = withEvalAt(acc, ply, {
            whitePct: whiteWinPercent(score, perspective),
            label: whiteScoreLabel(score, perspective),
          })
        } catch {
          // One unanalysable position shouldn't abandon the game; it stays a gap.
        }
        if (runIdRef.current !== runId) return
        done++
        setEvalByPly(acc)
        setProgress(progressOf(done, plies.length))
      }

      if (runIdRef.current !== runId) return
      setStartEval(startEval)
      setRunning(false)

      // Persist so re-opening the game is instant. Only claim the pass completed
      // if it actually covered everything — a partial set is still worth keeping,
      // but marking it done would stop it ever being finished.
      const complete = done === plies.length
      if (complete) setCompletedHere(true)
      // Targeted write: `game` here is a snapshot the caller took, possibly
      // minutes ago, and a full replace would revert whatever the play session
      // has persisted since (a late grade landing in coachLog, say).
      await saveAnalysis(game.gameId, {
        evalByPly: acc,
        startEval,
        ...(complete ? { analysedAt: Date.now(), analysisNodes: BATCH_NODES } : {}),
      })
    })()
  }, [engine.analyser, engine.ready, running, game, positions])

  const cancel = useCallback(() => {
    runIdRef.current++
    setRunning(false)
  }, [])

  return {
    evalByPly,
    startEval,
    progress,
    running,
    analysed: completedHere || isAnalysed(game),
    available: Boolean(engine.analyser) && engine.ready,
    start,
    cancel,
  }
}
