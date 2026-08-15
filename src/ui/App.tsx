import { useMemo, useState } from 'react'
import { GAMES, type PackGame } from '../content/games'
import {
  annotationAt,
  planStudy,
  studySides,
  yourSide,
  STUDY_BLOCKER_LABEL,
  type StudyGame,
} from '../domain/studyGame'
import { summarize, type Attempt } from '../domain/session'
import type { Color } from '../domain/types'
import { useGuessSession } from '../app/useGuessSession'
import { usePlaySession } from '../app/usePlaySession'
import { useHomeStats, type HomeStats } from '../app/useHomeStats'
import { getGame, type StoredGame } from '../persist/db'
import type { MaiaLevel } from '../engine/maia/opponent'
import { useAnalyser } from '../app/useAnalyser'
import { MaiaSetup, MaiaPlay } from './MaiaMode'
import { Library, Replay } from './Library'
import { GameDatabase, DbGameView } from './Database'
import type { DbGame } from '../persist/dbGames'
import {
  STRENGTH_PRESETS,
  MULTIPV_OPTIONS,
  presetIdForNodes,
  formatPlayerNames,
  parsePlayerNames,
  loadPlayerNames,
  savePlayerNames,
  type AnalysisSettings,
} from '../app/settings'
import {
  currentItem,
  displayFen as selectDisplayFen,
  isLast,
  isPromotion,
  type SessionState,
} from '../app/sessionMachine'
import { BoardPanel, type Arrows } from './BoardPanel'
import { LinesPanel } from './Analysis'
import { Reveal } from './Reveal'
import {
  ARROW_MASTER,
  ARROW_ENGINE,
  ARROW_USER,
  uciSquares,
  sideName,
  moveLabel,
} from './format'

const PROMO_GLYPH: Record<string, string> = { q: '♛', r: '♜', b: '♝', n: '♞' }

// Home is a chooser; each mode gets a focused setup screen before it starts
// (docs/v0.3.0-plan.md §2). Screens are a flat union rather than nested state
// because there is no back-stack to model — everything returns to Home.
type Mode =
  | 'home'
  | 'maia-setup'
  | 'maia'
  | 'guess-pick'
  | 'guess'
  | 'library'
  | 'replay'
  | 'database'
  | 'database-game'

/** Analysis settings configure guess-mode grading, so the gear only belongs there. */
const SETTINGS_MODES: Mode[] = ['guess-pick', 'guess']

/**
 * Screens that never touch an engine, so they must not report one as loading.
 * Replay does analyse on request, which is why it isn't here.
 */
const ENGINE_FREE_MODES: Mode[] = ['home', 'library', 'database', 'database-game']

export function App() {
  const engine = useAnalyser() // one shared Stockfish worker (guess grading + play coach)
  const guess = useGuessSession(engine)
  const play = usePlaySession(engine)
  const gstate = guess.state
  const [mode, setMode] = useState<Mode>('home')
  const [showSettings, setShowSettings] = useState(false)
  // Re-read the Home stats each time we land there, so a game you just finished
  // shows up without a refresh.
  const [homeVisits, setHomeVisits] = useState(0)
  const stats = useHomeStats(homeVisits)
  // The game being replayed, plus where to land in it.
  const [replaying, setReplaying] = useState<{ game: StoredGame; cursor: number } | null>(null)
  const [reviewJumpError, setReviewJumpError] = useState<string | null>(null)
  // A game opened out of the attached database (#54). It lives here rather than
  // inside the database screen because opening one is the seam #55 hangs off:
  // studying an imported game means building a `PackGame` from this row and
  // handing it to `guess.startGame`, and only this function has to know that.
  const [dbGame, setDbGame] = useState<DbGame | null>(null)

  const goHome = () => {
    guess.goHome()
    play.goHome()
    setMode('home')
    setHomeVisits((n) => n + 1)
  }
  const startGuess = (g: PackGame) => {
    guess.startGame(g)
    setMode('guess')
  }
  const startMaia = (opts: { yourColor: Color; level: MaiaLevel }) => {
    play.newGame(opts)
    setMode('maia')
  }
  const openDbGame = (game: DbGame) => {
    setDbGame(game)
    setMode('database-game')
  }
  const openReplay = (game: StoredGame, cursor = 0) => {
    setReviewJumpError(null)
    setReplaying({ game, cursor })
    setMode('replay')
  }
  /**
   * Jump into the game you just finished from its review. It's already been
   * persisted by the time the review renders, so this reads it back rather than
   * converting live state — one code path for replay, whatever the source.
   */
  const reviewPly = async (gameId: string, ply: number) => {
    const stored = await getGame(gameId)
    // getGame is best-effort and returns undefined when storage is unavailable,
    // so say so rather than letting the click do nothing at all.
    if (stored) openReplay(stored, ply + 1) // cursor N shows the position after N moves
    else setReviewJumpError('This game could not be opened — it may not have been saved.')
  }

  const showSettingsGear = SETTINGS_MODES.includes(mode)
  const showEnginePill = !ENGINE_FREE_MODES.includes(mode) && !mode.endsWith('-setup')
  const enginePill =
    mode === 'maia'
      ? play.maiaError
        ? 'maia error'
        : play.maiaReady
          ? 'maia ready'
          : 'maia loading…'
      : guess.engineError
        ? 'engine error'
        : guess.engineReady
          ? 'engine ready'
          : 'engine loading…'
  const pillOn = mode === 'maia' ? play.maiaReady : guess.engineReady

  return (
    <div className="app">
      <header className="topbar">
        <button className="brand" type="button" onClick={goHome} aria-label="Home">
          <b>étude</b>
          <span className="dot">·</span>
          <b>chess</b>
        </button>
        <div className="top-right">
          {showSettingsGear && (
            <button
              className="settings-btn"
              type="button"
              onClick={() => setShowSettings((v) => !v)}
              aria-label="Analysis settings"
              aria-expanded={showSettings}
            >
              ⚙
            </button>
          )}
          {showEnginePill && (
            <span className={`engine-pill ${pillOn ? 'on' : ''}`}>{enginePill}</span>
          )}
        </div>
      </header>

      {showSettings && showSettingsGear && (
        <SettingsPanel settings={guess.settings} onChange={guess.setSettings} />
      )}

      {reviewJumpError && (
        <p className="banner error" role="alert">
          {reviewJumpError}
        </p>
      )}

      <main className="main">
        {mode === 'home' && (
          <Home
            stats={stats}
            onPlay={() => setMode('maia-setup')}
            onStudy={() => setMode('guess-pick')}
            onLibrary={() => setMode('library')}
            onDatabase={() => setMode('database')}
          />
        )}
        {mode === 'maia-setup' && (
          <Screen title="Play a coached game" onBack={goHome}>
            <MaiaSetup onPlay={startMaia} defaultLevel={play.defaultLevel} />
          </Screen>
        )}
        {mode === 'guess-pick' && (
          <Screen title="Study a master game" onBack={goHome}>
            <GamePicker
              onPickGame={startGuess}
              engineError={guess.engineError}
              engineReady={guess.engineReady}
            />
          </Screen>
        )}
        {mode === 'guess' && gstate.screen === 'play' && gstate.session && (
          <Play
            state={gstate}
            engineReady={guess.engineReady}
            onDropMove={guess.tryMove}
            onClickSquare={guess.clickSquare}
            onTakeBack={guess.takeBack}
            onSetPromotion={guess.setPromotion}
            onReasonChange={guess.setReason}
            onCommit={guess.commit}
            onNext={guess.next}
          />
        )}
        {mode === 'guess' && gstate.screen === 'summary' && gstate.session && (
          <Summary
            attempts={gstate.attempts}
            game={gstate.session.game}
            onReplay={() => startGuess(gstate.session!.game)}
            onHome={goHome}
          />
        )}
        {mode === 'maia' && (
          <MaiaPlay
            play={play}
            onNewGame={() => play.newGame({ yourColor: play.state.yourColor, level: play.state.level })}
            onHome={goHome}
            onReviewPly={reviewPly}
          />
        )}
        {mode === 'library' && (
          <Screen title="Your games" onBack={goHome}>
            <Library onOpen={(g) => openReplay(g)} onPlay={() => setMode('maia-setup')} />
          </Screen>
        )}
        {mode === 'database' && (
          <Screen title="Your game database" onBack={goHome}>
            <GameDatabase onOpenGame={openDbGame} />
          </Screen>
        )}
        {mode === 'database-game' && dbGame && (
          <Screen
            title="A game from your database"
            onBack={() => setMode('database')}
            back="Database"
          >
            <DbGameView game={dbGame}>
              <StudyThisGame game={dbGame} onStudy={startGuess} />
            </DbGameView>
          </Screen>
        )}
        {mode === 'replay' && replaying && (
          <Replay
            // Keyed per game so opening a different one never inherits the
            // previous cursor or flip state.
            key={replaying.game.gameId}
            game={replaying.game}
            engine={engine}
            initialCursor={replaying.cursor}
            onBack={() => setMode('library')}
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
  stats,
  onPlay,
  onStudy,
  onLibrary,
  onDatabase,
}: {
  stats: HomeStats
  onPlay: () => void
  onStudy: () => void
  onLibrary: () => void
  onDatabase: () => void
}) {
  return (
    <section className="home">
      <h1 className="title">Train your chess judgment.</h1>
      <p className="lede">Pick how you want to work today.</p>

      <ul className="mode-cards">
        <ModeCard
          title="Play a coached game"
          pitch="A full game against a human-like opponent, with a coach grading every move as you go."
          cta="Choose colour & level"
          stat={playStat(stats)}
          onClick={onPlay}
        />
        <ModeCard
          title="Study a master game"
          pitch="Take the winner's side of a classic. Commit your move and your reasoning before the answer appears."
          cta="Pick a game"
          stat={stats.decisions > 0 ? `${stats.decisions} decisions committed` : undefined}
          onClick={onStudy}
        />
        <ModeCard
          title="Your games"
          pitch="Walk back through a finished game with the coach's verdict on every move."
          cta="Browse your games"
          stat={stats.gamesPlayed > 0 ? `${stats.gamesPlayed} saved` : undefined}
          onClick={onLibrary}
        />
        <ModeCard
          title="Your game database"
          pitch="Attach a PGN file of your own. It is parsed and indexed on this device — we ship no database of someone else's games."
          cta="Attach a PGN file"
          stat={
            stats.dbGames > 0 ? `${stats.dbGames.toLocaleString()} games attached` : undefined
          }
          onClick={onDatabase}
        />
      </ul>
    </section>
  )
}

/**
 * Your play history in one line, or nothing at all before you've played. An
 * empty card should read as an invitation, not as a slot waiting to be filled.
 */
function playStat(stats: HomeStats): string | undefined {
  if (stats.gamesPlayed === 0) return undefined
  const games = `${stats.gamesPlayed} played`
  return stats.lastAccuracy === undefined
    ? games
    : `last game ${stats.lastAccuracy.toFixed(2)}% · ${games}`
}

function ModeCard({
  title,
  pitch,
  cta,
  stat,
  onClick,
}: {
  title: string
  pitch: string
  cta: string
  stat?: string
  onClick: () => void
}) {
  return (
    <li className="mode-card">
      {/* The whole card is the control — a button inside would give two tab stops
          to the same destination. */}
      <button type="button" className="mode-card-btn" onClick={onClick}>
        <h2>{title}</h2>
        <p className="mode-pitch">{pitch}</p>
        <div className="mode-foot">
          <span className="mode-cta">{cta} →</span>
          {stat && <span className="mode-stat mono">{stat}</span>}
        </div>
      </button>
    </li>
  )
}

/**
 * Shell for a focused setup screen: a title, a way back, and the content.
 *
 * `back` names where the button goes. It defaults to Home because almost
 * everything returns there; a screen reached *from* another one says so instead,
 * so the label is never a lie about where you land.
 */
function Screen({
  title,
  onBack,
  back = 'Home',
  children,
}: {
  title: string
  onBack: () => void
  back?: string
  children: React.ReactNode
}) {
  return (
    <section className="screen">
      <div className="screen-head">
        <button className="btn ghost back" type="button" onClick={onBack}>
          ← {back}
        </button>
        <h1 className="screen-title">{title}</h1>
      </div>
      {children}
    </section>
  )
}

function GamePicker({
  onPickGame,
  engineError,
  engineReady,
}: {
  onPickGame: (g: PackGame) => void
  engineError: string | null
  engineReady: boolean
}) {
  return (
    <>
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
            <button className="btn primary" type="button" onClick={() => onPickGame(g)}>
              Study this game
            </button>
          </li>
        ))}
      </ul>
    </>
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
  const session = state.session!
  const { phase, pending, reason, result, lines, positionWhitePct, selected, index } = state
  const item = currentItem(state)!
  const boardFen = selectDisplayFen(state)

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
      <BoardPanel
        id="board"
        fen={boardFen}
        orientedFor={session.heroColor}
        whitePct={positionWhitePct}
        arePiecesDraggable={phase === 'guess' && !pending && engineReady}
        onPieceDrop={(from, to) => onDropMove(from, to)}
        onSquareClick={onClickSquare}
        customArrows={arrows}
        customSquareStyles={squareStyles}
      >
        <span className="mono">{moveLabel(item.moveNumber, item.sideToMove)}</span>{' '}
        {sideName(item.sideToMove)} to move · position {index + 1} of {session.quiz.length}
      </BoardPanel>

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
            {/* The source file's note on this move, when it wrote one (#55). It
                renders below our "why" and clearly attributed — never merged
                into it. A game with no note reveals exactly as it always has. */}
            <Reveal
              fb={result.fb}
              item={item}
              note={annotationAt(session.game, item.ply)}
              onNext={onNext}
              last={isLast(state)}
            />
            <LinesPanel fen={item.fen} lines={lines} />
          </>
        )}
      </div>
    </section>
  )
}

// ---------- Studying a game from the attached database (#55) ----------

/**
 * The control #54 left a `children` seam for.
 *
 * It exists because a database row is not curated content: the plan is computed
 * *before* the button is offered, so a record with no moves, one whose movetext
 * doesn't replay, or one too short to quiz says so here rather than opening an
 * empty session. And where the file recorded no winner there is no side to take
 * — so both are offered and neither is chosen, which is the difference between
 * a considered default and quietly quizzing you as White on every draw.
 *
 * A game with **your** name on it is the third case (#130): your side comes
 * first, whatever the result, because the game you lost is the one worth
 * reviewing. The names that decide this are read from storage here rather than
 * held above, so the answer survives a reload — you say who you are once, not
 * once per game.
 */
function StudyThisGame({
  game,
  onStudy,
}: {
  game: DbGame
  onStudy: (g: StudyGame) => void
}) {
  const [names, setNames] = useState(loadPlayerNames)
  const yours = useMemo(() => yourSide(game, names), [game, names])
  const plans = useMemo(
    () => studySides(game.result, yours).map((color) => ({ color, plan: planStudy(game, color) })),
    [game, yours],
  )
  const playable = plans.flatMap((p) => (p.plan.ok ? [{ color: p.color, ...p.plan }] : []))

  if (playable.length === 0) {
    const blocked = plans[0]!.plan
    return (
      <p className="study-blocked">
        <b>Not one to study.</b> {!blocked.ok && STUDY_BLOCKER_LABEL[blocked.reason]}
      </p>
    )
  }

  const pick = playable.length > 1
  // Your side leads the list when it can be studied at all; when it can't, the
  // note says so rather than offering the other side as though it were yours.
  const mine = yours ? playable.find((p) => p.color === yours) : undefined
  const yoursBlocked = yours && !mine ? plans.find((p) => p.color === yours)?.plan : undefined
  return (
    <div className="study-controls">
      <div className="study-buttons">
        {playable.map(({ color, game: studyGame }) => (
          <button
            key={color}
            // Your side leads; a game with no winner still emphasises both,
            // because there the point is that neither was chosen for you.
            className={`btn ${!yours || color === yours ? 'primary' : 'ghost'}`}
            type="button"
            onClick={() => onStudy(studyGame)}
          >
            {!pick
              ? 'Study this game'
              : color === yours
                ? `Study your side (${sideName(color)})`
                : `Study as ${sideName(color)}`}
          </button>
        ))}
      </div>
      <p className="study-note">
        {mine ? (
          <>
            You played <b>{sideName(mine.color)}</b> here, so your side comes first —{' '}
            <b>{mine.positions}</b> positions to guess, starting after move four. Every move is
            graded against the engine rather than against what was played, so a game you lost is
            still a session about your own decisions.
          </>
        ) : yoursBlocked ? (
          <>
            You played <b>{sideName(yours!)}</b> here.{' '}
            {!yoursBlocked.ok && STUDY_BLOCKER_LABEL[yoursBlocked.reason]} The other side is
            offered instead — <b>{playable[0]!.positions}</b> positions to guess.
          </>
        ) : pick ? (
          <>
            This game has no winner to take the side of, so pick one —{' '}
            {playable.map((p, i) => (
              <span key={p.color}>
                {i > 0 && ', '}
                {sideName(p.color)} has <b>{p.positions}</b> to guess
              </span>
            ))}
            .
          </>
        ) : (
          <>
            You take <b>{sideName(playable[0]!.color)}</b>&apos;s side, the winner&apos;s —{' '}
            <b>{playable[0]!.positions}</b> positions to guess, starting after move four.
          </>
        )}{' '}
        {game.comments && 'Notes the file carries are shown at the reveal, marked as the file’s.'}
      </p>
      <YourNames names={names} onChange={setNames} claimed={yours !== null} />
    </div>
  )
}

/**
 * Who you are, so a game of yours can be recognised as one (#130).
 *
 * Folded away because it is answered once and then never again, and it sits on
 * the study control rather than in the settings panel because this is the only
 * screen where knowing the answer changes anything.
 *
 * A list and not a field: a site writes your handle into the `White` tag, a PGN
 * you exported by hand writes `Lastname, Firstname`, and both are you. One per
 * line, because that comma is part of a name. Nothing is guessed for you — the
 * list starts empty and stays on this machine.
 */
function YourNames({
  names,
  onChange,
  claimed,
}: {
  names: string[]
  onChange: (names: string[]) => void
  claimed: boolean
}) {
  const [draft, setDraft] = useState(() => formatPlayerNames(names))
  const save = () => {
    const parsed = parsePlayerNames(draft)
    savePlayerNames(parsed)
    onChange(parsed)
    setDraft(formatPlayerNames(parsed))
  }
  return (
    <details className="study-you">
      <summary>{claimed ? 'This is one of your games' : 'Is this one of your games?'}</summary>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          save()
        }}
      >
        <label htmlFor="your-names">The names you play under — one per line</label>
        <textarea
          id="your-names"
          rows={2}
          value={draft}
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={save}
        />
        <button className="btn ghost" type="submit">
          Save
        </button>
        <span className="study-note">
          Matched against the game&apos;s White and Black tags, ignoring case. Kept in this browser
          and nowhere else.
        </span>
      </form>
    </details>
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
