import { useCallback, useEffect, useMemo, useReducer, useState } from 'react'
import type { AnalysisLine } from '../engine/analyser'
import type { Material } from '../domain/material'
import { playedLineToSan, pvToSan, whiteScoreLabel } from '../domain/notation'
import type { Score } from '../domain/types'
import { sideToMoveOf } from '../domain/replay'
import {
  explorationFen,
  explorationMoves,
  explorationReducer,
  isOffGame,
  moveSan,
  pieceColorAt,
  type Exploration,
  type ExploredMove,
} from '../domain/exploration'
import type { AnalyserState } from '../app/useAnalyser'
import { usePositionAnalysis } from '../app/usePositionAnalysis'
import { moveLabel } from './format'

/**
 * Lichess-style vertical eval bar. White's fill grows from White's side of the
 * board, so it follows the board orientation (flip / Black-hero) — review #2.
 */
export function EvalBar({
  whitePct,
  whiteBottom = true,
}: {
  whitePct: number | null
  whiteBottom?: boolean
}) {
  const pct = whitePct == null ? 50 : Math.max(0, Math.min(100, whitePct))
  return (
    <div
      className="evalbar"
      role="img"
      aria-label={whitePct == null ? 'evaluation pending' : `White ${Math.round(pct)} percent`}
    >
      <div
        className="evalbar-white"
        style={{ height: `${pct}%`, top: whiteBottom ? 'auto' : 0, bottom: whiteBottom ? 0 : 'auto' }}
      />
    </div>
  )
}

const GLYPH: Record<string, string> = { p: '♟', n: '♞', b: '♝', r: '♜', q: '♛' }

/** Captured pieces + net material advantage, at a glance. */
export function MaterialStrip({ material }: { material: Material }) {
  const leader = material.diff > 0 ? 'White' : material.diff < 0 ? 'Black' : null
  return (
    <div className="material">
      <span className="cap dark">{material.capturedByWhite.map((t) => GLYPH[t] ?? '').join('')}</span>
      <span className="cap light">{material.capturedByBlack.map((t) => GLYPH[t] ?? '').join('')}</span>
      <span className="mat-diff mono">
        {leader ? `${leader} +${Math.abs(material.diff)}` : 'Even material'}
      </span>
    </div>
  )
}

/**
 * The engine's top lines — each with its score and the concrete sequence.
 *
 * Scores are shown from **White's** perspective, like every other score in the
 * UI (architecture.md: "bar, chip, move list, lines"). UCI reports them relative
 * to the side to move, so with Black to move the raw number has the opposite
 * sign to the eval bar and the score chip sitting next to it.
 *
 * `onPickMove` makes each move a button that walks the board into the line
 * (#131). It hands back the FEN the line was rendered from, because that is
 * what lets the reducer refuse to walk a line against a position it was not
 * computed for — see `domain/exploration.spliceAt`. Without a handler the panel
 * is the static text it has always been.
 */
export function LinesPanel({
  fen,
  lines,
  onPickMove,
}: {
  fen: string
  lines: AnalysisLine[]
  onPickMove?: (fen: string, moves: string[], ply: number) => void
}) {
  if (lines.length === 0) return null
  const sideToMove = sideToMoveOf(fen)
  return (
    <div className="lines">
      <div className="lines-head">Engine lines</div>
      {lines.map((ln, i) => {
        const sans = pvToSan(fen, ln.pv, 6)
        return (
          <div key={ln.multipv} className={`line ${i === 0 ? 'best' : ''}`}>
            <span className="line-score mono">{whiteScoreLabel(ln.score, sideToMove)}</span>
            <span className="line-pv mono">
              {onPickMove
                ? sans.map((san, ply) => (
                    <button
                      key={ply}
                      type="button"
                      className="line-move"
                      onClick={() => onPickMove(fen, sans, ply)}
                      title="Play this line out on the board"
                    >
                      {san}
                    </button>
                  ))
                : sans.join(' ')}
            </span>
          </div>
        )
      })}
    </div>
  )
}

/**
 * The move **you** played: what it leaves on the board, and how the engine says
 * the game goes on from there (#151).
 *
 * Three things this has to get right, and each is a way of misleading a reader
 * who is looking at the engine's ranked lines a centimetre below:
 *
 * 1. **It is not a recommendation.** It sits under its own heading, in your
 *    colour — the amber the board already draws your move in — and never inside
 *    "Engine lines". One of the two panels is the mistake, and which one must
 *    never be a matter of reading carefully.
 * 2. **It is not the grade.** The verdict is the tier above, from win% swing
 *    (ADR 0010, constitution §9); this is a centipawn number, which is a
 *    different question with a different scale. The caption says so, because two
 *    numbers side by side otherwise read as two attempts at the same one.
 * 3. **The score is White's**, like the bar, the chip and the lines. `score`
 *    arrives normalised to the *mover*, so with Black to move it has the
 *    opposite sign to what belongs on screen.
 *
 * It is a line like any other, so `onPickMove` walks it exactly as an engine
 * line is walked: same handler, same reducer, rooted at the same position — the
 * played move is simply its first ply.
 */
export function PlayedLinePanel({
  fen,
  san,
  score,
  pv,
  onPickMove,
}: {
  /** The game position the move was played in — the line's root. */
  fen: string
  san: string
  /** The eval after your move, from the mover's perspective. */
  score: Score
  /** The engine's continuation, UCI, from the position after your move. */
  pv: string[]
  onPickMove?: (fen: string, moves: string[], ply: number) => void
}) {
  const sideToMove = sideToMoveOf(fen)
  const moves = playedLineToSan(fen, san, pv)
  if (moves.length === 0) return null
  return (
    <div className="played-line">
      <div className="lines-head played-head">
        <span className="swatch user" /> The move you played
      </div>
      <div className="line played">
        <span className="line-score mono">{whiteScoreLabel(score, sideToMove)}</span>
        <span className="line-pv mono">
          {onPickMove
            ? moves.map((m, ply) => (
                <button
                  key={ply}
                  type="button"
                  className="line-move"
                  onClick={() => onPickMove(fen, moves, ply)}
                  title="Play your move out on the board"
                >
                  {m}
                </button>
              ))
            : moves.join(' ')}
        </span>
      </div>
      <p className="played-note">
        {moves.length > 1
          ? 'Where the engine says your move leads — its answer, not its advice.'
          : 'Your move ended the game, so there is nothing to play on.'}{' '}
        The score is the position your move leaves, read from White&apos;s side. It comes from its
        own search, so it can sit a little apart from the same move inside an engine line. The
        verdict is still the tier above — win% swing, not pawns.
      </p>
    </div>
  )
}

// ---------- Walking a line on the board (#131) ----------

/**
 * How long the cursor has to settle before the explored position is analysed.
 *
 * The Stockfish adapter serialises searches, so analysing on every keypress
 * queues one whole search per press and the answer you actually wanted lands
 * seconds behind your last arrow. Waiting keeps at most one search outstanding.
 */
const SETTLE_MS = 300

/**
 * Stands in for `usePositionAnalysis`'s FEN when there is nothing to explore.
 * It is never analysed — `analyse()` is only ever called while `fen` is set —
 * and the hook returns no lines for it either way.
 */
const NO_POSITION = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'

export interface ExplorationUi {
  exploration: Exploration | null
  /**
   * The board while you are off the game, or **null** when the game position
   * stands. Null at cursor 0 too: that position *is* the game's, and a screen
   * that flagged it as an exploration would be crying wolf.
   */
  fen: string | null
  offGame: boolean
  moves: ExploredMove[]
  cursor: number
  /** Engine output for `fen`, and only ever for `fen`. */
  lines: AnalysisLine[]
  whitePct: number | null
  scoreLabel: string | null
  analysing: boolean
  enter: (fen: string, moves: string[], ply: number) => void
  /** Returns whether the move was legal, which is what the board drag needs. */
  play: (from: string, to: string) => boolean
  /** Click-to-move, the other half of the affordance the guess board teaches. */
  clickSquare: (square: string) => void
  /** The square picked up, for the board's highlight. */
  selected: string | null
  step: (delta: number) => void
  seek: (cursor: number) => void
  leave: () => void
}

/**
 * Bind the exploration reducer to the board, the keyboard and the engine.
 *
 * It lives beside the lines panel rather than in `app/` because it is the
 * behaviour of *this* panel — clicking an engine line and walking it — and the
 * rules it drives are already pure and tested in `domain/exploration.ts`.
 *
 * `rootFen` is the real game position, or null when the screen has nothing to
 * explore from.
 */
export function useExploration(engine: AnalyserState, rootFen: string | null): ExplorationUi {
  const [raw, dispatch] = useReducer(explorationReducer, null)

  // An exploration belongs to the position it hangs off, so when the game moves
  // on it is simply gone. Deriving that beats clearing it in an effect: there is
  // no frame in which a stale line is still on screen against the new position.
  const exploration = raw && rootFen !== null && raw.rootFen === rootFen ? raw : null
  const offGame = isOffGame(exploration)
  const fen = offGame ? explorationFen(exploration!) : null
  const boardFen = exploration ? explorationFen(exploration) : rootFen

  const analysis = usePositionAnalysis(engine, fen ?? NO_POSITION)
  const { analyse } = analysis

  useEffect(() => {
    if (fen === null) return
    const timer = setTimeout(analyse, SETTLE_MS)
    return () => clearTimeout(timer)
  }, [fen, analyse])

  const lastCursor = exploration?.line.length ?? 0
  const active = exploration !== null
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      // Never steal the arrow keys from something being typed into. The guess
      // screen puts a textarea a few pixels from this board.
      const el = e.target as HTMLElement | null
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return
      if (e.key === 'ArrowLeft') dispatch({ type: 'STEP', delta: -1 })
      else if (e.key === 'ArrowRight') dispatch({ type: 'STEP', delta: 1 })
      else if (e.key === 'Home') dispatch({ type: 'SEEK', cursor: 0 })
      else if (e.key === 'End') dispatch({ type: 'SEEK', cursor: lastCursor })
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, lastCursor])

  // The square picked up, remembered against the position it was picked up on.
  // Deriving it away when the board moves beats clearing it in an effect: a
  // highlight can never outlive the position that made sense of it.
  const [pick, setPick] = useState<{ fen: string; square: string } | null>(null)
  const selected = pick && pick.fen === boardFen ? pick.square : null

  const enter = useCallback(
    (lineFen: string, moves: string[], ply: number) =>
      dispatch({ type: 'ENTER', fen: lineFen, moves, ply }),
    [],
  )
  const play = useCallback(
    (from: string, to: string) => {
      if (boardFen === null) return false
      // A branch auto-queens. The guess screen's promotion picker belongs to the
      // move you are committing, and a second picker on the exploration would be
      // another thing to get wrong for a case that is rare inside a six-ply PV.
      dispatch({ type: 'PLAY', fen: boardFen, from, to })
      setPick(null)
      return true
    },
    [boardFen],
  )

  const clickSquare = useCallback(
    (square: string) => {
      if (boardFen === null) return
      // An exploration moves both sides, so a piece is pickable when it belongs
      // to whoever is to move — there is no hero colour on an analysis board.
      const own = pieceColorAt(boardFen, square) === sideToMoveOf(boardFen)
      if (selected && square !== selected && moveSan(boardFen, selected, square)) {
        dispatch({ type: 'PLAY', fen: boardFen, from: selected, to: square })
        setPick(null)
        return
      }
      setPick(own && square !== selected ? { fen: boardFen, square } : null)
    },
    [boardFen, selected],
  )

  const step = useCallback((delta: number) => dispatch({ type: 'STEP', delta }), [])
  const seek = useCallback((cursor: number) => dispatch({ type: 'SEEK', cursor }), [])
  const leave = useCallback(() => dispatch({ type: 'LEAVE' }), [])

  const moves = useMemo(() => (exploration ? explorationMoves(exploration) : []), [exploration])

  return {
    exploration,
    fen,
    offGame,
    moves,
    cursor: exploration?.cursor ?? 0,
    // Belt and braces on the cross-cutting rule: `usePositionAnalysis` already
    // withholds a result computed for a different FEN, and this makes it
    // impossible for exploration output to reach a screen showing the game.
    lines: fen ? analysis.lines : [],
    whitePct: fen ? analysis.evaluation?.whitePct ?? null : null,
    scoreLabel: fen ? analysis.evaluation?.label ?? null : null,
    analysing: fen !== null && analysis.analysing,
    enter,
    play,
    clickSquare,
    selected,
    step,
    seek,
    leave,
  }
}

/**
 * The line you are walking, in the side column: where you are in it, what the
 * engine makes of it, and the one control back to the game.
 *
 * It says "not the game" in words as well as on the board, because the two
 * things a reader can mistake for each other are a real position and an
 * imagined one, and only one of them is what actually happened.
 */
export function ExplorationBar({ explore }: { explore: ExplorationUi }) {
  if (!explore.exploration) return null
  return (
    <div className={`exploring ${explore.offGame ? 'off' : ''}`} role="status">
      <div className="exploring-head">
        {/* At cursor 0 the board really is the game position, so saying "not the
            game" there would be false — and a warning that is sometimes false
            is one people learn to ignore. */}
        <span className="exploring-flag">
          {explore.offGame ? 'Exploring' : 'Back at the game position'}
        </span>
        <span className="exploring-note">
          {explore.offGame
            ? 'This is not the game — an engine line, or your own branch off it.'
            : 'Step forward to walk the line again.'}
        </span>
        {explore.scoreLabel && <span className="score-chip mono">{explore.scoreLabel}</span>}
        {explore.analysing && !explore.scoreLabel && (
          <span className="exploring-pending mono">analysing…</span>
        )}
        <button className="btn ghost exploring-back" type="button" onClick={explore.leave}>
          Back to the game
        </button>
      </div>
      <div className="exploring-line mono">
        <button
          type="button"
          className={`explore-move root ${explore.cursor === 0 ? 'at' : ''}`}
          onClick={() => explore.seek(0)}
        >
          start
        </button>
        {explore.moves.map((m) => (
          <button
            key={m.index}
            type="button"
            className={`explore-move ${m.index + 1 === explore.cursor ? 'at' : ''}`}
            onClick={() => explore.seek(m.index + 1)}
            aria-current={m.index + 1 === explore.cursor ? 'true' : undefined}
          >
            {(m.side === 'w' || m.index === 0) && (
              <span className="explore-num">{moveLabel(m.moveNumber, m.side)}</span>
            )}
            {m.san}
          </button>
        ))}
      </div>
      <p className="exploring-hint">
        ← → to step · click a move in a line to jump · play a move on the board to branch off
      </p>
    </div>
  )
}

/** Transport for the exploration, sitting under the board where replay's does. */
export function ExplorationControls({ explore }: { explore: ExplorationUi }) {
  const last = explore.moves.length
  return (
    <>
      <button
        className="btn ghost"
        type="button"
        onClick={() => explore.seek(0)}
        aria-label="Back to the game position"
      >
        ⏮
      </button>
      <button
        className="btn ghost"
        type="button"
        onClick={() => explore.step(-1)}
        disabled={explore.cursor === 0}
        aria-label="Previous move in the line"
      >
        ‹
      </button>
      <span className="replay-pos mono">
        {explore.cursor} / {last}
      </span>
      <button
        className="btn ghost"
        type="button"
        onClick={() => explore.step(1)}
        disabled={explore.cursor === last}
        aria-label="Next move in the line"
      >
        ›
      </button>
      <button
        className="btn ghost"
        type="button"
        onClick={() => explore.seek(last)}
        aria-label="End of the line"
      >
        ⏭
      </button>
    </>
  )
}
