/**
 * Attaching a PGN database: the side of the import that touches the browser.
 *
 * Owns the parsing Worker, writes each batch it sends back, and keeps the state
 * the import screen renders. The rules it applies are pure and live in
 * `domain/pgnImport.ts`; the streaming is in `content/pgnImport.ts`.
 *
 * Two things happen here and nowhere else:
 *
 * - **`navigator.storage.persist()` is asked for when a database is first
 *   attached.** That request is what exempts the origin from Safari's ~7-day
 *   eviction of script-written storage, and it is a *window* API — a worker
 *   cannot make it. Being refused is not a failure: the screen says so, and
 *   re-attaching is designed to be easy (ADR 0018, §9).
 * - **Every batch is acknowledged after it is stored**, which is what stops the
 *   parser running ahead of the writer and buffering a whole database.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { DEFAULT_IMPORT_FILTERS, type ImportFilters } from '../domain/pgnImport'
import type { ImportProgress } from '../content/pgnImport'
import { putDbGames, recordDbSource } from '../persist/dbGames'
import { warmSearchIndex } from '../persist/searchIndex'
import { ensurePersistence } from '../persist/storage'
import type { ImportEvent } from './pgnImportWorker'

export type ImportStatus = 'idle' | 'importing' | 'done' | 'error'

export interface ImportState {
  status: ImportStatus
  /** The file being read, or the last one read. */
  fileName?: string
  progress: ImportProgress
  /** Games actually written — below `progress.kept` if storage gave out. */
  written: number
  error?: string
  /**
   * Whether the browser granted persistent storage, once we've asked. Reported
   * rather than assumed: the library already learned not to look permanent when
   * it isn't.
   */
  persisted?: boolean
}

const EMPTY_PROGRESS: ImportProgress = {
  parsed: 0,
  kept: 0,
  skipped: 0,
  bytesRead: 0,
  skippedByReason: {},
}

const IDLE: ImportState = { status: 'idle', progress: EMPTY_PROGRESS, written: 0 }

/** Minimal surface of a Worker, so a test can supply one without a bundler. */
export interface ImportWorker {
  postMessage(message: unknown): void
  terminate(): void
  onmessage: ((event: MessageEvent<ImportEvent>) => void) | null
  onerror: ((event: { message?: string }) => void) | null
}

export type ImportWorkerFactory = () => ImportWorker

const defaultWorkerFactory: ImportWorkerFactory = () =>
  new Worker(new URL('./pgnImportWorker.ts', import.meta.url), {
    type: 'module',
  }) as unknown as ImportWorker

export interface PgnImport {
  state: ImportState
  /** Attach a file. Ignored while another import is running. */
  attach: (file: File, filters?: ImportFilters) => void
  /** Stop an import in progress. What was already stored stays stored. */
  cancel: () => void
  /** Bumped whenever an import finishes, so a listing can re-read itself. */
  completed: number
}

export function usePgnImport(createWorker: ImportWorkerFactory = defaultWorkerFactory): PgnImport {
  const [state, setState] = useState<ImportState>(IDLE)
  const [completed, setCompleted] = useState(0)
  const worker = useRef<ImportWorker | null>(null)
  // Written games are tallied outside React state: batches land faster than
  // renders, and each one needs the running total, not the last rendered one.
  const written = useRef(0)

  const stop = useCallback(() => {
    worker.current?.terminate()
    worker.current = null
  }, [])

  // A worker outlives a render but must not outlive the screen.
  useEffect(() => stop, [stop])

  const attach = useCallback(
    (file: File, filters: ImportFilters = DEFAULT_IMPORT_FILTERS) => {
      if (worker.current) return
      written.current = 0
      setState({ status: 'importing', fileName: file.name, progress: EMPTY_PROGRESS, written: 0 })

      // Ask now, while the user is deliberately attaching something: browsers
      // weigh engagement, and this is the most engaged moment there is.
      void ensurePersistence().then((persisted) => setState((s) => ({ ...s, persisted })))

      const w = createWorker()
      worker.current = w

      w.onerror = (event) => {
        stop()
        setState((s) => ({ ...s, status: 'error', error: event.message ?? 'the importer failed' }))
      }

      w.onmessage = (event: MessageEvent<ImportEvent>) => {
        const message = event.data
        if (message.type === 'progress') {
          setState((s) => ({ ...s, progress: message.progress, written: written.current }))
          return
        }
        if (message.type === 'batch') {
          void putDbGames(message.games).then((result) => {
            written.current += result.written
            // Acknowledge even a failed write: the worker is blocked until we
            // do, and stopping the import is the caller's decision below.
            w.postMessage({ type: 'ack', id: message.id })
            if (result.error) {
              stop()
              setState((s) => ({
                ...s,
                status: 'error',
                written: written.current,
                error: `Storage stopped accepting games (${result.error}). ${written.current} were saved.`,
              }))
            }
          })
          return
        }
        if (message.type === 'error') {
          stop()
          setState((s) => ({ ...s, status: 'error', error: message.message }))
          return
        }
        // Done: record what was attached so the screen can list it and offer to
        // re-attach — an import is never treated as the only copy (§9).
        stop()
        const progress = message.progress
        setState((s) => ({ ...s, status: 'done', progress, written: written.current }))
        void recordDbSource({
          name: file.name,
          importedAt: Date.now(),
          games: written.current,
          parsed: progress.parsed,
          skipped: progress.skipped,
          ...(progress.totalBytes === undefined ? {} : { sizeBytes: progress.totalBytes }),
        }).then(() => {
          setCompleted((n) => n + 1)
          // Rebuild the search index over the vocabulary the import just changed
          // (§10: build it after import and persist it), but **do not hold the
          // listing behind it**. A search issued while it is still building
          // waits for it — `expandTerms` awaits the same build — so the only
          // difference is that the games appear as soon as they are stored
          // rather than when the index catches up.
          void warmSearchIndex()
        })
      }

      w.postMessage({ type: 'import', file, filters })
    },
    [createWorker, stop],
  )

  const cancel = useCallback(() => {
    if (!worker.current) return
    stop()
    setState((s) => ({ ...s, status: 'idle' }))
  }, [stop])

  return { state, attach, cancel, completed }
}
