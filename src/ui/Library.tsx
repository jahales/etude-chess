import { useCallback, useEffect, useMemo, useState } from 'react'
import { replayPositions } from '../domain/replay'
import {
  buildReplayMoves,
  replayRows,
  coachAtCursor,
  clampCursor,
  type ReplayMove,
} from '../app/replay'
import type { AnalyserState } from '../app/useAnalyser'
import { usePositionAnalysis } from '../app/usePositionAnalysis'
import { countGames, gameKind, listGames, type StoredGame } from '../persist/db'
import { BoardPanel } from './BoardPanel'
import { LinesPanel } from './Analysis'
import { TIER_CLASS, TIER_TEXT, sideName } from './format'

// ---------- Library ----------

/** How many games the table shows. Beyond this we say so rather than truncating quietly. */
const LIBRARY_LIMIT = 200

export function Library({
  onOpen,
  onPlay,
}: {
  onOpen: (game: StoredGame) => void
  onPlay: () => void
}) {
  const [games, setGames] = useState<StoredGame[] | null>(null) // null = still loading
  const [total, setTotal] = useState(0)

  useEffect(() => {
    let cancelled = false
    void Promise.all([listGames(LIBRARY_LIMIT), countGames()]).then(([g, n]) => {
      if (cancelled) return
      setGames(g)
      setTotal(n)
    })
    return () => {
      cancelled = true
    }
  }, [])

  if (games === null) return <p className="banner">Loading your games…</p>

  if (games.length === 0) {
    return (
      <div className="library-empty">
        <p className="lede">
          Nothing here yet. Finished games show up automatically — with the coach&apos;s verdict on
          every move, so you can walk back through them.
        </p>
        <button className="btn primary" type="button" onClick={onPlay}>
          Play a coached game
        </button>
      </div>
    )
  }

  return (
    <>
      {total > games.length && (
        <p className="lede table-note">
          Showing your {games.length} most recent games of {total}.
        </p>
      )}
      <div className="table-wrap">
      <table className="games-table">
        <thead>
          <tr>
            <th scope="col">Played</th>
            <th scope="col">You</th>
            <th scope="col">Maia</th>
            <th scope="col">Result</th>
            <th scope="col" className="num">
              Accuracy
            </th>
            <th scope="col" className="num">
              Take-backs
            </th>
            <th scope="col">
              <span className="sr-only">Open</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {games.map((g) => (
            <tr key={g.gameId}>
              <td>{formatDate(g.createdAt)}</td>
              <td>
                {sideName(g.yourColor)}
                {gameKind(g) === 'playout' && <span className="badge">play-out</span>}
              </td>
              <td className="mono">{g.level}</td>
              <td>
                <span className={`result ${g.outcome}`}>{outcomeText(g)}</span>
              </td>
              <td className="num mono">{accuracyText(g)}</td>
              <td className="num mono">{g.takebacks}</td>
              <td>
                <button className="btn ghost" type="button" onClick={() => onOpen(g)}>
                  Review →
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </>
  )
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

function outcomeText(g: StoredGame): string {
  if (g.outcome === 'draw') return `Draw · ${g.reason}`
  return `${g.outcome === 'you' ? 'Won' : 'Lost'} · ${g.reason}`
}

/**
 * A game the coach never graded has `accuracy: 0`, which would read as a verdict
 * on your play rather than as an absence of data.
 */
function accuracyText(g: StoredGame): string {
  const graded = g.coachLog === undefined || g.coachLog.length > 0
  return graded ? `${g.accuracy.toFixed(2)}%` : '—'
}

// ---------- Replay ----------

export function Replay({
  game,
  engine,
  initialCursor = 0,
  onBack,
}: {
  game: StoredGame
  /** Reviewing your own game needs the engine too — not just the stored verdicts. */
  engine: AnalyserState
  /** Where to land — used by "Worth another look" to jump straight to a move. */
  initialCursor?: number
  onBack: () => void
}) {
  // Derived once per game: replay is read-only, so nothing here ever changes
  // while the screen is open.
  const positions = useMemo(() => replayPositions(game.sanHistory), [game])
  const moves = useMemo(() => buildReplayMoves(game), [game])
  const rows = useMemo(() => replayRows(moves), [moves])

  // A game that couldn't be fully replayed has fewer positions than moves; the
  // cursor follows the positions, so we never index past what we rebuilt.
  const lastCursor = positions.length - 1
  const [cursor, setCursor] = useState(() => clampCursor(initialCursor, lastCursor))
  const go = useCallback((next: number) => setCursor(clampCursor(next, lastCursor)), [lastCursor])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') setCursor((c) => clampCursor(c - 1, lastCursor))
      else if (e.key === 'ArrowRight') setCursor((c) => clampCursor(c + 1, lastCursor))
      else if (e.key === 'Home') setCursor(0)
      else if (e.key === 'End') setCursor(lastCursor)
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [lastCursor])

  const fen = positions[cursor] ?? positions[0]!
  const coach = coachAtCursor(game, cursor)
  const truncated = positions.length <= game.sanHistory.length

  // Stored data answers "how did I do"; the engine answers "what should I have
  // played here", which the coach only ever recorded for your own moves. It runs
  // on request, so stepping through a game still costs nothing.
  const analysis = usePositionAnalysis(engine, fen)

  // The stored eval is free and instant; a fresh analysis supersedes it for the
  // position it was actually computed for.
  const storedPct = cursor > 0 ? game.evalByPly?.[cursor - 1]?.whitePct : undefined
  const whitePct = analysis.evaluation?.whitePct ?? storedPct ?? null

  return (
    <section className="play">
      <BoardPanel
        id="replay-board"
        fen={fen}
        orientedFor={game.yourColor}
        whitePct={whitePct}
        arePiecesDraggable={false}
      >
        <button className="btn ghost" type="button" onClick={() => go(0)} aria-label="First move">
          ⏮
        </button>
        <button
          className="btn ghost"
          type="button"
          onClick={() => go(cursor - 1)}
          disabled={cursor === 0}
          aria-label="Previous move"
        >
          ‹
        </button>
        <span className="replay-pos mono">
          {cursor} / {lastCursor}
        </span>
        <button
          className="btn ghost"
          type="button"
          onClick={() => go(cursor + 1)}
          disabled={cursor === lastCursor}
          aria-label="Next move"
        >
          ›
        </button>
        <button className="btn ghost" type="button" onClick={() => go(lastCursor)} aria-label="Last move">
          ⏭
        </button>
      </BoardPanel>

      <div className="side-col">
        <div className="game-head">
          <h2>
            You as {sideName(game.yourColor)} vs Maia {game.level}
          </h2>
          <p className="playing-as">
            {outcomeText(game)} · {accuracyText(game)} accuracy · {game.takebacks} take-back
            {game.takebacks === 1 ? '' : 's'}
          </p>
          <button className="btn ghost back" type="button" onClick={onBack}>
            ← Back to your games
          </button>
        </div>

        {truncated && (
          <p className="banner error">
            Only {positions.length - 1} of {game.sanHistory.length} moves could be replayed from
            this record.
          </p>
        )}

        <div className="replay-coach" role="status">
          {coach ? (
            <>
              <span className={`tier-badge ${TIER_CLASS[coach.tier]}`}>{TIER_TEXT[coach.tier]}</span>
              <span className="mono">
                {' '}
                you played {coach.san}
                {coach.swing >= 1 && ` · −${coach.swing.toFixed(1)}%`}
              </span>
              {coach.bestMoveSan && coach.bestMoveSan !== coach.san && (
                <span className="mono"> · best {coach.bestMoveSan}</span>
              )}
            </>
          ) : (
            <span className="replay-coach-empty">
              {cursor === 0 ? 'Start of the game.' : 'Maia’s move.'}
            </span>
          )}
        </div>

        <div className="replay-analysis">
          {analysis.available ? (
            <>
              <button
                className="btn ghost"
                type="button"
                onClick={analysis.analyse}
                disabled={analysis.analysing}
              >
                {analysis.analysing ? 'Analysing…' : 'Analyse this position'}
              </button>
              {analysis.evaluation && (
                <span className="score-chip mono">{analysis.evaluation.label}</span>
              )}
            </>
          ) : (
            <span className="replay-coach-empty">Engine loading…</span>
          )}
          <LinesPanel fen={fen} lines={analysis.lines} />
        </div>

        <ol className="movelist" aria-label="Moves">
          {rows.map((r) => (
            <li key={r.n}>
              <span className="mv-no mono">{r.n}.</span>
              <ReplayCell move={r.w} cursor={cursor} onJump={go} />
              <ReplayCell move={r.b} cursor={cursor} onJump={go} />
            </li>
          ))}
        </ol>
      </div>
    </section>
  )
}

function ReplayCell({
  move,
  cursor,
  onJump,
}: {
  move?: ReplayMove
  cursor: number
  onJump: (c: number) => void
}) {
  if (!move) return <span />
  // Cursor N shows the position after N moves, so move `ply` is selected at N = ply + 1.
  const selected = cursor === move.ply + 1
  return (
    <button
      type="button"
      className={`mv-cell mono mv-jump ${selected ? 'selected' : ''}`}
      aria-current={selected ? 'true' : undefined}
      onClick={() => onJump(move.ply + 1)}
    >
      {move.tier && <span className={`tier-dot ${TIER_CLASS[move.tier]}`} title={TIER_TEXT[move.tier]} />}
      {move.san}
      {move.score && <span className="mv-score">{move.score}</span>}
    </button>
  )
}
