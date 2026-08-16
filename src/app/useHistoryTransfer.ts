/**
 * Moving your history between browsers, profiles and machines (#152).
 *
 * The screen half of the archive. The format and the merge rules are pure
 * (`domain/historyArchive.ts`); the reads and writes are in
 * `persist/historyArchive.ts`; this owns the two things that are neither — a
 * `File` on the way in, a `Blob` on the way out — and the state a screen
 * renders.
 *
 * **An import reads the file twice, on purpose.** Pass one parses every line and
 * checks the header's version, that every record is one we know how to file, and
 * that the footer is there and agrees with what was in front of it. Only then
 * does pass two write anything. The alternative — write as you go and report how
 * far you got — is the thing the issue rules out: a half-imported training
 * history is worse than a refused file, because there is no way to tell from the
 * inside which half arrived. A second read of a `File` costs disk, not memory:
 * the file was never held in the first place.
 *
 * The one failure that *can* land half-applied is storage running out, and it is
 * reported as itself rather than dressed up as a refusal — the same rule
 * `dbGames.ts` follows, for the same reason: at 40k of 100k games written, the
 * user has to be told which it was.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  NO_FOOTER,
  countMismatch,
  emptyCounts,
  isEmptyReport,
  readBodyLine,
  readHeader,
  type ArchiveCounts,
  type ArchiveHeader,
  type ArchiveRecord,
  type MergeReport,
  type Read,
} from '../domain/historyArchive'
import {
  applyArchive,
  archiveLines,
  estimateArchive,
  type ArchiveEstimate,
  type ExportOptions,
} from '../persist/historyArchive'
import { warmSearchIndex } from '../persist/searchIndex'
import { version as APP_VERSION } from '../../package.json'

/** Anything we can stream bytes out of — a `File`, a `Blob`, or a test double. */
export interface ByteSource {
  stream(): ReadableStream<Uint8Array>
  size?: number
}

/**
 * Text held before it becomes a `Blob` part.
 *
 * Folding the lines into `Blob`s as they are produced is what keeps a large
 * export off the JS heap: a `Blob` is a handle the browser owns and may spill to
 * disk, whereas an array of a million strings is a million strings. 4 MB is
 * large enough that the folding is free and small enough that nothing is ever
 * held twice at any size worth caring about.
 */
const BLOB_PART_BYTES = 4 * 1024 * 1024

// ---------- reading a file, a line at a time ----------

/**
 * The lines of a file, without ever holding the file.
 *
 * The same shape as `content/pgnImport.ts`'s reader and for the same reason — a
 * user's data can be larger than memory. Blank lines are skipped so an editor
 * that added a trailing newline cannot make a file unreadable.
 */
export async function* readLines(
  source: ByteSource,
  onBytes?: (bytes: number) => void,
): AsyncGenerator<string> {
  const reader = source.stream().getReader()
  const decoder = new TextDecoder('utf-8')
  // A line, and a multi-byte character, can each straddle a chunk boundary. The
  // decoder handles the character; `pending` holds the line.
  let pending = ''
  let read = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      read += value.byteLength
      onBytes?.(read)
      const text = pending + decoder.decode(value, { stream: true })
      const lines = text.split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) if (line.trim()) yield line
    }
  } finally {
    reader.releaseLock()
  }
  const tail = pending + decoder.decode()
  if (tail.trim()) yield tail
}

// ---------- pass one: is this a file we understand? ----------

export interface ArchiveCheck {
  header: ArchiveHeader
  /** What the footer says is in it, having verified that it is. */
  counts: ArchiveCounts
}

/**
 * Read the whole file and decide whether it may be applied. Writes nothing.
 *
 * Every refusal is a sentence the user can act on, and every one of them ends by
 * saying that nothing was imported — because the natural fear on seeing an error
 * from an import is that it got half way.
 */
export async function checkArchive(
  source: ByteSource,
  onBytes?: (bytes: number) => void,
): Promise<Read<ArchiveCheck>> {
  let header: ArchiveHeader | null = null
  const found = emptyCounts()
  let footer: ArchiveCounts | null = null

  for await (const line of readLines(source, onBytes)) {
    if (!header) {
      const read = readHeader(line)
      if (!read.ok) return read
      header = read.value
      continue
    }
    if (footer) {
      return {
        ok: false,
        error:
          'This history file carries more than one end marker, so it is not a single export. Nothing has been imported.',
      }
    }
    const read = readBodyLine(line)
    if (!read.ok) return read
    if ('end' in read.value) {
      footer = read.value.counts
      continue
    }
    found[read.value.t]++
  }

  if (!header) {
    return {
      ok: false,
      error: 'This file is empty. Nothing has been imported.',
    }
  }
  if (!footer) return { ok: false, error: NO_FOOTER }
  for (const section of Object.keys(found) as (keyof ArchiveCounts)[]) {
    if (footer[section] !== found[section]) {
      return { ok: false, error: countMismatch(section, footer[section], found[section]) }
    }
  }
  return { ok: true, value: { header, counts: found } }
}

/**
 * Pass two: the records, header and footer stripped.
 *
 * Re-validates every line rather than trusting pass one, which costs a `JSON.parse`
 * we have already paid for and removes the class of bug where the two passes
 * disagree about what a line is.
 */
async function* archiveRecords(source: ByteSource): AsyncGenerator<ArchiveRecord> {
  let first = true
  for await (const line of readLines(source)) {
    if (first) {
      first = false
      continue
    }
    const read = readBodyLine(line)
    if (!read.ok) throw new Error(read.error)
    if ('end' in read.value) return
    yield read.value
  }
}

// ---------- building the file ----------

/** The export, as a `Blob` the browser can hand to a download. */
export async function buildArchive(
  options: ExportOptions,
  createdAt: number,
  app = APP_VERSION,
): Promise<Blob> {
  const parts: BlobPart[] = []
  let pending: string[] = []
  let bytes = 0
  for await (const line of archiveLines(options, createdAt, app)) {
    pending.push(line, '\n')
    bytes += line.length + 1
    if (bytes >= BLOB_PART_BYTES) {
      parts.push(new Blob(pending))
      pending = []
      bytes = 0
    }
  }
  if (pending.length) parts.push(new Blob(pending))
  // NDJSON rather than `application/json`: it is one JSON value per line, and
  // saying so is the difference between a file a tool can stream and one it
  // will try to parse whole.
  return new Blob(parts, { type: 'application/x-ndjson' })
}

/** `etude-history-2026-08-15.jsonl` — sortable, and it says what it is. */
export function archiveFileName(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `etude-history-${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}.jsonl`
}

// ---------- the hook ----------

export type ExportStatus = 'idle' | 'preparing' | 'ready' | 'error'

export interface PreparedArchive {
  url: string
  name: string
  bytes: number
}

export interface ExportState {
  status: ExportStatus
  file?: PreparedArchive
  error?: string
}

export type HistoryImportStatus = 'idle' | 'checking' | 'importing' | 'done' | 'error'

export interface HistoryImportState {
  status: HistoryImportStatus
  fileName?: string
  /** Bytes read so far, and the file's size, so a large import isn't a frozen tab. */
  bytesRead: number
  totalBytes?: number
  /** What the file turned out to hold, once pass one accepted it. */
  counts?: ArchiveCounts
  /** What the merge did. Present even when storage gave out part-way. */
  report?: MergeReport
  error?: string
}

const IDLE_IMPORT: HistoryImportState = { status: 'idle', bytesRead: 0 }

export interface HistoryTransfer {
  /** What is on this device and roughly what it weighs. `null` until it is read. */
  estimate: ArchiveEstimate | null
  exportState: ExportState
  /** Build the file. The size is stated before it is saved, never after. */
  prepare: (options: ExportOptions) => void
  /** Throw the prepared file away — it is a live object URL until it is. */
  discard: () => void
  importState: HistoryImportState
  importFile: (file: File) => void
  /** Bumped when an import finishes, so a listing can re-read itself. */
  completed: number
}

export function useHistoryTransfer(): HistoryTransfer {
  const [estimate, setEstimate] = useState<ArchiveEstimate | null>(null)
  const [exportState, setExportState] = useState<ExportState>({ status: 'idle' })
  const [importState, setImportState] = useState<HistoryImportState>(IDLE_IMPORT)
  const [completed, setCompleted] = useState(0)
  // The live object URL, outside state: it has to be revoked from a cleanup that
  // must not re-run because a render happened.
  const url = useRef<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void estimateArchive().then((e) => {
      if (!cancelled) setEstimate(e)
    })
    return () => {
      cancelled = true
    }
  }, [completed])

  const release = useCallback(() => {
    if (url.current) URL.revokeObjectURL(url.current)
    url.current = null
  }, [])

  useEffect(() => release, [release])

  const discard = useCallback(() => {
    release()
    setExportState({ status: 'idle' })
  }, [release])

  const prepare = useCallback(
    (options: ExportOptions) => {
      release()
      setExportState({ status: 'preparing' })
      const at = new Date()
      void buildArchive(options, at.getTime())
        .then((blob) => {
          url.current = URL.createObjectURL(blob)
          setExportState({
            status: 'ready',
            file: { url: url.current, name: archiveFileName(at), bytes: blob.size },
          })
        })
        .catch((e: unknown) => {
          setExportState({
            status: 'error',
            error: `The export could not be built (${e instanceof Error ? e.message : 'unknown error'}).`,
          })
        })
    },
    [release],
  )

  const importFile = useCallback((file: File) => {
    setImportState({
      status: 'checking',
      fileName: file.name,
      bytesRead: 0,
      totalBytes: file.size,
    })
    void (async () => {
      try {
        const checked = await checkArchive(file, (bytesRead) =>
          setImportState((s) => (s.status === 'checking' ? { ...s, bytesRead } : s)),
        )
        if (!checked.ok) {
          setImportState((s) => ({ ...s, status: 'error', bytesRead: 0, error: checked.error }))
          return
        }
        setImportState((s) => ({
          ...s,
          status: 'importing',
          bytesRead: 0,
          counts: checked.value.counts,
        }))
        const { report, error } = await applyArchive(archiveRecords(file))
        // The vocabulary may have grown; a search issued now waits for the same
        // build, so nothing is held behind this.
        void warmSearchIndex()
        setCompleted((n) => n + 1)
        setImportState((s) => ({
          ...s,
          status: error ? 'error' : 'done',
          report,
          ...(error ? { error: `${error} Everything imported before that point was saved.` } : {}),
        }))
      } catch (e: unknown) {
        setImportState((s) => ({
          ...s,
          status: 'error',
          error: `This history file could not be read (${e instanceof Error ? e.message : 'unknown error'}).`,
        }))
      }
    })()
  }, [])

  return { estimate, exportState, prepare, discard, importState, importFile, completed }
}

/** Whether a finished import found nothing at all to do. */
export const importedNothing = (state: HistoryImportState): boolean =>
  state.status === 'done' && !!state.report && isEmptyReport(state.report)
