import { useMemo, useState, type ComponentProps } from 'react'
import { Chessboard } from 'react-chessboard'
import { GAMES, type PackGame } from '../content/games'
import type { QuizItem } from '../domain/harness'
import { materialBalance } from '../domain/material'
import { explain, factBundleToText, type FactBundle } from '../domain/factBundle'
import { summarize, type Attempt } from '../domain/session'
import { useGuessSession } from '../app/useGuessSession'
import {
  STRENGTH_PRESETS,
  MULTIPV_OPTIONS,
  presetIdForNodes,
  type AnalysisSettings,
} from '../app/settings'
import {
  currentItem,
  displayFen as selectDisplayFen,
  isLast,
  isPromotion,
  type SessionState,
} from '../app/sessionMachine'
import { useBoardWidth } from './useBoardWidth'
import { EvalBar, MaterialStrip, LinesPanel } from './Analysis'
import {
  TIER_TEXT,
  TIER_CLASS,
  ARROW_MASTER,
  ARROW_ENGINE,
  ARROW_USER,
  uciSquares,
  sideName,
  moveLabel,
} from './format'

type Arrows = NonNullable<ComponentProps<typeof Chessboard>['customArrows']>

const PROMO_GLYPH: Record<string, string> = { q: '♛', r: '♜', b: '♝', n: '♞' }

export function App() {
  const s = useGuessSession()
  const { state } = s
  const [showSettings, setShowSettings] = useState(false)

  return (
    <div className="app">
      <header className="topbar">
        <button className="brand" type="button" onClick={s.goHome} aria-label="Home">
          <b>étude</b>
          <span className="dot">·</span>
          <b>chess</b>
        </button>
        <div className="top-right">
          <button
            className="settings-btn"
            type="button"
            onClick={() => setShowSettings((v) => !v)}
            aria-label="Analysis settings"
            aria-expanded={showSettings}
          >
            ⚙
          </button>
          <span className={`engine-pill ${s.engineReady ? 'on' : ''}`}>
            {s.engineError ? 'engine error' : s.engineReady ? 'engine ready' : 'engine loading…'}
          </span>
        </div>
      </header>

      {showSettings && <SettingsPanel settings={s.settings} onChange={s.setSettings} />}

      <main className="main">
        {state.screen === 'home' && (
          <Home onPick={s.startGame} engineError={s.engineError} engineReady={s.engineReady} />
        )}
        {state.screen === 'play' && state.session && (
          <Play
            state={state}
            engineReady={s.engineReady}
            onDropMove={s.tryMove}
            onClickSquare={s.clickSquare}
            onTakeBack={s.takeBack}
            onSetPromotion={s.setPromotion}
            onReasonChange={s.setReason}
            onCommit={s.commit}
            onNext={s.next}
          />
        )}
        {state.screen === 'summary' && state.session && (
          <Summary
            attempts={state.attempts}
            game={state.session.game}
            onReplay={() => s.startGame(state.session!.game)}
            onHome={s.goHome}
          />
        )}
      </main>
    </div>
  )
}

// ---------- Settings ----------

function SettingsPanel({
  settings,
  onChange,
}: {
  settings: AnalysisSettings
  onChange: (s: AnalysisSettings) => void
}) {
  return (
    <div className="settings-panel">
      <label>
        Engine strength
        <select
          value={presetIdForNodes(settings.nodes)}
          onChange={(e) => {
            const preset = STRENGTH_PRESETS.find((p) => p.id === e.target.value)
            if (preset) onChange({ ...settings, nodes: preset.nodes })
          }}
        >
          {STRENGTH_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Lines shown
        <select
          value={settings.multipv}
          onChange={(e) => onChange({ ...settings, multipv: Number(e.target.value) })}
        >
          {MULTIPV_OPTIONS.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </label>
      <span className="settings-hint">Stronger = slower, more accurate grading.</span>
    </div>
  )
}

// ---------- Home ----------

function Home({
  onPick,
  engineError,
  engineReady,
}: {
  onPick: (g: PackGame) => void
  engineError: string | null
  engineReady: boolean
}) {
  return (
    <section className="home">
      <h1 className="title">Study a master&apos;s game — by playing it.</h1>
      <p className="lede">
        Take the winner&apos;s side of a classic. At each move, commit your choice and a one-line
        reason <em>before</em> the answer appears — then see how the engine grades it. A move as
        good as the master&apos;s earns full marks.
      </p>
      {engineError && <p className="banner error">{engineError}</p>}
      {!engineReady && !engineError && (
        <p className="banner">Loading the chess engine… you can pick a game now.</p>
      )}
      <ul className="game-list">
        {GAMES.map((g) => (
          <li key={g.id} className="game-card">
            <div>
              <h2>{g.title}</h2>
              <p>{g.blurb}</p>
            </div>
            <button className="btn primary" type="button" onClick={() => onPick(g)}>
              Study this game
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}

// ---------- Play ----------

function Play({
  state,
  engineReady,
  onDropMove,
  onClickSquare,
  onTakeBack,
  onSetPromotion,
  onReasonChange,
  onCommit,
  onNext,
}: {
  state: SessionState
  engineReady: boolean
  onDropMove: (from: string, to: string) => boolean
  onClickSquare: (square: string) => void
  onTakeBack: () => void
  onSetPromotion: (piece: string) => void
  onReasonChange: (r: string) => void
  onCommit: () => void
  onNext: () => void
}) {
  const { ref, width } = useBoardWidth()
  const [flipped, setFlipped] = useState(false)
  const session = state.session!
  const { phase, pending, reason, result, lines, positionWhitePct, selected, index } = state
  const item = currentItem(state)!
  const boardFen = selectDisplayFen(state)
  const whiteBottom = session.heroColor === 'w' ? !flipped : flipped

  const squareStyles = selected
    ? { [selected]: { background: 'rgba(53, 96, 73, 0.35)' } }
    : undefined

  const arrows: Arrows = useMemo(() => {
    if (phase !== 'reveal') return [] as unknown as Arrows
    const out: string[][] = []
    const m = uciSquares(item.masterMoveUci)
    out.push([m.from, m.to, ARROW_MASTER])
    if (result?.bestMoveUci && result.bestMoveUci !== item.masterMoveUci) {
      const b = uciSquares(result.bestMoveUci)
      out.push([b.from, b.to, ARROW_ENGINE])
    }
    if (pending && pending.san !== item.masterMoveSan) {
      out.push([pending.from, pending.to, ARROW_USER])
    }
    return out as unknown as Arrows
  }, [phase, result, item, pending])

  return (
    <section className="play">
      <div className="board-col">
        <div className="board-row">
          <EvalBar whitePct={positionWhitePct} whiteBottom={whiteBottom} />
          <div className="board-frame" ref={ref}>
            <Chessboard
              id="board"
              position={boardFen}
              boardWidth={width}
              boardOrientation={whiteBottom ? 'white' : 'black'}
              arePiecesDraggable={phase === 'guess' && !pending && engineReady}
              onPieceDrop={(from, to) => onDropMove(from, to)}
              onSquareClick={onClickSquare}
              customArrows={arrows}
              customSquareStyles={squareStyles}
              customBoardStyle={{ borderRadius: '6px' }}
            />
          </div>
        </div>
        <MaterialStrip material={materialBalance(boardFen)} />
        <div className="turn-line">
          <span className="mono">{moveLabel(item.moveNumber, item.sideToMove)}</span>{' '}
          {sideName(item.sideToMove)} to move · position {index + 1} of {session.quiz.length}
          <button
            className="btn ghost flip"
            type="button"
            onClick={() => setFlipped((f) => !f)}
            aria-label="Flip board"
            title="Flip board"
          >
            ⇅ Flip
          </button>
        </div>
      </div>

      <div className="side-col">
        <div className="game-head">
          <h2>{session.game.title}</h2>
          {session.opening && <p className="opening mono">{session.opening}</p>}
          <p className="playing-as">
            You are playing <b>{sideName(session.heroColor)}</b>.
          </p>
        </div>

        {phase !== 'reveal' && (
          <div className="prompt">
            <p className="ask">What&apos;s your move — and why?</p>
            <div className="move-slot">
              {pending ? (
                <span className="picked mono">{pending.san}</span>
              ) : (
                <span className="picked empty">Click or drag a piece to choose your move…</span>
              )}
              {pending && phase === 'guess' && (
                <button className="btn ghost" type="button" onClick={onTakeBack}>
                  Take back
                </button>
              )}
            </div>
            {isPromotion(pending) && (
              <div className="promotion-picker">
                <span className="promo-label">Promote to:</span>
                {(['q', 'r', 'b', 'n'] as const).map((p) => (
                  <button
                    key={p}
                    type="button"
                    className={`btn ghost promo ${pending!.promotion === p ? 'active' : ''}`}
                    onClick={() => onSetPromotion(p)}
                    aria-label={`Promote to ${p}`}
                  >
                    {PROMO_GLYPH[p]}
                  </button>
                ))}
              </div>
            )}
            <textarea
              className="reason"
              placeholder="One line: what does your move do? (e.g. develops and eyes f7)"
              value={reason}
              onChange={(e) => onReasonChange(e.target.value)}
              rows={3}
              disabled={phase === 'grading'}
            />
            <button
              className="btn primary commit"
              type="button"
              disabled={!pending || phase === 'grading' || !engineReady}
              onClick={onCommit}
            >
              {phase === 'grading' ? 'Analyzing…' : 'Commit move'}
            </button>
          </div>
        )}

        {phase === 'reveal' && result && (
          <>
            <Reveal fb={result.fb} item={item} onNext={onNext} last={isLast(state)} />
            <LinesPanel fen={item.fen} lines={lines} />
          </>
        )}
      </div>
    </section>
  )
}

function Reveal({
  fb,
  item,
  onNext,
  last,
}: {
  fb: FactBundle
  item: QuizItem
  onNext: () => void
  last: boolean
}) {
  const [copied, setCopied] = useState(false)
  const copyFacts = async () => {
    try {
      await navigator.clipboard.writeText(factBundleToText(fb))
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      setCopied(false)
    }
  }
  return (
    <div className="reveal">
      <div className={`verdict ${TIER_CLASS[fb.grade.tier]}`}>
        <span className="tier-badge">{TIER_TEXT[fb.grade.tier]}</span>
        <span className="your-move mono">
          you played {fb.userMoveSan} · master {item.masterMoveSan}
        </span>
      </div>
      <p className="why">{explain(fb)}</p>
      <ul className="arrow-key">
        <li>
          <span className="swatch master" /> master&apos;s move
        </li>
        {fb.bestMoveSan && fb.bestMoveSan !== item.masterMoveSan && (
          <li>
            <span className="swatch engine" /> engine&apos;s pick ({fb.bestMoveSan})
          </li>
        )}
        {!fb.matchedMaster && (
          <li>
            <span className="swatch user" /> your move
          </li>
        )}
      </ul>
      <div className="reveal-actions">
        <button className="btn ghost" type="button" onClick={copyFacts}>
          {copied ? 'Copied ✓' : 'Copy facts for an LLM'}
        </button>
        <button className="btn primary" type="button" onClick={onNext}>
          {last ? 'See summary' : 'Next position →'}
        </button>
      </div>
    </div>
  )
}

// ---------- Summary ----------

function Summary({
  attempts,
  game,
  onReplay,
  onHome,
}: {
  attempts: Attempt[]
  game: PackGame
  onReplay: () => void
  onHome: () => void
}) {
  const s = summarize(attempts)
  return (
    <section className="summary">
      <h1>Session complete</h1>
      <p className="lede">
        {game.title} · {s.total} decisions
      </p>
      <div className="stat-row">
        <Stat label="Well played" value={`${s.tierCounts.A}`} cls="tier-a" />
        <Stat label="Inaccuracies" value={`${s.tierCounts.B}`} cls="tier-b" />
        <Stat label="Mistakes" value={`${s.tierCounts.C}`} cls="tier-c" />
        <Stat label="Matched best" value={`${Math.round(s.aRate * 100)}%`} />
        <Stat label="Avg. lost" value={`${s.averageSwing.toFixed(1)}%`} />
      </div>

      {s.biggestMisses.length > 0 && (
        <div className="misses">
          <h2>Worth a second look</h2>
          <ul>
            {s.biggestMisses.map((m) => (
              <li key={m.itemIndex}>
                <span className="mono">{moveLabel(m.moveNumber, m.sideToMove)}</span> you played{' '}
                <b className="mono">{m.userMoveSan}</b>, the master played{' '}
                <b className="mono">{m.masterMoveSan}</b>{' '}
                <span className="lost">(−{Math.round(m.swing)}%)</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="summary-actions">
        <button className="btn ghost" type="button" onClick={onHome}>
          Study another game
        </button>
        <button className="btn primary" type="button" onClick={onReplay}>
          Replay this game
        </button>
      </div>
    </section>
  )
}

function Stat({ label, value, cls }: { label: string; value: string; cls?: string }) {
  return (
    <div className={`stat ${cls ?? ''}`}>
      <div className="stat-value mono">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  )
}
