/**
 * Syncing your chess.com games: what happens between the API and IndexedDB
 * (#145).
 *
 * The rules are pure (`domain/chesscom.ts`), the fetching streams month by month
 * (`content/chesscom.ts`), and this is the part that stores what comes back —
 * through `toDbGame` → `putDbGames`, the same path an attached PGN file takes.
 * There is no second import path, which is why a game fetched from chess.com and
 * the same game exported by hand land on the *same row*: the dedup key (#128) is
 * computed from the game, not from where it came from.
 *
 * Four things happen here and nowhere else:
 *
 * - **A month is only recorded as done once its games are stored.** The record
 *   is what stops us re-fetching it, so writing it before the write lands would
 *   turn a full disk into a permanently missing month.
 * - **How many games were already there is counted before the write**, because
 *   `bulkPut` cannot tell you afterwards — see `existingDbGameKeys`. Without it
 *   a second sync reports every game it re-fetched as freshly imported.
 * - **`navigator.storage.persist()` is asked for**, exactly as the file import
 *   does, and for the same reason: this is the most engaged moment there is, and
 *   it is a window API a worker could not call.
 * - **The handle is added to the names you play under** (#130), because a game
 *   imported under your handle that the app does not recognise as yours opens
 *   from the wrong side. Added, never replacing what is there.
 *
 * Nothing in here runs by itself. `sync` is called from a button and from
 * nowhere else — an app that re-synced on every load would be a free public API
 * being asked for a decade of PGN because someone refreshed a tab.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  canonicalUser,
  chesscomSourceName,
  isUsableUser,
  type SyncedMonth,
  type TimeClass,
} from '../domain/chesscom'
import {
  ChesscomError,
  CHESSCOM_FAILURE_MESSAGE,
  syncChesscomGames,
  type ChesscomFailure,
  type SyncProgress,
} from '../content/chesscom'
import {
  countDbGamesFromSource,
  existingDbGameKeys,
  putDbGames,
  recordDbSource,
  toDbGame,
  type DbGame,
} from '../persist/dbGames'
import { warmSearchIndex } from '../persist/searchIndex'
import { ensurePersistence } from '../persist/storage'
import {
  forgetSyncedMonths,
  loadChesscomAccount,
  monthsFor,
  saveChesscomAccount,
  withSyncedMonth,
  type ChesscomAccount,
} from './chesscomAccount'
import { formatPlayerNames, loadPlayerNames, parsePlayerNames, savePlayerNames } from './settings'

export type SyncStatus = 'idle' | 'syncing' | 'done' | 'error'

export interface SyncState {
  status: SyncStatus
  /** The handle this run is for, so the summary can name it. */
  user?: string
  progress: SyncProgress
  /** Rows successfully written. Includes games that were already stored. */
  written: number
  /** How many of those rows were already in the database before this sync. */
  alreadyPresent: number
  error?: string
  /** Set when the API itself failed, so the UI can say which failure it was. */
  failure?: ChesscomFailure
  /** Whether the browser granted persistent storage, once we've asked. */
  persisted?: boolean
}

const EMPTY_PROGRESS: SyncProgress = {
  months: 0,
  monthsDone: 0,
  fetched: 0,
  kept: 0,
  skipped: 0,
  skippedByReason: {},
  monthsSkipped: 0,
}

const IDLE: SyncState = {
  status: 'idle',
  progress: EMPTY_PROGRESS,
  written: 0,
  alreadyPresent: 0,
}

export interface ChesscomSync {
  state: SyncState
  /** The handle, classes and synced months remembered from last time. */
  account: ChesscomAccount
  /** Fetch and import. A deliberate action — never called on mount. */
  sync: (user: string, classes: readonly TimeClass[]) => void
  /** Stop between months. What was already stored stays stored. */
  cancel: () => void
  /** Forget which months were pulled, when this account's games are detached. */
  forget: (user: string) => void
  /** Bumped when a sync finishes, so a listing can re-read itself. */
  completed: number
}

export function useChesscomSync(): ChesscomSync {
  const [state, setState] = useState<SyncState>(IDLE)
  const [account, setAccount] = useState<ChesscomAccount>(loadChesscomAccount)
  const [completed, setCompleted] = useState(0)
  const controller = useRef<AbortController | null>(null)
  // The account is written from inside the sync loop, where batches land faster
  // than renders — so the running value lives on a ref and React state follows.
  const accountRef = useRef(account)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      controller.current?.abort()
    }
  }, [])

  const updateAccount = useCallback((next: ChesscomAccount) => {
    accountRef.current = next
    saveChesscomAccount(next)
    setAccount(next)
  }, [])

  const sync = useCallback(
    (rawUser: string, classes: readonly TimeClass[]) => {
      if (controller.current) return
      const user = canonicalUser(rawUser)
      if (!isUsableUser(user)) {
        setState({
          ...IDLE,
          status: 'error',
          error: 'That is not a chess.com handle — letters, digits, - and _ only.',
        })
        return
      }
      if (classes.length === 0) {
        setState({
          ...IDLE,
          status: 'error',
          error: 'Pick at least one time control to import.',
        })
        return
      }

      const abort = new AbortController()
      controller.current = abort
      setState({ ...IDLE, status: 'syncing', user })

      // Remember the handle and the choice now, so a sync that fails halfway
      // still leaves the form filled in the way it was run.
      updateAccount({ ...accountRef.current, user, classes: [...classes] })
      void ensurePersistence().then((persisted) => {
        if (mounted.current) setState((s) => ({ ...s, persisted }))
      })

      const source = chesscomSourceName(user)
      const importedAt = Date.now()
      let written = 0
      let alreadyPresent = 0
      /** Set when storage gave out: no further month may be recorded as done. */
      let storageError: string | undefined

      const storeBatch = async (rows: DbGame[]) => {
        if (rows.length === 0) return
        // Before the write, because `bulkPut` overwrites without reporting which
        // rows it landed on.
        const existing = await existingDbGameKeys(rows.map((r) => r.key))
        const result = await putDbGames(rows)
        // Chunks are written in order, so the rows that made it are the first
        // `result.written` — which keeps the count exact even when a quota error
        // stopped the write half way.
        const stored = rows.slice(0, result.written)
        written += result.written
        alreadyPresent += stored.filter((r) => existing.has(r.key)).length
        if (result.error) storageError = result.error
      }

      void (async () => {
        try {
          const progress = await syncChesscomGames({
            user,
            classes,
            synced: monthsFor(accountRef.current, user),
            signal: abort.signal,
            onBatch: async (records) => {
              await storeBatch(
                records.map(({ game, facts }) => toDbGame(game, facts, { source, importedAt })),
              )
              if (storageError) abort.abort()
              if (mounted.current) setState((s) => ({ ...s, written, alreadyPresent }))
            },
            onMonth: (month: SyncedMonth) => {
              // Only once the month's games are actually stored — otherwise a
              // failed write would leave a month recorded as done and its games
              // permanently missing.
              if (storageError) return
              updateAccount(withSyncedMonth(accountRef.current, user, month))
            },
            onProgress: (progress) => {
              if (mounted.current) setState((s) => ({ ...s, progress, written, alreadyPresent }))
            },
          })

          controller.current = null
          if (storageError) {
            if (mounted.current) {
              setState((s) => ({
                ...s,
                status: 'error',
                progress,
                written,
                alreadyPresent,
                error: `Storage stopped accepting games (${storageError}). ${written} were saved, and the months that stored cleanly will not be fetched again.`,
              }))
            }
            return
          }

          await finishSource(source, progress)
          rememberPlayerName(user)
          if (mounted.current) {
            setState((s) => ({ ...s, status: 'done', progress, written, alreadyPresent }))
            setCompleted((n) => n + 1)
          }
        } catch (e) {
          controller.current = null
          if (!mounted.current) return
          const failure = e instanceof ChesscomError ? e.failure : undefined
          setState((s) => ({
            ...s,
            status: 'error',
            written,
            alreadyPresent,
            ...(failure ? { failure } : {}),
            error: failure
              ? CHESSCOM_FAILURE_MESSAGE[failure]
              : e instanceof Error
                ? e.message
                : 'the sync failed',
          }))
        }
      })()
    },
    [updateAccount],
  )

  const cancel = useCallback(() => {
    if (!controller.current) return
    controller.current.abort()
    controller.current = null
    setState((s) => ({ ...s, status: 'idle' }))
  }, [])

  const forget = useCallback(
    (user: string) => updateAccount(forgetSyncedMonths(accountRef.current, user)),
    [updateAccount],
  )

  return { state, account, sync, cancel, forget, completed }
}

/**
 * Record the account as an attached source, so it lists and detaches like a file.
 *
 * `games` is counted from storage rather than tallied from this run: a sync adds
 * to what is there, unlike re-importing a file, which replaces it. Reporting
 * this run's writes would make the list say "12 games" over a database of 900.
 *
 * The honest caveat, since the row is shown beside a file's: `parsed` and
 * `skipped` describe **the most recent sync**, not the account. Once you are up
 * to date a sync only sees the month you are in, so those two shrink while
 * `games` does not. Accumulating them instead would be worse — re-syncing the
 * current month ten times would count its games ten times.
 */
async function finishSource(source: string, progress: SyncProgress): Promise<void> {
  await recordDbSource({
    name: source,
    importedAt: Date.now(),
    games: await countDbGamesFromSource(source),
    parsed: progress.fetched,
    skipped: progress.skipped,
  })
  // The vocabulary just changed. Not awaited by the listing — a search issued
  // while it builds waits on the same build (see `usePgnImport`).
  void warmSearchIndex()
}

/**
 * Make sure the handle is among the names you play under (#130).
 *
 * Every game just imported has this name on it, so without this the app has a
 * database of your games and no idea which side of them is you — which is the
 * difference between reviewing a game and watching one.
 *
 * Added to the list, never replacing it: the field is the user's, and an export
 * made by hand writes `Lastname, Firstname` rather than a handle, so both
 * spellings have to be able to live there. `parsePlayerNames` drops the repeat
 * if it is already present, so syncing twice does not grow the list.
 */
function rememberPlayerName(user: string): void {
  const names = loadPlayerNames()
  if (names.some((name) => name.toLowerCase() === user)) return
  savePlayerNames(parsePlayerNames(`${formatPlayerNames(names)}\n${user}`))
}
