/**
 * Attach, browse and search your own game database (#53 + #54 + #145, ADR 0018).
 *
 * We ship no corpus — that is the decision that makes this legally clean — so
 * this screen takes a PGN file the user already has, shows honestly what will be
 * kept and what will be dropped, says plainly that an import is never the only
 * copy of anything, and then lets you find a game in what you attached.
 *
 * Or it fetches your own games from chess.com for you (#145), which is the same
 * decision rather than an exception to it: your games, fetched from a public
 * read-only API straight to your browser, stored on your device, redistributed
 * nowhere. Both routes end in the same rows through the same `putDbGames`.
 *
 * The browse half (plan §10) holds one page of results and never more. At the
 * 10k–100k games an import is written for, a results table that renders its
 * results is a hung tab, so every filter is answered through an index and paged
 * — see `domain/dbQuery.ts` for which index answers what, and why that choice is
 * only ever about cost.
 *
 * **Opening a game goes through the caller** (`onOpenGame`), not through a
 * detail view welded on here. #55 feeds a chosen game into guess-the-move, and
 * the only thing it should have to change is what the app does with the row.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  DEFAULT_IMPORT_FILTERS,
  MY_GAMES_FILTERS,
  SKIP_REASON_LABEL,
  type ImportFilters,
  type SkipReason,
} from '../domain/pgnImport'
import {
  chesscomUserOfSource,
  normalizeClasses,
  TIME_CLASSES,
  TIME_CLASS_LABEL,
  type TimeClass,
} from '../domain/chesscom'
import { PAGE_SIZE, isEmptyQuery, type GameQuery } from '../domain/dbQuery'
import { usePgnImport } from '../app/usePgnImport'
import { useChesscomSync, type ChesscomSync } from '../app/useChesscomSync'
import { useDbBrowse, type DbBrowse } from '../app/useDbBrowse'
import {
  countDbGames,
  deleteDbSource,
  listDbSources,
  type DbGame,
  type DbGamePage,
  type DbSource,
} from '../persist/dbGames'
import { formatBytes, storageStatus, type StorageStatus } from '../persist/storage'

const count = (n: number) => n.toLocaleString()

export function GameDatabase({ onOpenGame }: { onOpenGame: (game: DbGame) => void }) {
  const [filters, setFilters] = useState<ImportFilters>(DEFAULT_IMPORT_FILTERS)
  const { state, attach, cancel, completed } = usePgnImport()
  const chesscom = useChesscomSync()
  const [sources, setSources] = useState<DbSource[]>([])
  const [total, setTotal] = useState(0)
  const [storage, setStorage] = useState<StorageStatus | null>(null)
  const [reload, setReload] = useState(0)
  const fileInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let cancelled = false
    void Promise.all([listDbSources(), countDbGames(), storageStatus()]).then(([s, n, st]) => {
      if (cancelled) return
      setSources(s)
      setTotal(n)
      setStorage(st)
    })
    return () => {
      cancelled = true
    }
  }, [reload, completed, chesscom.completed])

  const importing = state.status === 'importing'

  const pick = useCallback(
    (file: File | undefined) => {
      if (file) attach(file, filters)
    },
    [attach, filters],
  )

  const detach = async (source: DbSource) => {
    const ok = window.confirm(
      `Detach ${source.name} and remove its ${count(source.games)} games? You can attach the file — or sync the account — again at any time.`,
    )
    if (!ok) return
    await deleteDbSource(source.name)
    // A synced account also has to forget *which months* it pulled. The games
    // are gone, so a record saying those months are done would make the next
    // sync a no-op — "detach and sync again" has to actually work.
    const user = chesscomUserOfSource(source.name)
    if (user) chesscom.forget(user)
    setReload((n) => n + 1)
  }

  return (
    <>
      <p className="lede">
        étude ships no game database. Attach a PGN file you already have — or sync your own games
        from chess.com, below — and it is parsed and indexed <em>on this device</em>: nothing is
        uploaded, and nothing is redistributed.
      </p>

      <ImportFiltersPanel filters={filters} onChange={setFilters} disabled={importing} />

      <div
        className="drop-zone"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault()
          if (!importing) pick(e.dataTransfer.files[0])
        }}
      >
        <input
          ref={fileInput}
          id="pgn-file"
          className="sr-only"
          type="file"
          accept=".pgn,application/x-chess-pgn,text/plain"
          disabled={importing}
          onChange={(e) => {
            pick(e.target.files?.[0])
            e.target.value = '' // so re-attaching the same file fires a change
          }}
        />
        <label className="btn primary" htmlFor="pgn-file">
          Choose a PGN file
        </label>
        <span className="drop-hint">or drop one here</span>
      </div>

      {importing && <ImportProgressBar state={state} onCancel={cancel} />}
      {state.status === 'error' && (
        <p className="banner error" role="alert">
          {state.error}
        </p>
      )}
      {state.status === 'done' && <ImportSummary state={state} />}

      <ChesscomPanel chesscom={chesscom} />

      <BrowseDatabase
        reload={completed + reload + chesscom.completed}
        importing={importing}
        sources={sources}
        onOpen={onOpenGame}
      />

      <AttachedSources sources={sources} total={total} onDetach={detach} />
      <SourceGuidance empty={total === 0} />
      <ReimportNote storage={storage} persisted={state.persisted} />
    </>
  )
}

// ---------- filters ----------

/**
 * The two corpora this screen is used for, one click each (#129).
 *
 * The defaults are ADR 0018 §4's and stay exactly as they are — they are right
 * for the master database the trainer is built on. They are also, measured on a
 * real chess.com account, a filter that keeps **none** of your own games: rapid
 * and blitz are rejected on the clock and a club rating is under the 2200 floor.
 * Every field below already allowed that to be fixed by hand; what was missing
 * was any way to know which four numbers to change, before an import that keeps
 * nothing has told you.
 */
const PRESETS: { label: string; filters: ImportFilters }[] = [
  { label: 'Master games', filters: DEFAULT_IMPORT_FILTERS },
  { label: 'My own games', filters: MY_GAMES_FILTERS },
]

/**
 * Whether the fields currently say exactly what a preset says.
 *
 * Compared by value rather than tracked as a "selected preset", so editing one
 * field by hand leaves *neither* button pressed — which is the truth. A
 * remembered selection would keep claiming "Master games" over settings that
 * were no longer them.
 */
const isPreset = (a: ImportFilters, b: ImportFilters): boolean =>
  a.minBaseSeconds === b.minBaseSeconds &&
  a.excludeFastSpeeds === b.excludeFastSpeeds &&
  a.minElo === b.minElo &&
  a.minFullMoves === b.minFullMoves

function ImportFiltersPanel({
  filters,
  onChange,
  disabled,
}: {
  filters: ImportFilters
  onChange: (f: ImportFilters) => void
  disabled: boolean
}) {
  const set = (patch: Partial<ImportFilters>) => onChange({ ...filters, ...patch })
  return (
    <fieldset className="import-filters" disabled={disabled}>
      <legend>What to keep</legend>
      {PRESETS.map(({ label, filters: preset }) => {
        const applied = isPreset(filters, preset)
        return (
          <button
            key={label}
            type="button"
            className={`btn ${applied ? 'primary' : 'ghost'}`}
            aria-pressed={applied}
            onClick={() => onChange(preset)}
          >
            {label}
          </button>
        )
      })}
      <label>
        Minimum rating
        <input
          type="number"
          min={0}
          step={50}
          value={filters.minElo}
          onChange={(e) => set({ minElo: Math.max(0, Number(e.target.value) || 0) })}
        />
      </label>
      <label>
        Minimum length (moves)
        <input
          type="number"
          min={0}
          value={filters.minFullMoves}
          onChange={(e) => set({ minFullMoves: Math.max(0, Number(e.target.value) || 0) })}
        />
      </label>
      <label>
        Minimum clock (seconds)
        <input
          type="number"
          min={0}
          step={60}
          value={filters.minBaseSeconds}
          onChange={(e) => set({ minBaseSeconds: Math.max(0, Number(e.target.value) || 0) })}
        />
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={filters.excludeFastSpeeds}
          onChange={(e) => set({ excludeFastSpeeds: e.target.checked })}
        />
        Exclude blitz, rapid and bullet
      </label>
      <p className="settings-hint">
        <b>Master games</b> is aimed at a strong over-the-board database: 2200 and up, standard
        time controls only. <b>My own games</b> is aimed at your own export from chess.com or
        Lichess — every time control kept, no rating floor, and the only games dropped are the
        ones with too few moves to ask a question about. Either is a starting point; change any
        field and you are on your own settings, which is fine.
      </p>
      <p className="settings-hint">
        A game whose rating or time control the file doesn&apos;t state is <b>kept and marked
        unknown</b> — we never guess at one to filter on it. Excluding blitz, rapid and bullet
        drops anything the clock <em>or</em> the event&apos;s name puts under 25 minutes; the
        minimum clock is a separate floor, for when you want stricter than that.
      </p>
    </fieldset>
  )
}

// ---------- progress ----------

type ImportState = ReturnType<typeof usePgnImport>['state']

function ImportProgressBar({ state, onCancel }: { state: ImportState; onCancel: () => void }) {
  const { progress } = state
  const percent =
    progress.totalBytes && progress.totalBytes > 0
      ? Math.round((progress.bytesRead / progress.totalBytes) * 100)
      : 0
  return (
    <>
      <div className="import-progress">
        <div
          className="analysis-progress"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          aria-label={`Reading ${state.fileName}`}
        >
          <div className="analysis-progress-fill" style={{ width: `${percent}%` }} />
          <span className="analysis-progress-label mono">{percent}%</span>
        </div>
        <button className="btn ghost" type="button" onClick={onCancel}>
          Stop
        </button>
      </div>
      <p className="import-progress-label mono" aria-live="polite">
        Reading {state.fileName} · {count(progress.parsed)} games read · {count(progress.kept)} kept
        · {count(progress.skipped)} skipped
      </p>
    </>
  )
}

function ImportSummary({ state }: { state: ImportState }) {
  const { progress, written, fileName } = state
  const reasons = Object.entries(progress.skippedByReason) as [SkipReason, number][]
  return (
    <div className="import-summary">
      <p className="banner">
        Attached <b>{count(written)}</b> {written === 1 ? 'game' : 'games'} from {fileName}.
      </p>
      {reasons.length > 0 && (
        <p className="table-note">
          Skipped {count(progress.skipped)} of {count(progress.parsed)}:{' '}
          {reasons
            .sort((a, b) => b[1] - a[1])
            .map(([reason, n]) => `${count(n)} ${SKIP_REASON_LABEL[reason]}`)
            .join(' · ')}
          .
        </p>
      )}
      {written === 0 && progress.parsed > 0 && (
        <p className="table-note">
          Every game in this file was filtered out. The defaults are aimed at strong, standard
          time controls, which is the whole of an online account&apos;s rapid and blitz — if
          these are your own games, pick <b>My own games</b> above and attach the file again.
        </p>
      )}
    </div>
  )
}

// ---------- your own games from chess.com (#145) ----------

/**
 * Fetch your own games instead of exporting a PGN by hand.
 *
 * Three things this screen has to be honest about, because each one is a way the
 * feature could quietly mislead:
 *
 * - **It is a button, never a background job.** chess.com's API is free, public
 *   and unauthenticated, and nothing here runs because the app loaded.
 * - **Which time controls come in is your choice, and there is no default.** The
 *   sync will not start until you pick at least one. Pooling blitz with rapid
 *   and daily is a real analysis error — it describes a mixture of players
 *   rather than a player — so choosing for you would be choosing silently.
 * - **A wrong handle says so.** A 404 is "no such user", never a run that
 *   finishes with zero games and reads like success.
 *
 * The handle is typed here and stored on this device (`app/chesscomAccount.ts`),
 * the same way #130 keeps the names you play under. There is no default and
 * there will not be one.
 */
export function ChesscomPanel({ chesscom }: { chesscom: ChesscomSync }) {
  const { state, account, sync, cancel } = chesscom
  const [user, setUser] = useState(account.user)
  const [classes, setClasses] = useState<TimeClass[]>(account.classes)
  const syncing = state.status === 'syncing'

  const toggle = (time: TimeClass, on: boolean) =>
    setClasses((current) =>
      normalizeClasses(on ? [...current, time] : current.filter((c) => c !== time)),
    )

  return (
    <>
      <h2 className="section-title">Or sync your own games from chess.com</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          sync(user, classes)
        }}
      >
        <fieldset className="import-filters chesscom-sync" disabled={syncing}>
          <legend>Your chess.com account</legend>
          <label>
            Username
            <input
              type="text"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              placeholder="your handle"
              value={user}
              onChange={(e) => setUser(e.target.value)}
            />
          </label>
          {TIME_CLASSES.map((time) => (
            <label key={time} className="check">
              <input
                type="checkbox"
                checked={classes.includes(time)}
                onChange={(e) => toggle(time, e.target.checked)}
              />
              {TIME_CLASS_LABEL[time]}
            </label>
          ))}
          <button className="btn primary" type="submit" disabled={!user.trim() || classes.length === 0}>
            Sync
          </button>
          <p className="settings-hint">
            Fetched from chess.com&apos;s public API straight to this browser — your handle stays
            on this device, nothing is uploaded, and no games are redistributed. Months already
            pulled are not asked for again, so the first sync is the slow one and every one after
            it is the current month.
          </p>
          <p className="settings-hint">
            <b>Pick the time controls deliberately.</b> Pooling blitz with rapid and daily
            describes a mixture of players rather than a player, so there is no default here.
            Everything you pick is kept whatever its rating or clock — only games under five
            moves are dropped, because there is no position in them to ask a question about.
          </p>
        </fieldset>
      </form>

      {syncing && <SyncProgressLine state={state} onCancel={cancel} />}
      {state.status === 'error' && (
        <p className="banner error" role="alert">
          {state.error}
        </p>
      )}
      {state.status === 'done' && <SyncSummary state={state} />}
    </>
  )
}

type SyncState = ChesscomSync['state']

function SyncProgressLine({ state, onCancel }: { state: SyncState; onCancel: () => void }) {
  const { progress } = state
  return (
    <div className="import-progress">
      <p className="import-progress-label mono" aria-live="polite">
        {progress.month
          ? `Fetching ${progress.month} · month ${count(progress.monthsDone + 1)} of ${count(progress.months)}`
          : 'Asking chess.com which months you have games in…'}
        {progress.fetched > 0 && ` · ${count(progress.fetched)} games read`}
      </p>
      <button className="btn ghost" type="button" onClick={onCancel}>
        Stop
      </button>
    </div>
  )
}

/**
 * What the sync did, in the same vocabulary the file import uses.
 *
 * "Already in your database" is its own number rather than folded into the
 * total: a re-sync re-fetches the month you are in, and reporting those games as
 * freshly imported would make an idempotent operation look like it doubled your
 * database every time you pressed the button.
 */
function SyncSummary({ state }: { state: SyncState }) {
  const { progress, written, alreadyPresent } = state
  const fresh = Math.max(0, written - alreadyPresent)
  const reasons = Object.entries(progress.skippedByReason) as [SkipReason, number][]
  return (
    <div className="import-summary">
      <p className="banner">
        Imported <b>{count(fresh)}</b> new {fresh === 1 ? 'game' : 'games'} from{' '}
        {count(progress.fetched)} fetched
        {alreadyPresent > 0 && <> · {count(alreadyPresent)} were already in your database</>}.
      </p>
      {reasons.length > 0 && (
        <p className="table-note">
          Skipped {count(progress.skipped)}:{' '}
          {reasons
            .sort((a, b) => b[1] - a[1])
            .map(([reason, n]) => `${count(n)} ${SKIP_REASON_LABEL[reason]}`)
            .join(' · ')}
          .
        </p>
      )}
      {progress.monthsSkipped > 0 && (
        <p className="table-note">
          {count(progress.monthsSkipped)}{' '}
          {progress.monthsSkipped === 1 ? 'month was' : 'months were'} already complete and{' '}
          {progress.monthsSkipped === 1 ? 'was' : 'were'} not fetched again.
        </p>
      )}
      {progress.fetched === 0 && progress.months === 0 && (
        <p className="table-note">
          Nothing to fetch — every month of this account has already been pulled for the time
          controls you picked.
        </p>
      )}
    </div>
  )
}

// ---------- browse + search (#54, plan §10) ----------

/** Prose for the index that answered a query — which is also the order rows are in. */
const ORDER_LABEL: Record<DbGamePage['order'], string> = {
  names: 'the name matched',
  namePrefix: 'the name matched',
  eco: 'ECO code',
  year: 'year',
  minElo: 'rating',
  source: 'file',
  result: 'result',
  speed: 'time control',
  none: 'White',
}

const RESULT_OPTIONS: [string, string][] = [
  ['1-0', 'White won'],
  ['0-1', 'Black won'],
  ['1/2-1/2', 'Draw'],
  ['*', 'Unfinished'],
]

const SPEED_OPTIONS: [string, string][] = [
  ['classical', 'Classical'],
  ['rapid', 'Rapid'],
  ['blitz', 'Blitz'],
  ['bullet', 'Bullet'],
  ['correspondence', 'Correspondence'],
  ['unknown', 'Unknown'],
]

function BrowseDatabase({
  reload,
  importing,
  sources,
  onOpen,
}: {
  reload: number
  importing: boolean
  sources: DbSource[]
  onOpen: (game: DbGame) => void
}) {
  const browse = useDbBrowse(reload)
  const { rows, stored, total, loading, query } = browse

  // Three different situations that all render as "no rows", and they must not
  // read the same. Nothing attached is answered by the panel above, not here.
  if (stored === 0 && !importing) return null
  if (importing && !stored) {
    return (
      <p className="banner" role="status">
        Reading the file. Games become searchable when the import finishes.
      </p>
    )
  }
  if (rows === null) return <p className="banner">Opening the database…</p>

  const filtered = !isEmptyQuery(query)

  return (
    <>
      <h2 className="section-title">
        Browse {filtered ? matchLabel(total, stored) : `(${count(stored ?? 0)})`}
      </h2>
      {importing && (
        <p className="banner" role="status">
          An import is running — this is what has been stored so far, and it refreshes when the
          import finishes.
        </p>
      )}

      <BrowseFilters browse={browse} sources={sources} />

      {rows.length === 0 ? (
        <NoMatches onClear={browse.clear} />
      ) : (
        <>
          <ResultsTable rows={rows} onOpen={onOpen} />
          <p className="table-note">
            Ordered by {ORDER_LABEL[browse.order]} — results come back through whichever index
            answered the filter, because sorting them any other way would mean loading all of
            them first.
          </p>
          <Pager browse={browse} />
        </>
      )}
      {loading && (
        <p className="table-note" role="status">
          Searching…
        </p>
      )}
    </>
  )
}

/**
 * "12 of 41,238" — or "1,000+ of 41,238".
 *
 * A total the index can answer by itself is exact at any size. One that needs
 * every row re-checked stops at a cap and says so, because reading 100k rows to
 * put a number on screen is the thing paging exists to avoid.
 */
function matchLabel(
  total: DbBrowse['total'],
  stored: DbBrowse['stored'],
): string {
  if (!total) return ''
  const matched = total.exact ? count(total.count) : `${count(total.count)}+`
  return `(${matched} of ${count(stored ?? 0)})`
}

function BrowseFilters({ browse, sources }: { browse: DbBrowse; sources: DbSource[] }) {
  const { form, setField } = browse
  const field = (name: keyof GameQuery) => ({
    value: form[name] ?? '',
    onChange: (e: { target: { value: string } }) => setField(name, e.target.value),
  })
  return (
    <div className="browse-filters">
      <label className="grow">
        Player or event
        <input
          type="search"
          placeholder="Morphy · Hastings · Kasparov Karpov"
          autoComplete="off"
          {...field('text')}
        />
      </label>
      <label>
        From
        <input type="number" placeholder="1857" {...field('yearFrom')} />
      </label>
      <label>
        To
        <input type="number" placeholder="2026" {...field('yearTo')} />
      </label>
      <label>
        Result
        <select {...field('result')}>
          <option value="">Any</option>
          {RESULT_OPTIONS.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label>
        ECO
        <input type="text" placeholder="B44" size={4} {...field('eco')} />
      </label>
      <label>
        Min rating
        <input type="number" step={50} placeholder="2200" {...field('minRating')} />
      </label>
      <label>
        Time control
        <select {...field('speed')}>
          <option value="">Any</option>
          {SPEED_OPTIONS.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      {sources.length > 1 && (
        <label>
          {/* Not "File": a synced chess.com account is a source too (#145). */}
          Source
          <select {...field('source')}>
            <option value="">Any</option>
            {sources.map((s) => (
              <option key={s.name} value={s.name}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <button className="btn ghost" type="button" onClick={browse.clear}>
        Clear
      </button>
      <p className="settings-hint">
        A name matches from the start of any word in either player or the event, so
        <b> karp</b> finds Karpov and <b>garry</b> finds Kasparov, Garry. A year, rating or ECO
        filter <b>leaves out the games whose file never said</b> — they are still there
        unfiltered, and &ldquo;Unknown&rdquo; under time control is how you find them.
      </p>
    </div>
  )
}

function NoMatches({ onClear }: { onClear: () => void }) {
  return (
    <div className="library-empty">
      <p className="lede">
        No games in this database match those filters. The defaults an import runs with are
        strict — strong players, standard time controls — so the games you are looking for may
        never have been stored.
      </p>
      <button className="btn primary" type="button" onClick={onClear}>
        Clear the filters
      </button>
    </div>
  )
}

function ResultsTable({ rows, onOpen }: { rows: DbGame[]; onOpen: (game: DbGame) => void }) {
  return (
    <div className="table-wrap">
      <table className="games-table results-table">
        <thead>
          <tr>
            <th scope="col">White</th>
            <th scope="col">Black</th>
            <th scope="col">Event</th>
            <th scope="col" className="num">
              Year
            </th>
            <th scope="col">Result</th>
            <th scope="col">ECO</th>
            <th scope="col" className="num">
              Moves
            </th>
            <th scope="col">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((g) => (
            <tr key={g.key}>
              <td>{playerLabel(g.white, g.whiteElo)}</td>
              <td>{playerLabel(g.black, g.blackElo)}</td>
              <td>{g.event ?? <span className="unknown">—</span>}</td>
              <td className="num mono">{g.year ?? '—'}</td>
              <td className="mono">{g.result}</td>
              <td className="mono">{g.eco ?? '—'}</td>
              <td className="num mono">{Math.ceil(g.plies / 2)}</td>
              <td className="row-actions">
                <button
                  className="btn ghost"
                  type="button"
                  onClick={() => onOpen(g)}
                  aria-label={`Open ${g.white} vs ${g.black}`}
                >
                  Open →
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

const playerLabel = (name: string, elo?: number) => (
  <>
    {name}
    {elo != null && <span className="coverage-note mono"> {elo}</span>}
  </>
)

/**
 * Next and previous only.
 *
 * Numbered pages would need a total, and a total behind a filter is capped
 * rather than exact — so the pager promises exactly what it can deliver: there
 * is another page, or there isn't.
 */
function Pager({ browse }: { browse: DbBrowse }) {
  const { page, goToPage, hasMore, rows } = browse
  const first = page * PAGE_SIZE + 1
  const last = page * PAGE_SIZE + (rows?.length ?? 0)
  if (page === 0 && !hasMore) return null
  return (
    <div className="pager">
      <button
        className="btn ghost"
        type="button"
        disabled={page === 0}
        onClick={() => goToPage(page - 1)}
      >
        ← Previous
      </button>
      <span className="mono" aria-live="polite">
        {count(first)}–{count(last)}
      </span>
      <button
        className="btn ghost"
        type="button"
        disabled={!hasMore}
        onClick={() => goToPage(page + 1)}
      >
        Next →
      </button>
    </div>
  )
}

// ---------- one game ----------

/**
 * A game from the attached database.
 *
 * Deliberately thin: it shows what was stored — the headers, the provenance, the
 * moves and whatever annotations came with the file — and nothing that needs an
 * engine. Studying it is #55, which adds its own control through `children`
 * rather than by rewriting this.
 */
export function DbGameView({
  game,
  children,
}: {
  game: DbGame
  children?: React.ReactNode
}) {
  const moves = game.movetext ? game.movetext.split(' ') : []
  return (
    <>
      <h2 className="db-game-title">
        {game.white} <span className="db-vs">vs</span> {game.black}{' '}
        <span className="mono">{game.result}</span>
      </h2>
      <dl className="db-meta">
        <Meta label="Event">{game.event}</Meta>
        <Meta label="Site">{game.site}</Meta>
        <Meta label="Date">{game.date}</Meta>
        <Meta label="ECO">{game.eco}</Meta>
        <Meta label="Ratings">
          {game.whiteElo || game.blackElo
            ? `${game.whiteElo ?? '?'} / ${game.blackElo ?? '?'}`
            : undefined}
        </Meta>
        <Meta label="Time control">{game.timeControl ?? speedLabel(game)}</Meta>
        <Meta label="Length">{`${Math.ceil(game.plies / 2)} moves`}</Meta>
        <Meta label="From">{game.source}</Meta>
      </dl>

      {children && <div className="reveal-actions">{children}</div>}

      <div className="db-moves">
        {moves.map((san, ply) => (
          <span key={ply} className="db-move">
            {ply % 2 === 0 && <span className="db-movenum mono">{ply / 2 + 1}.</span>}
            <span className="mono">{san}</span>
            {game.comments?.[ply] && <span className="db-comment">{game.comments[ply]}</span>}
          </span>
        ))}
      </div>
      {game.comments && (
        <p className="table-note">
          Comments are the file&apos;s own, kept as they were written. The one thing dropped is
          the machine data an export writes into them — clock readings, another engine&apos;s
          evaluations, arrows — which is nobody&apos;s annotation.
        </p>
      )}
    </>
  )
}

/** "unknown" is what the file said, so say that rather than leaving a hole. */
const speedLabel = (game: DbGame) =>
  game.speed === 'unknown' ? 'not stated in the file' : game.speed

function Meta({ label, children }: { label: string; children?: React.ReactNode }) {
  if (!children) return null
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  )
}

// ---------- what is attached ----------

function AttachedSources({
  sources,
  total,
  onDetach,
}: {
  sources: DbSource[]
  total: number
  onDetach: (s: DbSource) => Promise<void>
}) {
  if (sources.length === 0) return null
  return (
    <>
      <h2 className="section-title">
        Attached ({count(total)} {total === 1 ? 'game' : 'games'})
      </h2>
      <div className="table-wrap">
        <table className="games-table">
          <thead>
            <tr>
              {/* A file you attached or an account you synced — both are sources. */}
              <th scope="col">Source</th>
              <th scope="col">Attached</th>
              <th scope="col" className="num">
                Games
              </th>
              <th scope="col" className="num">
                Skipped
              </th>
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {sources.map((s) => (
              <tr key={s.name}>
                <td>{s.name}</td>
                <td>{new Date(s.importedAt).toLocaleDateString()}</td>
                <td className="num mono">{count(s.games)}</td>
                <td className="num mono">{count(s.skipped)}</td>
                <td className="row-actions">
                  <button
                    className="btn ghost danger"
                    type="button"
                    onClick={() => void onDetach(s)}
                    aria-label={`Detach ${s.name}`}
                    title="Detach this database"
                  >
                    ✕
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

// ---------- where to get games ----------

/**
 * Where to find a database, including where *not* to (ADR 0018 §5).
 *
 * "Attach your own PGN" is only honest advice if we say where one comes from,
 * and the dead ends are the most useful half of the list: every stale blog post
 * about free chess databases still points at Caissabase, whose domain lapsed and
 * now redirects to a crypto-casino affiliate. Naming it here is what stops
 * someone following that link from somewhere else. It is deliberately **not**
 * linked; the live sources are (docs/spikes/games-corpus.md §2).
 *
 * Open by default while there is nothing attached, because then this is the most
 * useful thing on the screen.
 */
function SourceGuidance({ empty }: { empty: boolean }) {
  return (
    <details className="source-guidance" open={empty}>
      <summary>Where to find games</summary>
      <p className="table-note">
        étude redistributes nothing — these are places you may lawfully get a database for
        yourself, with what each one actually permits.
      </p>
      <ul className="source-list">
        <li>
          <a href="https://lumbrasgigabase.com/en/" target="_blank" rel="noreferrer noopener">
            Lumbra&apos;s Gigabase
          </a>{' '}
          — 10M+ <b>over-the-board</b> games, updated monthly, <b>CC BY-NC-SA 4.0</b>. The only
          cleanly-licensed maintained OTB corpus there is, and the one to start with. The
          non-commercial clause is no obstacle here: this project is permanently open and
          non-commercial.
        </li>
        <li>
          <a href="https://theweekinchess.com/" target="_blank" rel="noreferrer noopener">
            The Week in Chess
          </a>{' '}
          — weekly tournament PGN since 1994, <b>free for personal use only, all rights
          reserved</b>. Fine for your own copy on your own machine; not something anyone may
          pass on, which is exactly why we don&apos;t.
        </li>
        <li>
          <a href="https://database.lichess.org/" target="_blank" rel="noreferrer noopener">
            The Lichess open database
          </a>{' '}
          — <b>CC0</b>, so it is yours to do anything with. It is <em>online</em> play though,
          mostly blitz and rapid, which the default filters are set to drop; raise the minimum
          rating and lower the minimum clock if you want it anyway. Your own export from
          Lichess or chess.com is what <b>My own games</b> is for.
        </li>
      </ul>
      <p className="table-note">
        <b>Dead ends, so you don&apos;t waste an evening.</b> Caissabase is gone — its domain
        lapsed and now redirects to a crypto-casino affiliate, so don&apos;t follow a link to
        it from anywhere. KingBase and Millionbase are both down, and neither ever stated a
        licence. The &ldquo;masters&rdquo; set behind the Lichess opening explorer is not part
        of the CC0 dump and isn&apos;t downloadable.
      </p>
    </details>
  )
}

/**
 * The honest note about durability.
 *
 * An imported database must never be the only copy: Safari evicts
 * script-written storage after about a week without a visit, and asking for
 * persistence is the exemption, not a guarantee we were granted it. So we say
 * which of the two happened, and keep the original file the thing to go back to.
 */
function ReimportNote({
  storage,
  persisted,
}: {
  storage: StorageStatus | null
  persisted?: boolean
}) {
  const granted = persisted ?? storage?.persisted
  return (
    <p className="storage-note">
      <b>Keep the PGN file.</b> An attached database lives in this browser, so re-attaching the
      file is the way back from a cleared browser, another machine, or a different profile —
      importing the same file again updates what is here instead of duplicating it. A synced
      chess.com account needs no file: syncing again refetches it, and lands on the same rows.
      {storage?.supported && (
        <>
          {' '}
          {granted
            ? 'This origin has been granted persistent storage.'
            : 'This origin does not have persistent storage, so the browser may clear it — Safari after about a week without a visit.'}
        </>
      )}
      {storage?.usageBytes != null && <> · {formatBytes(storage.usageBytes)} used</>}
    </p>
  )
}
