import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { whiteWinPercent } from '../domain/winPercent'
import { whiteScoreLabel } from '../domain/notation'
import { replayPositions, sideToMoveOf } from '../domain/replay'
import type { PositionEval } from '../domain/gameRecord'
import { getDbAnalysis, saveDbAnalysis, type DbGame } from '../persist/dbGames'
import type { AnalyserState } from './useAnalyser'
import {
  BATCH_NODES,
  isAnalysed,
  pliesNeedingAnalysis,
  progressOf,
  withEvalAt,
  type AnalysisProgress,
  type AnalysisRecord,
} from './gameAnalysis'

/**
 * Analyse every position of an **imported** game in one pass (#133).
 *
 * The sibling of `useGameAnalysis`, which does this for a game you played
 * against Maia. Deliberately the same shape, and the budget cannot drift between
 * them because both take `BATCH_NODES` from `gameAnalysis.ts` — one pass at one
 * node count is what makes the scores within a game comparable, and what the
 * annotation glyphs rest on. What differs is only where the result is kept: an
 * imported game's evaluations live in a table beside its row rather than on it
 * (`persist/db.ts`'s v7 comment says why), so they are *loaded* rather than
 * handed in, and the screen cannot start a pass before that read lands.
 *
 * **The positions are rebuilt here rather than passed in**, and that is the
 * point rather than a convenience. An imported game can start from somewhere
 * other than move 1 (#128) — studies, endgame collections, puzzle sets — and a
 * pass that replayed its movetext from the standard position would score
 * positions the game was never in, for exactly the games a trainer most wants.
 * Deriving them from the same row the analysis is filed against means there is
 * no way to drive this over an imported game and forget its starting position,
 * and it is why `positions` comes back out: the caller renders the same
 * reconstruction that was scored, rather than a second one that could differ.
 */

/** The fields a pass needs off an imported row. `DbGame` satisfies it. */
export type AnalysableDbGame = Pick<DbGame, 'key' | 'movetext' | 'startFen'>

export interface ImportedGameAnalysis {
  /**
   * Every position of the game, index `i` being the one *before* move `i` —
   * the same array the pass scored. Shorter than the move list when the
   * movetext stops replaying, and one entry long when it never starts.
   */
  positions: readonly string[]
  /** Evaluations known so far — the stored ones, plus whatever this pass has produced. */
  evalByPly: (PositionEval | undefined)[] | undefined
  /** Evaluation of the position before move 0, without which move 1 is unscorable. */
  startEval: PositionEval | undefined
  progress: AnalysisProgress | null
  running: boolean
  /** Already covered by a completed pass at this budget. */
  analysed: boolean
  /** True once a pass could actually be started: engine ready, stored work read. */
  available: boolean
  start: () => void
  cancel: () => void
}

/** Stored movetext as SAN. It is text, and this is where it becomes moves. */
const movesOf = (movetext: string): string[] => movetext.split(/\s+/).filter(Boolean)

export function useDbGameAnalysis(
  engine: AnalyserState,
  game: AnalysableDbGame,
): ImportedGameAnalysis {
  const { key, movetext, startFen } = game

  const sanHistory = useMemo(() => movesOf(movetext), [movetext])
  const positions = useMemo(() => replayPositions(sanHistory, startFen), [sanHistory, startFen])

  const [evalByPly, setEvalByPly] = useState<(PositionEval | undefined)[] | undefined>(undefined)
  const [startEval, setStartEval] = useState<PositionEval | undefined>(undefined)
  // What a previous pass recorded, or `{}` for a game nobody has analysed.
  const [record, setRecord] = useState<AnalysisRecord>({})
  const [loaded, setLoaded] = useState(false)
  const [progress, setProgress] = useState<AnalysisProgress | null>(null)
  const [running, setRunning] = useState(false)

  // Bumped by every change of interest — a new game, a cancel, unmount. An
  // async step that comes back to find it changed drops its result on the floor.
  const runIdRef = useRef(0)

  // A different game means different results; never carry them across, and
  // never let the previous game's load land on this one.
  useEffect(() => {
    const runId = ++runIdRef.current
    setEvalByPly(undefined)
    setStartEval(undefined)
    setRecord({})
    setLoaded(false)
    setProgress(null)
    setRunning(false)

    void (async () => {
      // Best-effort by construction: no storage, or a read that fails, comes
      // back as "not analysed" and the game can simply be analysed again.
      const stored = await getDbAnalysis({ key, startFen })
      if (runIdRef.current !== runId) return
      if (stored) {
        setEvalByPly(stored.evalByPly)
        setStartEval(stored.startEval)
        setRecord({ analysedAt: stored.analysedAt, analysisNodes: stored.analysisNodes })
      }
      setLoaded(true)
    })()
  }, [key, startFen])

  // Abandon an in-flight pass when the screen goes away, so a background walk of
  // 60 positions doesn't keep the worker busy after the user has moved on.
  useEffect(() => () => void runIdRef.current++, [])

  const start = useCallback(() => {
    const analyser = engine.analyser
    // `loaded` is part of the guard: starting before the stored pass has been
    // read would redo work that is already done and then overwrite it.
    if (!analyser || !engine.ready || running || !loaded) return
    const plies = pliesNeedingAnalysis({ sanHistory, ...record }, BATCH_NODES, positions.length)
    if (plies.length === 0) return

    const runId = ++runIdRef.current
    setRunning(true)
    setProgress(progressOf(0, plies.length))

    void (async () => {
      // Accumulated locally as well as in state: the save at the end needs the
      // whole set, and reading it back out of state would race the last update.
      let acc = evalByPly
      let atStart = startEval
      let done = 0
      // Positions that came back with a score, which is not the same as
      // positions attempted — see the completion rule below.
      let scored = 0

      // The start position, so move 1 has something to be measured against.
      // Without it the first move of every game is permanently unscorable (#74).
      if (!atStart && positions[0]) {
        try {
          const { score } = await analyser.evaluate(positions[0], { nodes: BATCH_NODES })
          atStart = {
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
          scored++
        } catch {
          // One unanalysable position shouldn't abandon the game; it stays a gap.
        }
        if (runIdRef.current !== runId) return
        done++
        setEvalByPly(acc)
        setProgress(progressOf(done, plies.length))
      }

      if (runIdRef.current !== runId) return
      setStartEval(atStart)
      setRunning(false)

      // Completion means every position asked for came back with a score, not
      // merely that every one was tried. `evaluate` only rejects when the worker
      // has gone, so a pass with gaps in it is an engine that died partway —
      // and "analysed" with no evaluations is indistinguishable downstream from
      // a game where nothing went wrong (#132 selects its moments off these).
      // A partial set is still stored: those positions were scored at this
      // budget and re-running is what fills the rest.
      const complete = scored === plies.length
      const analysedAt = Date.now()
      if (complete) setRecord({ analysedAt, analysisNodes: BATCH_NODES })
      // A pass that produced nothing at all leaves no row: an empty record and
      // no record mean the same thing, and only one of them takes up space in a
      // table sized by how many games have actually been analysed.
      if (!acc && !atStart) return
      await saveDbAnalysis({
        key,
        evalByPly: acc,
        startEval: atStart,
        // Filed with the position it was computed from, so a row replaced by a
        // re-import can't be served evaluations of a different game.
        startFen,
        ...(complete ? { analysedAt, analysisNodes: BATCH_NODES } : {}),
      })
    })()
  }, [
    engine.analyser,
    engine.ready,
    running,
    loaded,
    sanHistory,
    positions,
    record,
    evalByPly,
    startEval,
    key,
    startFen,
  ])

  const cancel = useCallback(() => {
    runIdRef.current++
    setRunning(false)
  }, [])

  return {
    positions,
    evalByPly,
    startEval,
    progress,
    running,
    analysed: isAnalysed(record),
    available: Boolean(engine.analyser) && engine.ready && loaded,
    start,
    cancel,
  }
}
