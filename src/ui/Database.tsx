/**
 * Attach your own game database (#53, ADR 0018).
 *
 * We ship no corpus — that is the decision that makes this legally clean — so
 * this screen's whole job is to take a PGN file the user already has, show
 * honestly what will be kept and what will be dropped, and say plainly that an
 * import is never the only copy of anything.
 *
 * Browsing and searching what has been attached is item 10 and lands separately.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  DEFAULT_IMPORT_FILTERS,
  SKIP_REASON_LABEL,
  type ImportFilters,
  type SkipReason,
} from '../domain/pgnImport'
import { usePgnImport } from '../app/usePgnImport'
import { countDbGames, deleteDbSource, listDbSources, type DbSource } from '../persist/dbGames'
import { formatBytes, storageStatus, type StorageStatus } from '../persist/storage'

const count = (n: number) => n.toLocaleString()

export function GameDatabase() {
  const [filters, setFilters] = useState<ImportFilters>(DEFAULT_IMPORT_FILTERS)
  const { state, attach, cancel, completed } = usePgnImport()
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
  }, [reload, completed])

  const importing = state.status === 'importing'

  const pick = useCallback(
    (file: File | undefined) => {
      if (file) attach(file, filters)
    },
    [attach, filters],
  )

  const detach = async (source: DbSource) => {
    const ok = window.confirm(
      `Detach ${source.name} and remove its ${count(source.games)} games? You can attach the file again at any time.`,
    )
    if (!ok) return
    await deleteDbSource(source.name)
    setReload((n) => n + 1)
  }

  return (
    <>
      <p className="lede">
        étude ships no game database. Attach a PGN file you already have and it is parsed and
        indexed <em>on this device</em> — nothing is uploaded, and nothing is redistributed.
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

      <AttachedSources sources={sources} total={total} onDetach={detach} />
      <ReimportNote storage={storage} persisted={state.persisted} />
    </>
  )
}

// ---------- filters ----------

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
          time controls — lower the minimum rating above and attach it again.
        </p>
      )}
    </div>
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
              <th scope="col">File</th>
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
      importing the same file again updates what is here instead of duplicating it.
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
