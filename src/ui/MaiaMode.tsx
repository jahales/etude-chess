import { useMemo, useState } from 'react'
import type { Color, Tier } from '../domain/types'
import { pvToSan, whiteScoreLabel } from '../domain/notation'
import { byPhase, type Phase } from '../domain/accuracy'
import { SHIPPED_LEVELS, type MaiaLevel } from '../engine/maia/opponent'
import {
  currentEval,
  canTakeBack,
  displayFen,
  gameAccuracy,
  yourMoveCount,
  takebackRate,
  openingName,
  sideToMove,
  type LastCoach,
  type PlayResult,
  type PlayState,
} from '../app/playMachine'
import type { usePlaySession } from '../app/usePlaySession'
import { BoardPanel } from './BoardPanel'
import { moveLabel, sideName, TIER_CLASS, TIER_TEXT } from './format'

const LEVEL_BLURB: Record<number, string> = {
  1100: 'beginner',
  1300: 'improver',
  1500: 'club player',
  1700: 'strong club',
  1900: 'expert',
}

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
    // The screen shell supplies the heading, so this panel starts at the pitch.
    <div className="maia-setup">
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
          <span className="maia-level-blurb">
            {LEVEL_BLURB[level] ?? 'human-like'} · Lichess-style rating, so pick above your
            OTB number
          </span>
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

const PHASES: Phase[] = ['opening', 'middlegame', 'endgame']

/** Move number label ("12." / "12…") for your move at `ply`, given your colour. */
function plyLabel(ply: number, yourColor: Color): string {
  return moveLabel(Math.floor(ply / 2) + 1, yourColor)
}

/** Post-game review: final-line accuracy, take-back count, by-phase, and worst moments. */
function Review({
  state,
  onReviewPly,
}: {
  state: PlayState
  /** Open this game in replay at the given ply. */
  onReviewPly: (gameId: string, ply: number) => void
}) {
  if (state.coachLog.length === 0) {
    return (
      <div className="review">
        <p className="acc-note">No moves to review.</p>
      </div>
    )
  }
  const acc = gameAccuracy(state).toFixed(2)
  // The coach log only holds moves that finished grading before the game ended,
  // so on a resigned game this figure can rest on a fraction of your moves — and
  // sit directly above a mistake it doesn't account for (#74). Say what it covers.
  const covered = state.coachLog.length
  const yourMoves = yourMoveCount(state)
  const phases = byPhase(state.coachLog)
  const rate = Math.round(takebackRate(state) * 100)
  const worst = [...state.coachLog]
    .filter((e) => e.swing >= 5)
    .sort((a, b) => b.swing - a.swing)
    .slice(0, 3)
  return (
    <div className="review">
      <div className="review-stats">
        <div className="accuracy-big">
          <span className="acc-num mono">{acc}%</span>
          <span className="acc-label">
            accuracy
            {covered < yourMoves && (
              <span className="coverage-note">
                over {covered} of {yourMoves} moves
              </span>
            )}
          </span>
        </div>
        <div className="takeback-stat">
          <span className="tb-num mono">{state.takebacks}</span>
          <span className="acc-label">
            take-back{state.takebacks === 1 ? '' : 's'}
            {state.takebacks > 0 && ` · ${rate}% of moves`}
          </span>
        </div>
      </div>
      <p className="acc-note">
        Accuracy is the game as played; take-backs are tracked separately.
        {covered < yourMoves && ' Analyse the game from Your games to score every move.'}
      </p>
      <div className="phase-row">
        {PHASES.filter((p) => phases[p].moves > 0).map((p) => (
          <div key={p} className="phase-stat">
            <div className="phase-acc mono">{Math.round(phases[p].accuracy)}%</div>
            <div className="phase-name">
              {p} · {phases[p].moves}
            </div>
          </div>
        ))}
      </div>
      {worst.length > 0 && (
        <div className="worst-moments">
          <h3>Worth another look</h3>
          <ul>
            {worst.map((e) => (
              <li key={e.ply}>
                {/* The whole entry navigates — a flagged mistake with no way back
                    into the position is where the old loop dropped the thread (#39). */}
                <button
                  type="button"
                  className="worst-jump"
                  onClick={() => onReviewPly(state.gameId, e.ply)}
                >
                  <span className="mono">{plyLabel(e.ply, state.yourColor)}</span> you played{' '}
                  <b className="mono">{e.san}</b>
                  <span className="lost"> −{Math.round(e.swing)}%</span>
                  {e.bestMoveSan && e.bestMoveSan !== e.san && (
                    <>
                      {' '}
                      · best <b className="mono">{e.bestMoveSan}</b>
                    </>
                  )}
                  <span className="worst-cta"> · replay →</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

/** Engine lines for the position you moved from, scored from White's view (consistent
 * with the eval bar + move list). Your own move's score is shown first, always. */
function ShowMe({
  fen,
  yourColor,
  yourMoveSan,
  myMoveScore,
  bestMoveSan,
  lines,
}: {
  fen: string
  yourColor: Color
  yourMoveSan: string
  myMoveScore: string | undefined
  bestMoveSan: string | null
  lines: PlayState['lines']
}) {
  return (
    <div className="lines-reveal">
      <div className="line your-line">
        <span className="line-score mono">{myMoveScore ?? '…'}</span>
        <span className="line-pv mono">your {yourMoveSan}</span>
      </div>
      {lines.length > 0 ? (
        lines.map((l) => (
          <div className="line" key={l.multipv}>
            <span className="line-score mono">{whiteScoreLabel(l.score, yourColor)}</span>
            <span className="line-pv mono">{pvToSan(fen, l.pv).join(' ')}</span>
          </div>
        ))
      ) : bestMoveSan ? (
        <div className="line">
          <span className="line-score mono">·</span>
          <span className="line-pv mono">engine: {bestMoveSan}</span>
        </div>
      ) : (
        <div className="line">
          <span className="line-pv mono">analysing…</span>
        </div>
      )}
    </div>
  )
}

/** Ambient feedback on your last move: verdict + cost, with the answer behind "Show me". */
function CoachPanel({
  coach,
  yourColor,
  myMoveScore,
  showMe,
  lines,
  onReveal,
  onHide,
}: {
  coach: LastCoach
  yourColor: Color
  myMoveScore: string | undefined
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
          {myMoveScore && <> · {myMoveScore}</>}
          {v.tier !== 'A' && <> · −{Math.round(v.swing)}%</>}
        </span>
      </div>
      {v.detail && <p className="coach-why">{v.detail}</p>}
      {!showMe ? (
        <button className="btn ghost show-me" type="button" onClick={onReveal}>
          Show me the best move →
        </button>
      ) : (
        <>
          <ShowMe
            fen={coach.fenBefore}
            yourColor={yourColor}
            yourMoveSan={coach.yourMoveSan}
            myMoveScore={myMoveScore}
            bestMoveSan={v.bestMoveSan}
            lines={lines}
          />
          <button className="btn ghost" type="button" onClick={onHide}>
            Hide
          </button>
        </>
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

export function MaiaPlay({
  play,
  onNewGame,
  onHome,
  onReviewPly,
}: {
  play: PlaySession
  onNewGame: () => void
  onHome: () => void
  onReviewPly: (gameId: string, ply: number) => void
}) {
  const { state, maiaReady, maiaError, showEval } = play
  const fen = displayFen(state)
  const yourColor = state.yourColor
  const yourTurn = state.status === 'yourTurn'
  const over = state.status === 'over'

  const squareStyles =
    state.selected && yourTurn ? { [state.selected]: { background: 'rgba(53, 96, 73, 0.35)' } } : undefined
  const opening = useMemo(() => openingName(state), [state])
  const rows = useMemo(() => buildRows(state, showEval), [state, showEval])
  const score = currentEval(state)

  return (
    <section className="play">
      <BoardPanel
        id="maia-board"
        fen={fen}
        orientedFor={yourColor}
        whitePct={score?.whitePct ?? null}
        showEvalBar={showEval}
        arePiecesDraggable={yourTurn && maiaReady}
        onPieceDrop={(from, to) => play.tryMove(from, to)}
        onSquareClick={play.selectSquare}
        customSquareStyles={squareStyles}
      >
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
      </BoardPanel>

      <div className="side-col">
        <div className="game-head">
          <h2>Maia {state.level}</h2>
          {opening && <p className="opening mono">{opening}</p>}
          <p className="playing-as">
            You are <b>{sideName(yourColor)}</b>.
            {state.coachLog.length > 0 && (
              <span className="acc-inline mono" title="Accuracy of your moves so far (the game as played)">
                {' '}
                · Accuracy {gameAccuracy(state).toFixed(2)}%
                {state.takebacks > 0 && ` · ${state.takebacks} take-back${state.takebacks === 1 ? '' : 's'}`}
              </span>
            )}
          </p>
        </div>

        {maiaError ? (
          <div className="maia-status">
            <span className="banner error">Maia failed to load: {maiaError}</span>
          </div>
        ) : over && state.result ? (
          <>
            <div className="maia-status over" role="status">
              <span className="maia-result">{describeResult(state.result)}</span>
            </div>
            <Review state={state} onReviewPly={onReviewPly} />
          </>
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
                yourColor={yourColor}
                // Gated on showEval like every other score: the coach effect writes
                // this entry regardless of the toggle, so without the guard turning
                // the evaluation off still printed it here.
                myMoveScore={showEval ? state.evalByPly[state.lastCoach.ply]?.label : undefined}
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
