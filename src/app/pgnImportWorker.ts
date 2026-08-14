/**
 * PGN import Web Worker — parsing and filtering off the main thread (#53, §9).
 *
 * Parsing a few hundred megabytes of PGN is seconds to minutes of solid CPU. On
 * the main thread that is a frozen tab with a spinner that cannot spin, so the
 * work happens here and the UI only ever handles finished batches.
 *
 * Protocol (postMessage):
 *   in  { type:'import', file, filters }   → out { type:'batch', id, games }
 *   in  { type:'ack', id }                    ↳ resumes reading after that batch
 *                                          → out { type:'progress', progress }
 *                                          → out { type:'done', progress }
 *   any failure                            → out { type:'error', message }
 *
 * **The ack is load-bearing.** Batches are handed over one at a time and the
 * worker stops reading until the main thread confirms it has stored one.
 * Without that a fast parser queues an entire database in memory while the
 * slower IndexedDB writer works through it — which is precisely the shape of
 * import this feature exists to survive.
 *
 * Writing happens on the main thread rather than here: one Dexie connection, one
 * place that knows the schema, and `navigator.storage.persist()` — which is a
 * window API — asked for in the same flow.
 */

import type { ImportFilters } from '../domain/pgnImport'
import { streamPgn, type ImportProgress } from '../content/pgnImport'
import { toDbGame, type DbGame } from '../persist/dbGames'

export interface ImportRequest {
  type: 'import'
  file: File
  filters: ImportFilters
}

export interface BatchAck {
  type: 'ack'
  id: number
}

export type ImportCommand = ImportRequest | BatchAck

export type ImportEvent =
  | { type: 'batch'; id: number; games: DbGame[] }
  | { type: 'progress'; progress: ImportProgress }
  | { type: 'done'; progress: ImportProgress }
  | { type: 'error'; message: string }

/** How often to report progress. Per chunk would be thousands of messages a second. */
export const PROGRESS_INTERVAL_MS = 200

const post = (event: ImportEvent) => (self as unknown as Worker).postMessage(event)

/** Batches waiting for the main thread to confirm it has stored them. */
const waiting = new Map<number, () => void>()
let nextBatchId = 0

async function run(request: ImportRequest): Promise<void> {
  const importedAt = Date.now()
  const source = request.file.name
  let lastReport = 0

  try {
    const progress = await streamPgn(request.file, {
      filters: request.filters,
      onBatch: (records) => {
        const id = ++nextBatchId
        const games = records.map(({ game, facts }) =>
          toDbGame(game, facts, { source, importedAt }),
        )
        return new Promise<void>((resolve) => {
          waiting.set(id, resolve)
          post({ type: 'batch', id, games })
        })
      },
      onProgress: (progress) => {
        const now = Date.now()
        if (now - lastReport < PROGRESS_INTERVAL_MS) return
        lastReport = now
        post({ type: 'progress', progress })
      },
    })
    post({ type: 'done', progress })
  } catch (e) {
    // Only a broken *stream* gets here — bad games are counted, not thrown.
    post({ type: 'error', message: e instanceof Error ? e.message : 'could not read the file' })
  }
}

self.onmessage = (e: MessageEvent<ImportCommand>) => {
  const command = e.data
  if (command?.type === 'ack') {
    waiting.get(command.id)?.()
    waiting.delete(command.id)
    return
  }
  if (command?.type === 'import') void run(command)
}
