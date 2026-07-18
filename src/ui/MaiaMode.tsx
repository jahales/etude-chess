import { useMemo, useState } from 'react'
import { Chessboard } from 'react-chessboard'
import { materialBalance } from '../domain/material'
import type { Color, Tier } from '../domain/types'
import { SHIPPED_LEVELS, type MaiaLevel } from '../engine/maia/opponent'
import {
  currentEval,
  canTakeBack,
  displayFen,
  openingName,
  sideToMove,
  type LastCoach,
  type PlayResult,
  type PlayState,
} from '../app/playMachine'
import type { usePlaySession } from '../app/usePlaySession'
import { useBoardWidth } from './useBoardWidth'
import { EvalBar, MaterialStrip, LinesPanel } from './Analysis'
import { sideName, TIER_CLASS, TIER_TEXT } from './format'

const LEVEL_BLURB: Record<number, string> = { 1100: 'beginner', 1300: 'improver', 1500: 'club player' }

type PlaySession = ReturnType<typeof usePlaySession>

// ---------- Home setup panel ----------

export function MaiaSetup({
  onPlay,
  defaultLevel,
}: {
  onPlay: (opts: { yourColor: Color; level: MaiaLevel }) => void
  defaultLevel: MaiaLevel
}) {
  const [color, setColor] = useState<'w' | 'b' | 'random'>('w')
  const [level, setLevel] = useState<MaiaLevel>(defaultLevel)

  const start = () => {
    const yourColor: Color = color === 'random' ? (Math.random() < 0.5 ? 'w' : 'b') : color
    onPlay({ yourColor, level })
  }

  return (
    <div className="maia-setup">
      <h2>Play a human-like opponent — with a coach on every move</h2>
      <p className="maia-setup-lede">
        Maia plays like a real player at its rating. After each move the coach grades it and
        shows why — take it back and rethink, or play on. Ask &ldquo;show me&rdquo; when you want the
        engine&apos;s answer.
      </p>
      <div className="maia-controls">
        <fieldset className="maia-field">
          <legend>You play</legend>
          <div className="seg">
            {(['w', 'b', 'random'] as const).map((c) => (
              <button key={c} type="button" className={`seg-btn ${color === c ? 'active' : ''}`} onClick={() => setColor(c)}>
                {c === 'w' ? 'White' : c === 'b' ? 'Black' : 'Random'}
              </button>
            ))}
          </div>
        </fieldset>
        <fieldset className="maia-field">
          <legend>Maia level</legend>
          <div className="seg">
            {SHIPPED_LEVELS.map((l) => (
              <button key={l} type="button" className={`seg-btn ${level === l ? 'active' : ''}`} onClick={() => setLevel(l)} title={LEVEL_BLURB[l]}>
                {l}
              </button>
            ))}
          </div>
          <span className="maia-level-blurb">{LEVEL_BLURB[level] ?? 'human-like'}</span>
        </fieldset>
      </div>
      <button className="btn primary" type="button" onClick={start}>
        Play vs Maia {level}
      </button>
    </div>
  )
}

// ---------- Game screen ----------

function describeResult(result: PlayResult): string {
  const REASON: Record<string, string> = {
    checkmate: 'by checkmate',
    stalemate: 'by stalemate',
    insufficient: 'by insufficient material',
    threefold: 'by repetition',
    'fifty-move': 'by the fifty-move rule',
    resignation: 'by resignation',
    agreement: 'by agreement',
  }
  const tail = REASON[result.reason] ?? ''
  if (result.outcome === 'draw') return `Draw ${tail}`.trim()
  if (result.outcome === 'you') return `You won ${tail}`.trim()
  if (result.reason === 'resignation') return 'You resigned — Maia wins'
  return `Maia won ${tail}`.trim()
}

/** Ambient feedback on your last move: verdict + cost, with the answer behind "Show me". */
function CoachPanel({
  coach,
  showMe,
  lines,
  onReveal,
  onHide,
}: {
  coach: LastCoach
  showMe: boolean
  lines: PlayState['lines']
  onReveal: () => void
  onHide: () => void
}) {
  const v = coach.verdict
  return (
    <div className="coach-card">
      <div className={`coach-verdict ${TIER_CLASS[v.tier]}`}>
        <span className="tier-badge">{v.headline}</span>
        <span className="mono">
          your {coach.yourMoveSan}
          {v.tier !== 'A' && <> · −{Math.round(v.swing)}%</>}
        </span>
      </div>
      {v.detail && <p className="coach-why">{v.detail}</p>}
      {!showMe ? (
        <button className="btn ghost show-me" type="button" onClick={onReveal}>
          Show me the best move →
        </button>
      ) : (
        <div className="lines-reveal">
          {v.bestMoveSan && (
            <p className="best-move">
              Engine&apos;s pick: <b className="mono">{v.bestMoveSan}</b>
            </p>
          )}
          <LinesPanel fen={coach.fenBefore} lines={lines} />
          <button className="btn ghost" type="button" onClick={onHide}>
            Hide
          </button>
        </div>
      )}
    </div>
  )
}

interface Cell {
  san: string
  tier?: Tier
  score?: string
}
interface MoveRow {
  n: number
  w?: Cell
  b?: Cell
}

function buildRows(state: PlayState, showEval: boolean): MoveRow[] {
  const { sanHistory, coachLog, evalByPly } = state
  const tierAt = new Map(coachLog.map((e) => [e.ply, e.tier]))
  const cell = (i: number): Cell | undefined =>
    sanHistory[i] === undefined
      ? undefined
      : { san: sanHistory[i]!, tier: tierAt.get(i), score: showEval ? evalByPly[i]?.label : undefined }
  const rows: MoveRow[] = []
  for (let i = 0; i < sanHistory.length; i += 2) rows.push({ n: i / 2 + 1, w: cell(i), b: cell(i + 1) })
  return rows
}

function MoveCell({ move }: { move?: Cell }) {
  if (!move) return <span />
  return (
    <span className="mv-cell mono">
      {move.tier && <span className={`tier-dot ${TIER_CLASS[move.tier]}`} title={TIER_TEXT[move.tier]} />}
      {move.san}
      {move.score && <span className="mv-score">{move.score}</span>}
    </span>
  )
}

export function MaiaPlay({ play, onNewGame, onHome }: { play: PlaySession; onNewGame: () => void; onHome: () => void }) {
  const { ref, width } = useBoardWidth()
  const [flipped, setFlipped] = useState(false)
  const { state, maiaReady, maiaError, showEval } = play
  const fen = displayFen(state)
  const yourColor = state.yourColor
  const whiteBottom = yourColor === 'w' ? !flipped : flipped
  const yourTurn = state.status === 'yourTurn'
  const over = state.status === 'over'

  const squareStyles =
    state.selected && yourTurn ? { [state.selected]: { background: 'rgba(53, 96, 73, 0.35)' } } : undefined
  const opening = useMemo(() => openingName(state), [state])
  const rows = useMemo(() => buildRows(state, showEval), [state, showEval])
  const score = currentEval(state)

  return (
    <section className="play">
      <div className="board-col">
        <div className="board-row">
          {showEval && <EvalBar whitePct={score?.whitePct ?? null} whiteBottom={whiteBottom} />}
          <div className="board-frame" ref={ref}>
            <Chessboard
              id="maia-board"
              position={fen}
              boardWidth={width}
              boardOrientation={whiteBottom ? 'white' : 'black'}
              arePiecesDraggable={yourTurn && maiaReady}
              onPieceDrop={(from, to) => play.tryMove(from, to)}
              onSquareClick={play.selectSquare}
              customSquareStyles={squareStyles}
              customBoardStyle={{ borderRadius: '6px' }}
            />
          </div>
        </div>
        <MaterialStrip material={materialBalance(fen)} />
        <div className="turn-line">
          <span className="mono">{sideName(sideToMove(state))} to move</span>
          {showEval && score && <span className="score-chip mono">{score.label}</span>}
          <button
            className={`btn ghost eval-toggle ${showEval ? 'on' : ''}`}
            type="button"
            onClick={() => play.setShowEval((v) => !v)}
            title="Show or hide the engine evaluation"
          >
            {showEval ? 'Eval: on' : 'Eval: off'}
          </button>
          <button className="btn ghost flip" type="button" onClick={() => setFlipped((f) => !f)} aria-label="Flip board" title="Flip board">
            ⇅ Flip
          </button>
        </div>
      </div>

      <div className="side-col">
        <div className="game-head">
          <h2>Maia {state.level}</h2>
          {opening && <p className="opening mono">{opening}</p>}
          <p className="playing-as">
            You are <b>{sideName(yourColor)}</b>.
          </p>
        </div>

        {maiaError ? (
          <div className="maia-status">
            <span className="banner error">Maia failed to load: {maiaError}</span>
          </div>
        ) : over && state.result ? (
          <div className="maia-status over" role="status">
            <span className="maia-result">{describeResult(state.result)}</span>
          </div>
        ) : !maiaReady ? (
          <div className="maia-status" role="status">
            Loading Maia {state.level}…
          </div>
        ) : (
          <>
            <div className="maia-status" role="status">
              {state.status === 'thinking' ? (
                <span className="thinking">Maia is thinking…</span>
              ) : (
                <span className="your-turn">Your move.</span>
              )}
            </div>
            {state.lastCoach && (
              <CoachPanel
                coach={state.lastCoach}
                showMe={state.showMe}
                lines={state.lines}
                onReveal={play.revealLines}
                onHide={play.hideLines}
              />
            )}
          </>
        )}

        <ol className="movelist" aria-label="Moves">
          {rows.map((r) => (
            <li key={r.n}>
              <span className="mv-no mono">{r.n}.</span>
              <MoveCell move={r.w} />
              <MoveCell move={r.b} />
            </li>
          ))}
        </ol>

        <div className="maia-actions">
          {over ? (
            <>
              <button className="btn ghost" type="button" onClick={onHome}>
                Home
              </button>
              <button className="btn primary" type="button" onClick={onNewGame}>
                New game
              </button>
            </>
          ) : (
            <>
              <button className="btn ghost" type="button" onClick={play.takeBack} disabled={!canTakeBack(state)}>
                ← Take back
              </button>
              <button className="btn ghost" type="button" onClick={play.drawGame} disabled={!maiaReady}>
                Draw
              </button>
              <button className="btn ghost" type="button" onClick={play.resign} disabled={!maiaReady}>
                Resign
              </button>
            </>
          )}
        </div>
      </div>
    </section>
  )
}
