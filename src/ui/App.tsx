import { useCallback, useEffect, useMemo, useState, type ComponentProps } from 'react'
import { Chess, type Square as ChessSquare } from 'chess.js'
import { Chessboard } from 'react-chessboard'
import { GAMES, type PackGame } from '../content/games'
import { parseGame, heroColorFromResult, buildQuiz, type QuizItem } from '../domain/harness'
import { gradeAfterMove } from '../engine/grading'
import { buildFactBundle, explain, factBundleToText, type FactBundle } from '../domain/factBundle'
import { summarize, type Attempt } from '../domain/session'
import { materialBalance } from '../domain/material'
import { whiteWinPercent } from '../domain/winPercent'
import type { Color } from '../domain/types'
import { DEFAULT_NODES, type AnalysisLine } from '../engine/analyser'
import { useAnalyser } from './useAnalyser'
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
import { saveAttempt } from '../persist/db'

type Arrows = NonNullable<ComponentProps<typeof Chessboard>['customArrows']>
type Screen = 'home' | 'play' | 'summary'
type Phase = 'guess' | 'grading' | 'reveal'

interface Session {
  game: PackGame
  quiz: QuizItem[]
  heroColor: Color
}
interface PendingMove {
  san: string
  from: string
  to: string
  afterFen: string
}
interface Result {
  fb: FactBundle
  bestMoveUci: string | null
}

export function App() {
  const { analyser, ready, error } = useAnalyser()
  const [screen, setScreen] = useState<Screen>('home')
  const [session, setSession] = useState<Session | null>(null)
  const [index, setIndex] = useState(0)
  const [phase, setPhase] = useState<Phase>('guess')
  const [pending, setPending] = useState<PendingMove | null>(null)
  const [reason, setReason] = useState('')
  const [result, setResult] = useState<Result | null>(null)
  const [attempts, setAttempts] = useState<Attempt[]>([])
  const [sessionId, setSessionId] = useState('')
  const [lines, setLines] = useState<AnalysisLine[]>([])
  const [positionWhitePct, setPositionWhitePct] = useState<number | null>(null)

  // Live "who's ahead" eval for the current position (fast, low node budget).
  useEffect(() => {
    if (screen !== 'play' || !session || !analyser || !ready) return
    const item = session.quiz[index]
    if (!item) return
    let cancelled = false
    setPositionWhitePct(null)
    analyser
      .evaluate(item.fen, { nodes: 250_000 })
      .then((ev) => {
        if (!cancelled) setPositionWhitePct(whiteWinPercent(ev.score, item.sideToMove))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [screen, session, index, analyser, ready])

  const startGame = useCallback((game: PackGame) => {
    const parsed = parseGame(game.pgn)
    const hero = heroColorFromResult(parsed.result) ?? 'w'
    const quiz = buildQuiz(parsed.sanMoves, { heroColor: hero, startPly: 8 })
    setSession({ game, quiz, heroColor: hero })
    setIndex(0)
    setPhase('guess')
    setPending(null)
    setReason('')
    setResult(null)
    setLines([])
    setPositionWhitePct(null)
    setAttempts([])
    setSessionId(`s${Date.now()}`)
    setScreen('play')
  }, [])

  const goHome = useCallback(() => {
    setScreen('home')
    setSession(null)
  }, [])

  return (
    <div className="app">
      <header className="topbar">
        <button className="brand" type="button" onClick={goHome} aria-label="Home">
          <b>étude</b>
          <span className="dot">·</span>
          <b>chess</b>
        </button>
        <span className={`engine-pill ${ready ? 'on' : ''}`}>
          {error ? 'engine error' : ready ? 'engine ready' : 'engine loading…'}
        </span>
      </header>

      <main className="main">
        {screen === 'home' && <Home onPick={startGame} engineError={error} engineReady={ready} />}
        {screen === 'play' && session && (
          <Play
            session={session}
            index={index}
            phase={phase}
            pending={pending}
            reason={reason}
            result={result}
            lines={lines}
            positionWhitePct={positionWhitePct}
            engineReady={ready}
            onDropMove={(from, to) => {
              if (phase !== 'guess') return false
              const item = session.quiz[index]!
              const chess = new Chess(item.fen)
              try {
                const mv = chess.move({ from, to, promotion: 'q' })
                setPending({ san: mv.san, from, to, afterFen: chess.fen() })
                return true
              } catch {
                return false
              }
            }}
            onTakeBack={() => setPending(null)}
            onReasonChange={setReason}
            onCommit={async () => {
              const item = session.quiz[index]!
              if (!pending || !analyser) return
              setPhase('grading')
              try {
                // One MultiPV analysis powers both the grade (top line = best) and
                // the reveal's alternatives — no redundant evaluation of the position.
                const ls = await analyser.analyseLines(item.fen, {
                  nodes: DEFAULT_NODES,
                  multipv: 3,
                })
                const first = ls[0]
                const best = first
                  ? { score: first.score, bestMove: first.pv[0] ?? null }
                  : { score: { type: 'cp' as const, value: 0 }, bestMove: null }
                const graded = await gradeAfterMove(analyser, item.fen, pending.san, best, {
                  nodes: DEFAULT_NODES,
                })
                const fb = buildFactBundle({
                  fen: item.fen,
                  userMoveSan: pending.san,
                  bestMoveUci: graded.bestMoveUci,
                  masterMoveSan: item.masterMoveSan,
                  grade: graded.grade,
                })
                const attempt: Attempt = {
                  itemIndex: index,
                  moveNumber: item.moveNumber,
                  sideToMove: item.sideToMove,
                  fen: item.fen,
                  userMoveSan: pending.san,
                  masterMoveSan: item.masterMoveSan,
                  reason,
                  tier: graded.grade.tier,
                  swing: graded.grade.swing,
                }
                setAttempts((a) => [...a, attempt])
                void saveAttempt({
                  ...attempt,
                  gameId: session.game.id,
                  sessionId,
                  createdAt: Date.now(),
                })
                setLines(ls)
                setPositionWhitePct(whiteWinPercent(best.score, item.sideToMove))
                setResult({ fb, bestMoveUci: graded.bestMoveUci })
                setPhase('reveal')
              } catch (e) {
                console.error('grading failed', e)
                setPhase('guess')
              }
            }}
            onNext={() => {
              setPending(null)
              setReason('')
              setResult(null)
              setLines([])
              if (index + 1 >= session.quiz.length) {
                setScreen('summary')
              } else {
                setIndex((i) => i + 1)
                setPhase('guess')
              }
            }}
          />
        )}
        {screen === 'summary' && session && (
          <Summary
            attempts={attempts}
            game={session.game}
            onReplay={() => startGame(session.game)}
            onHome={goHome}
          />
        )}
      </main>
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
  session,
  index,
  phase,
  pending,
  reason,
  result,
  lines,
  positionWhitePct,
  engineReady,
  onDropMove,
  onTakeBack,
  onReasonChange,
  onCommit,
  onNext,
}: {
  session: Session
  index: number
  phase: Phase
  pending: PendingMove | null
  reason: string
  result: Result | null
  lines: AnalysisLine[]
  positionWhitePct: number | null
  engineReady: boolean
  onDropMove: (from: string, to: string) => boolean
  onTakeBack: () => void
  onReasonChange: (r: string) => void
  onCommit: () => void
  onNext: () => void
}) {
  const { ref, width } = useBoardWidth()
  const item = session.quiz[index]!
  const displayFen = phase === 'reveal' ? item.fen : pending?.afterFen ?? item.fen

  // Click-to-move (alongside drag): click a piece, then its destination. Also
  // makes the board reliably driveable by the Playwright E2E.
  const [selected, setSelected] = useState<string | null>(null)
  useEffect(() => setSelected(null), [index, phase, pending])

  function onSquareClick(square: string) {
    if (phase !== 'guess' || pending) return
    if (selected) {
      if (square !== selected && onDropMove(selected, square)) {
        setSelected(null)
        return
      }
      const pc = new Chess(item.fen).get(square as ChessSquare)
      setSelected(pc && pc.color === session.heroColor ? square : null)
      return
    }
    const pc = new Chess(item.fen).get(square as ChessSquare)
    if (pc && pc.color === session.heroColor) setSelected(square)
  }

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
          <EvalBar whitePct={positionWhitePct} />
          <div className="board-frame" ref={ref}>
            <Chessboard
              id="board"
              position={displayFen}
              boardWidth={width}
              boardOrientation={session.heroColor === 'w' ? 'white' : 'black'}
              arePiecesDraggable={phase === 'guess' && !pending && engineReady}
              onPieceDrop={(from, to) => onDropMove(from, to)}
              onSquareClick={onSquareClick}
              customArrows={arrows}
              customSquareStyles={squareStyles}
              customBoardStyle={{ borderRadius: '6px' }}
            />
          </div>
        </div>
        <MaterialStrip material={materialBalance(displayFen)} />
        <div className="turn-line">
          <span className="mono">{moveLabel(item.moveNumber, item.sideToMove)}</span>{' '}
          {sideName(item.sideToMove)} to move · position {index + 1} of {session.quiz.length}
        </div>
      </div>

      <div className="side-col">
        <div className="game-head">
          <h2>{session.game.title}</h2>
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
                <span className="picked empty">Drag a piece to choose your move…</span>
              )}
              {pending && phase === 'guess' && (
                <button className="btn ghost" type="button" onClick={onTakeBack}>
                  Take back
                </button>
              )}
            </div>
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
            <Reveal fb={result.fb} item={item} onNext={onNext} last={index + 1 >= session.quiz.length} />
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
