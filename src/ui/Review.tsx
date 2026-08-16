/**
 * Review mode: pick a game of yours, analyse it properly, then work the
 * positions that decided it (#144).
 *
 * This is **composition**, not new machinery. Every piece already shipped —
 * #54's browse, #130's "whose side", #132's moment selection, #133's pass,
 * #131's explorable reveal — and the session it starts is the ordinary
 * `startGuess` path. What lives here is the screen that joins them, and the two
 * refusals that join has to make:
 *
 * - **The pass budget is stated before it runs, and so is what it cannot do.**
 *   No budget a browser can afford makes an *absence* trustworthy: 800k already
 *   loses a real Tier B move on this project's reference game, and a WASM pass
 *   cannot get near 800k over a whole game in a tolerable time
 *   (`app/gameAnalysis.BATCH_NODES` carries the numbers). So this screen never
 *   says "the critical positions in this game". It says **the positions this
 *   pass could see**, at every budget, and it says what it may have walked past.
 *   That is constitution §9/§12, not a copy detail — the hedge comes off only
 *   when `trustworthyAbsences` says the evaluations came from a deep enough
 *   pass, which today means one imported from off-app.
 * - **Even that weaker claim is a claim about the whole game**, so it is offered
 *   only over a complete pass. `domain/reviewPlan.criticalOffer` decides; this
 *   renders the refusal it gives back, with the coverage, rather than serving a
 *   shorter list that looks the same as a clean game.
 *
 * The picker is a **separate entry point** rather than the unified picker the
 * owner has argued for. Same reasoning as the issue's note on shape: getting the
 * loop working end to end is the goal, and `src/ui/Database.tsx` is owned by
 * concurrent work on #145 — so the browse *machinery* is reused (`useDbBrowse`,
 * `domain/dbQuery`, the same indexes) while the table and the filters this
 * screen needs are its own. Merging the two pickers stays worth doing.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { PAGE_SIZE } from '../domain/dbQuery'
import { TIER_A_MAX_SWING } from '../domain/grade'
import { selectKeyMoments, type KeyMoment, type KeyMomentReason } from '../domain/keyMoments'
import { sideToMoveOf } from '../domain/replay'
import { criticalOffer, reviewPriority, type CriticalOffer } from '../domain/reviewPlan'
import {
  planStudy,
  studySides,
  yourSide,
  STUDY_BLOCKER_LABEL,
  type StudyGame,
} from '../domain/studyGame'
import type { Color } from '../domain/types'
import { ANALYSIS_BUDGETS, budgetForNodes, trustworthyAbsences } from '../app/gameAnalysis'
import { useDbBrowse } from '../app/useDbBrowse'
import { useDbGameAnalysis } from '../app/useDbGameAnalysis'
import { useReviewList, type ReviewRow } from '../app/useReviewList'
import type { AnalyserState } from '../app/useAnalyser'
import type { DbGame } from '../persist/dbGames'
import { moveLabel, sideName, TIER_CLASS } from './format'
import { YourNames } from './YourNames'

const count = (n: number) => n.toLocaleString()
/** "400k" / "4M" — the unit a node budget is talked about in everywhere else. */
const nodeLabel = (nodes: number) =>
  nodes >= 1_000_000 ? `${nodes / 1_000_000}M` : `${Math.round(nodes / 1000)}k`

// ---------- picking a game ----------

const RESULT_OPTIONS: [string, string][] = [
  ['1-0', 'White won'],
  ['0-1', 'Black won'],
  ['1/2-1/2', 'Draw'],
  ['*', 'Unfinished'],
]

export function ReviewPicker({
  names,
  onChangeNames,
  nodes,
  onOpen,
}: {
  names: string[]
  onChangeNames: (names: string[]) => void
  nodes: number
  onOpen: (game: DbGame) => void
}) {
  const browse = useDbBrowse()
  const list = useReviewList(browse.rows, names, nodes)
  const { setField } = browse

  // Open on your own games when we know a name to look for.
  //
  // Without this the first page is alphabetical by White across the whole
  // database (`persist/dbGames.collectionFor`, the `none` driver), and in a
  // 40k-game import that page contains none of your games at all — the ordering
  // below can only reach what the query returned. Seeded through the public
  // setter rather than by teaching #54's hook about an initial value; the cost
  // is one extra index walk on mount.
  const seeded = useRef(false)
  useEffect(() => {
    if (seeded.current || names.length === 0) return
    seeded.current = true
    setField('text', names[0]!)
  }, [names, setField])

  if (browse.stored === 0) {
    return (
      <div className="library-empty">
        <p className="lede">
          There is nothing attached to review yet. Review mode reads the game database on this
          device — attach a PGN export of your own games (chess.com and Lichess both offer one)
          from <b>Your game database</b>, and they show up here.
        </p>
      </div>
    )
  }

  return (
    <>
      <p className="lede">
        Take one of your own games, measure every position in it, then re-decide the moments the
        pass turns up — or work the whole thing move by move. Games you lost come first, and games
        nobody has analysed yet come before ones already done.
      </p>

      <div className="browse-filters">
        <label className="grow">
          Player or event
          <input
            type="search"
            placeholder="your name, or an event"
            autoComplete="off"
            value={browse.form.text ?? ''}
            onChange={(e) => setField('text', e.target.value)}
          />
        </label>
        <label>
          Result
          <select
            value={browse.form.result ?? ''}
            onChange={(e) => setField('result', e.target.value)}
          >
            <option value="">Any</option>
            {RESULT_OPTIONS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <button className="btn ghost" type="button" onClick={browse.clear}>
          Clear
        </button>
        <p className="settings-hint">
          {names.length > 0 ? (
            <>
              Opened on <b>{names[0]}</b>, because that is a name you gave. Clear the box to browse
              everything attached — the full set of filters is on <b>Your game database</b>.
            </>
          ) : (
            <>
              Tell us the names you play under, below, and this opens on your own games and puts
              your losses first. Without them nothing here can tell which side of a game was yours.
            </>
          )}
        </p>
      </div>

      {browse.rows === null || !list.ready ? (
        <p className="banner" role="status">
          Opening the database…
        </p>
      ) : list.rows.length === 0 ? (
        <div className="library-empty">
          <p className="lede">No attached games match that.</p>
          <button className="btn primary" type="button" onClick={browse.clear}>
            Clear the filters
          </button>
        </div>
      ) : (
        <>
          <ReviewTable rows={list.rows} onOpen={onOpen} />
          <p className="table-note">
            {/* The honest limit of the ordering, said where it is being relied on. */}
            Ordered <b>within this page</b>. Results come back through whichever index answered the
            filter, so a loss further into the database stays where that index put it — sorting all
            of them would mean loading all of them. Narrow the filter to bring a game onto the page.
          </p>
          <div className="pager">
            <button
              className="btn ghost"
              type="button"
              disabled={browse.page === 0}
              onClick={() => browse.goToPage(browse.page - 1)}
            >
              ← Previous
            </button>
            <span className="mono" aria-live="polite">
              {count(browse.page * PAGE_SIZE + 1)}–{count(browse.page * PAGE_SIZE + list.rows.length)}
            </span>
            <button
              className="btn ghost"
              type="button"
              disabled={!browse.hasMore}
              onClick={() => browse.goToPage(browse.page + 1)}
            >
              Next →
            </button>
          </div>
        </>
      )}

      <YourNames
        names={names}
        onChange={onChangeNames}
        summary={names.length > 0 ? 'The names you play under' : 'Which of these games are yours?'}
        id="review-your-names"
      />
    </>
  )
}

/** What the result was *for you*, in a word. Blank where nothing can say. */
const PRIORITY_LABEL: Record<ReturnType<typeof reviewPriority>, string> = {
  lost: 'Lost',
  undecided: 'Drew',
  won: 'Won',
  'not-yours': '',
}

function ReviewTable({ rows, onOpen }: { rows: ReviewRow[]; onOpen: (game: DbGame) => void }) {
  return (
    <div className="table-wrap">
      <table className="games-table results-table">
        <thead>
          <tr>
            <th scope="col">White</th>
            <th scope="col">Black</th>
            <th scope="col">You</th>
            <th scope="col" className="num">
              Year
            </th>
            <th scope="col" className="num">
              Moves
            </th>
            <th scope="col">Analysed</th>
            <th scope="col">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((g) => {
            const priority = reviewPriority(g)
            return (
              <tr key={g.key}>
                <td>{g.white}</td>
                <td>{g.black}</td>
                <td>
                  {g.yours ? (
                    <span className={`review-outcome ${priority}`}>
                      {PRIORITY_LABEL[priority]} as {sideName(g.yours)}
                    </span>
                  ) : (
                    <span className="unknown mono">{g.result}</span>
                  )}
                </td>
                <td className="num mono">{g.year ?? '—'}</td>
                <td className="num mono">{Math.ceil(g.plies / 2)}</td>
                <td className="mono">{g.analysed ? 'yes' : '—'}</td>
                <td className="row-actions">
                  <button
                    className="btn ghost"
                    type="button"
                    onClick={() => onOpen(g)}
                    aria-label={`Review ${g.white} vs ${g.black}`}
                  >
                    Review →
                  </button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ---------- reviewing one game ----------

export function ReviewGame({
  game,
  engine,
  names,
  onChangeNames,
  nodes,
  onChangeNodes,
  onStart,
}: {
  game: DbGame
  engine: AnalyserState
  names: string[]
  onChangeNames: (names: string[]) => void
  nodes: number
  onChangeNodes: (nodes: number) => void
  onStart: (game: StudyGame, focusPlies?: readonly number[]) => void
}) {
  const pass = useDbGameAnalysis(engine, game, nodes)

  const yours = useMemo(() => yourSide(game, names), [game, names])
  // The sides this game can be studied from, most obvious first — yours when we
  // know it, the winner's otherwise, both when there is no winner (#130, #55).
  const sides = useMemo(() => studySides(game.result, yours), [game.result, yours])
  const [side, setSide] = useState<Color | null>(null)
  const heroColor = side ?? sides[0]!
  // A different game is a different set of sides; never carry a choice across.
  useEffect(() => setSide(null), [game.key])

  // `yours` again, not only for the side: it is what stops review mode calling
  // your own move "the master's" at the reveal (#158).
  const plan = useMemo(() => planStudy(game, heroColor, yours), [game, heroColor, yours])
  const studyGame = plan.ok ? plan.game : null

  const sanHistory = useMemo(
    () => game.movetext.split(/\s+/).filter(Boolean),
    [game.movetext],
  )

  /**
   * The moments, recomputed from whatever the pass has produced so far.
   *
   * Cheap and pure, so it simply re-runs — and it must, because switching sides
   * changes whose moves are being judged. The coverage it reports is what
   * `criticalOffer` refuses on; nothing here fills a gap in.
   */
  const moments = useMemo(
    () =>
      selectKeyMoments({
        heroColor,
        sanHistory,
        evalByPly: pass.evalByPly,
        ...(pass.startEval ? { startEval: pass.startEval } : {}),
        // Taken from the reconstruction the pass actually scored, so an imported
        // study that begins on Black's move does not have the opponent's moves
        // selected as yours (#128, and `KeyMomentsInput.firstMover`).
        ...(pass.positions[0] ? { firstMover: sideToMoveOf(pass.positions[0]) } : {}),
      }),
    [heroColor, sanHistory, pass.evalByPly, pass.startEval, pass.positions],
  )

  const offer: CriticalOffer | null = useMemo(
    () => (studyGame ? criticalOffer(studyGame, moments) : null),
    [studyGame, moments],
  )

  const budget = budgetForNodes(nodes)
  const searches = pass.positions.length

  return (
    <>
      <h2 className="db-game-title">
        {game.white} <span className="db-vs">vs</span> {game.black}{' '}
        <span className="mono">{game.result}</span>
      </h2>
      <p className="review-provenance">
        {[game.event, game.date, `${Math.ceil(game.plies / 2)} moves`, `from ${game.source}`]
          .filter(Boolean)
          .join(' · ')}
      </p>

      <SidePicker
        sides={sides}
        yours={yours}
        heroColor={heroColor}
        onPick={setSide}
        names={names}
        onChangeNames={onChangeNames}
      />

      <PassPanel
        pass={pass}
        nodes={nodes}
        onChangeNodes={onChangeNodes}
        searches={searches}
        budgetNote={budget?.note}
      />

      {!plan.ok ? (
        <p className="study-blocked">
          <b>Not one to review.</b> {STUDY_BLOCKER_LABEL[plan.reason]}
        </p>
      ) : (
        <div className="review-paths">
          <CriticalPath
            offer={offer!}
            // The depth the findings *rest on*, not the one the select is
            // showing — an imported off-app pass is deeper than either.
            nodes={pass.effectiveNodes}
            heroColor={heroColor}
            onStart={(plies) => onStart(plan.game, plies)}
          />
          <WholeGamePath positions={plan.positions} onStart={() => onStart(plan.game)} />
        </div>
      )}
    </>
  )
}

function SidePicker({
  sides,
  yours,
  heroColor,
  onPick,
  names,
  onChangeNames,
}: {
  sides: Color[]
  yours: Color | null
  heroColor: Color
  onPick: (c: Color) => void
  names: string[]
  onChangeNames: (names: string[]) => void
}) {
  return (
    <div className="review-side">
      {/* Three situations, not two. A game with your name on it reviews your
          side; a *decisive* game without it has exactly one side worth taking,
          the winner's, and telling the reader to "pick one" there is a lie —
          there is nothing to pick from (#130, `studyGame.studySides`). Only a
          draw or an unfinished game actually offers a choice. */}
      {yours ? (
        <p className="playing-as">
          You played <b>{sideName(yours)}</b> here, so that is the side being reviewed.
        </p>
      ) : sides.length === 1 ? (
        <p className="playing-as">
          No name of yours is on this game, so it is reviewed as the winner —{' '}
          <b>{sideName(heroColor)}</b>. Everything below is about their decisions, not yours.
        </p>
      ) : (
        <p className="playing-as">
          Nothing on this game says which side was yours and it has no winner either, so pick one.
          Every figure below is about <b>{sideName(heroColor)}</b>&apos;s decisions.
        </p>
      )}
      {sides.length > 1 && (
        <div className="study-buttons">
          {sides.map((color) => (
            <button
              key={color}
              type="button"
              className={`btn ${color === heroColor ? 'primary' : 'ghost'}`}
              aria-pressed={color === heroColor}
              onClick={() => onPick(color)}
            >
              {color === yours ? `Your side (${sideName(color)})` : sideName(color)}
            </button>
          ))}
        </div>
      )}
      <YourNames
        names={names}
        onChange={onChangeNames}
        claimed={yours !== null}
        id="review-game-names"
      />
    </div>
  )
}

/**
 * The pass: what it will cost before it runs, where it is while it runs, and
 * what budget it ran at once it has.
 *
 * The budget is the control the issue asked to be made visible, and it sits
 * *here* rather than behind the grading gear because it is not a grading
 * setting: it decides what a stored pass means, and changing it invalidates
 * stored work rather than reinterpreting it (`app/settings.loadReviewNodes`).
 */
function PassPanel({
  pass,
  nodes,
  onChangeNodes,
  searches,
  budgetNote,
}: {
  pass: ReturnType<typeof useDbGameAnalysis>
  nodes: number
  onChangeNodes: (nodes: number) => void
  searches: number
  budgetNote?: string
}) {
  // Wall-clock, measured rather than estimated: how long a WASM search takes
  // depends on the machine, and a number we made up would be wrong in the
  // direction that matters (too optimistic) on exactly the slow machines where
  // the warning is worth having.
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [now, setNow] = useState(0)
  useEffect(() => {
    if (!pass.running) return
    setStartedAt((t) => t ?? Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [pass.running])
  useEffect(() => {
    if (!pass.running) setStartedAt(null)
  }, [pass.running])

  const elapsed = startedAt ? Math.max(0, now - startedAt) : 0
  const done = pass.progress?.done ?? 0
  const total = pass.progress?.total ?? 0
  const remaining = done > 0 && elapsed > 0 ? ((total - done) * elapsed) / done : null

  if (pass.analysed) {
    return (
      <p className="banner" role="status">
        Analysed — every position measured at <b>{nodeLabel(pass.effectiveNodes)} nodes</b>.{' '}
        {pass.effectiveNodes > nodes && (
          <>
            That is a deeper pass than this tab would have run, so it was used as it stood rather
            than redone.{' '}
          </>
        )}
        {!trustworthyAbsences(pass.effectiveNodes) && (
          <>
            A pass this size is reliable about the moves it flags and <b>not</b> about the ones it
            does not — see below.
          </>
        )}
      </p>
    )
  }

  if (pass.running) {
    return (
      <div className="review-pass">
        <div
          className="analysis-progress"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={done}
          aria-label="Analysing the game"
        >
          <div
            className="analysis-progress-fill"
            style={{ width: `${total > 0 ? (done / total) * 100 : 0}%` }}
          />
          <span className="analysis-progress-label mono">
            {done}/{total}
          </span>
        </div>
        <button className="btn ghost" type="button" onClick={pass.cancel}>
          Stop
        </button>
        <p className="table-note mono" aria-live="polite">
          {formatDuration(elapsed)} elapsed
          {remaining !== null && <> · about {formatDuration(remaining)} left</>} · {nodeLabel(nodes)}{' '}
          nodes per position
        </p>
        <p className="table-note">
          Stopping keeps what has been measured so far. It is not a partial answer to
          &ldquo;which positions decided this game&rdquo; though — that question needs every move
          of yours, and until it has them the critical-positions path stays closed.
        </p>
      </div>
    )
  }

  return (
    <div className="review-pass">
      <label className="review-budget">
        Analysis budget
        <select
          value={nodes}
          onChange={(e) => onChangeNodes(Number(e.target.value))}
          disabled={pass.running}
        >
          {ANALYSIS_BUDGETS.map((b) => (
            <option key={b.id} value={b.nodes}>
              {b.label}
            </option>
          ))}
        </select>
      </label>
      {budgetNote && <p className="settings-hint">{budgetNote}</p>}
      <p className="review-cost">
        <b>{count(searches)} searches</b> at {nodeLabel(nodes)} nodes each — a couple of minutes
        for a full game, in this tab, once. The result is stored, so the next visit opens straight
        onto the findings, and the progress bar reports real elapsed time rather than a guess.
      </p>
      {/* Said before the button, not after the pass: this is the limitation the
          whole mode is bounded by, and it is not a footnote. */}
      <p className="review-cost">
        <b>What this pass cannot do.</b> A browser search is small. Measured on this project&apos;s
        reference game, even {nodeLabel(800_000)} nodes per position missed a real Tier B move —
        and a pass at the {nodeLabel(4_000_000)} the measurements are stated against would take
        roughly three quarters of an hour here. So a finding below is a finding, and a game with
        <b> no</b> findings has not been shown to be clean. Deeper work belongs in an off-app pass,
        and when one is imported for a game this screen uses it instead.
      </p>
      <button
        className="btn primary"
        type="button"
        disabled={!pass.available}
        onClick={pass.start}
      >
        {pass.available ? 'Analyse this game' : 'Waiting for the engine…'}
      </button>
    </div>
  )
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`
}

const REASON_LABEL: Record<KeyMomentReason, string> = {
  blunder: 'a mistake',
  mistake: 'a concession',
  'missed-punish': 'a chance you were handed and did not take',
}

/**
 * The critical-positions path — offered, or refused with the reason.
 *
 * Every branch below states coverage, because the four ways this can fail all
 * render as "no list" and three of them are *not* "you played clean". That
 * distinction is the whole reason `selectKeyMoments` returns `measured`/`total`
 * (#132) and the reason `criticalOffer` exists.
 */
function CriticalPath({
  offer,
  nodes,
  heroColor,
  onStart,
}: {
  offer: CriticalOffer
  /** The budget the evaluations are actually at — see `ImportedGameAnalysis.effectiveNodes`. */
  nodes: number
  heroColor: Color
  onStart: (plies: readonly number[]) => void
}) {
  // Never "the positions that decided the game". At every budget a browser can
  // afford, a missing finding means "this pass did not see it", not "it did not
  // happen" — so the heading claims only what the evidence supports (§9, §12).
  const heading = trustworthyAbsences(nodes)
    ? 'The positions that decided it'
    : 'The positions this pass could see'

  if (!offer.ok) {
    return (
      <section className="review-path">
        <h3>{heading}</h3>
        <p className="study-note">
          {offer.reason === 'not-analysed' && (
            <>
              Not yet — analyse the game first. Drawing a list out of an unmeasured game would show
              you whichever moves happened to have been looked at, and leave the rest looking fine.
            </>
          )}
          {offer.reason === 'partial' && (
            <>
              The pass covered <b>{offer.measured}</b> of your <b>{offer.total}</b> moves.{' '}
              {offer.moments.length > 0 ? (
                <>
                  The {offer.moments.length}{' '}
                  {offer.moments.length === 1 ? 'moment' : 'moments'} it found are real — but a move
                  it never scored is indistinguishable from a move that was fine, so this is not
                  even the list of what a full pass at this budget would have seen.
                </>
              ) : (
                <>
                  It found nothing in what it covered, which is not the same as your having played
                  clean — the moves it never reached could hold anything.
                </>
              )}{' '}
              Run the pass again to finish it.
            </>
          )}
          {offer.reason === 'clean' && (
            <>
              All <b>{offer.total}</b> of your moves were measured at {nodeLabel(nodes)} nodes, and
              none of them gave up more than {TIER_A_MAX_SWING} win% — engine-equal, the
              trainer&apos;s Tier A. So this pass found nothing to re-decide.{' '}
              {trustworthyAbsences(nodes) ? (
                <>That is a finding rather than an empty list.</>
              ) : (
                <>
                  <b>That is not the same as a clean game.</b> A search this size is exactly what
                  misses a quiet mistake: {nodeLabel(800_000)} nodes — twice the standard budget
                  here — was measured on this project&apos;s reference game to walk past a real
                  Tier B move. Take this as &ldquo;nothing obvious&rdquo;, not as a verdict.
                </>
              )}
            </>
          )}
          {offer.reason === 'unquizzable' && (
            <>
              <b>{offer.moments.length}</b>{' '}
              {offer.moments.length === 1 ? 'moment was' : 'moments were'} found, and none of them
              is a position that can be put as a question — the side to move was not{' '}
              {sideName(heroColor)}&apos;s, or the position had only one legal move. The whole-game
              path still works.
            </>
          )}
        </p>
        {offer.reason === 'partial' && offer.moments.length > 0 && (
          <MomentList moments={offer.moments} nodes={nodes} partial />
        )}
      </section>
    )
  }

  return (
    <section className="review-path">
      <h3>{heading}</h3>
      <p className="study-note">
        Every one of your <b>{offer.total}</b> moves was measured at {nodeLabel(nodes)} nodes.
        These are the ones that cost more than Tier A, worst first. You will be asked to re-decide{' '}
        <b>{offer.positions}</b> of them, in playing order, with the same commit-then-reveal the
        rest of the app uses.
        {offer.unaskable > 0 && (
          <>
            {' '}
            <b>
              {offer.unaskable} of the {offer.moments.length} below cannot be asked
            </b>{' '}
            — the position had no choice to make — so they are listed but not in the session.
          </>
        )}
        {!trustworthyAbsences(nodes) && (
          <>
            {' '}
            <b>The list is a floor, not a ceiling.</b> Each of these is a real concession this
            search found; a mistake it walked past is not on it, and at browser budgets that
            happens — {nodeLabel(800_000)} nodes missed a real Tier B move on this project&apos;s
            reference game. Read it as &ldquo;at least these&rdquo;.
          </>
        )}
      </p>
      <MomentList moments={offer.moments} nodes={nodes} />
      <button className="btn primary" type="button" onClick={() => onStart(offer.plies)}>
        Re-decide {offer.positions} {offer.positions === 1 ? 'position' : 'positions'}
      </button>
    </section>
  )
}

function MomentList({
  moments,
  nodes,
  partial = false,
}: {
  moments: readonly KeyMoment[]
  nodes: number
  partial?: boolean
}) {
  return (
    <>
      <ol className="moment-list">
        {moments.map((m) => (
          <li key={m.ply}>
            <span className="mono">{moveLabel(Math.floor(m.ply / 2) + 1, m.ply % 2 === 0 ? 'w' : 'b')}</span>{' '}
            <b className="mono">{m.san}</b>{' '}
            <span className={`tier-badge ${TIER_CLASS[m.tier]}`}>Tier {m.tier}</span>{' '}
            <span className="lost mono">−{Math.round(m.swing)}%</span> · {REASON_LABEL[m.reason]}
            {m.chance && (
              <span className="moment-chance">
                {' '}
                after their <b className="mono">{m.chance.san}</b> gave up{' '}
                {Math.round(m.chance.swing)}%
              </span>
            )}
          </li>
        ))}
      </ol>
      <p className="table-note">
        Win% given up against the engine&apos;s best, one line per position at {nodeLabel(nodes)}{' '}
        nodes — the same scale the coach and the {'?!'}/{'?'}/{'??'} glyphs use. One line is
        enough to price the move you played and not enough to say whether the position was a
        genuine only-move or one of six equal ones, so nothing here claims that. Nor does it say
        the game hung on any of these: a swing in an already-decided position costs win% without
        changing the result.
        {partial && ' Measured over part of the game only — see above.'}
      </p>
    </>
  )
}

function WholeGamePath({
  positions,
  onStart,
}: {
  positions: number
  onStart: () => void
}) {
  return (
    <section className="review-path">
      <h3>The whole game</h3>
      <p className="study-note">
        Every decision you had past move four — <b>{positions}</b> positions — in order. Needs no
        analysis pass: each move is graded against the engine as you commit it, which is why this
        path is open whether or not the game has been measured.
      </p>
      <button className="btn ghost" type="button" onClick={onStart}>
        Work all {positions} positions
      </button>
    </section>
  )
}
