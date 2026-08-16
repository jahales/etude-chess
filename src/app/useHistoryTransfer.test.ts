// The two-pass import (#152): what a file has to look like before a single row
// is written, and the proof that a refused file writes none.
//
// `fake-indexeddb/auto` must run before anything imports persist/db.ts, which
// decides once at first call whether IndexedDB exists.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import Dexie from 'dexie'
import { getDb } from '../persist/db'
import {
  archiveFileName,
  buildArchive,
  checkArchive,
  readLines,
  useHistoryTransfer,
  type ByteSource,
} from './useHistoryTransfer'

// ---------- fixtures ----------

const header = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ format: 'etude-chess-history', version: 1, createdAt: 1, app: 'test', ...over })

const attemptLine = (reason: string) =>
  JSON.stringify({
    t: 'attempt',
    r: { gameId: 'g', sessionId: 's', createdAt: 1, reason, tier: 'A', swing: 0 },
  })

const footer = (over: Partial<Record<string, number>> = {}) =>
  JSON.stringify({
    end: 'etude-chess-history',
    counts: { attempt: 1, game: 0, dbSource: 0, dbGame: 0, dbAnalysis: 0, ...over },
  })

const file = (lines: string[]): ByteSource => {
  const bytes = new TextEncoder().encode(lines.join('\n') + '\n')
  return {
    size: bytes.byteLength,
    stream: () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          // Two chunks, split mid-file, so a line straddling a boundary is
          // exercised on every test rather than only when one happens to.
          const half = Math.ceil(bytes.byteLength / 2)
          controller.enqueue(bytes.slice(0, half))
          controller.enqueue(bytes.slice(half))
          controller.close()
        },
      }),
  }
}

const asFile = (source: ByteSource, name = 'history.jsonl') =>
  Object.assign(source, { name }) as unknown as File

const GOOD = [header(), attemptLine('a real reason'), footer()]

/** jsdom implements neither half of the object-URL API the download link needs. */
const createObjectURL = vi.fn(() => 'blob:test')
beforeEach(() => {
  createObjectURL.mockClear()
  vi.stubGlobal('URL', { createObjectURL, revokeObjectURL: vi.fn() })
})

/** jsdom's Blob has no `text()`; FileReader is the way to read one there. */
const textOf = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsText(blob)
  })

beforeEach(async () => {
  const d = new Dexie('etude-chess')
  try {
    await d.open()
    await Promise.all(d.tables.map((t) => t.clear()))
  } catch {
    // First run: the database has not been created yet.
  } finally {
    d.close()
  }
})

// ---------- reading ----------

describe('reading a history file', () => {
  it('yields whole lines across chunk boundaries and skips blank ones', async () => {
    const lines: string[] = []
    for await (const line of readLines(file(['one', '', 'two', 'three']))) lines.push(line)
    expect(lines).toEqual(['one', 'two', 'three'])
  })

  it('reports progress in bytes, so a large file is not a frozen tab', async () => {
    const seen: number[] = []
    for await (const _ of readLines(file(GOOD), (n) => seen.push(n))) void _
    expect(seen.length).toBeGreaterThan(1)
    expect(seen[seen.length - 1]).toBe(file(GOOD).size)
  })
})

// ---------- pass one ----------

describe('checking a file before importing it', () => {
  it('accepts a well-formed archive and reports what is in it', async () => {
    const checked = await checkArchive(file(GOOD))
    expect(checked.ok).toBe(true)
    expect(checked.ok === true && checked.value.counts.attempt).toBe(1)
    expect(checked.ok === true && checked.value.header.app).toBe('test')
  })

  it('refuses a truncated file, which is the failure a footer exists to catch', async () => {
    // A stopped download, a full disk, an interrupted copy. Without an end
    // marker there is no way to tell one of those from a complete export.
    const checked = await checkArchive(file([header(), attemptLine('a')]))
    expect(checked.ok).toBe(false)
    expect(checked.ok === false && checked.error).toMatch(/ends part-way through/)
    expect(checked.ok === false && checked.error).toMatch(/no end marker/)
  })

  it('refuses a file whose body does not match its own footer', async () => {
    // The subtler truncation: the file ends in the right shape but is missing
    // records out of the middle of it.
    const checked = await checkArchive(file([header(), footer({ attempt: 12 })]))
    expect(checked.ok).toBe(false)
    expect(checked.ok === false && checked.error).toMatch(/says it holds 12 attempt records/)
  })

  it('refuses a version it does not understand', async () => {
    const checked = await checkArchive(file([header({ version: 2 }), footer({ attempt: 0 })]))
    expect(checked.ok).toBe(false)
    expect(checked.ok === false && checked.error).toMatch(/newer version of étude/)
  })

  it('refuses something that is not a history file at all', async () => {
    const checked = await checkArchive(file(['[Event "Paris"]', '1. e4 e5']))
    expect(checked.ok).toBe(false)
    expect(checked.ok === false && checked.error).toMatch(/not an étude history file/)
  })

  it('refuses an empty file rather than treating it as an empty history', async () => {
    const checked = await checkArchive(file(['']))
    expect(checked.ok).toBe(false)
    expect(checked.ok === false && checked.error).toMatch(/empty/)
  })

  it('refuses two exports concatenated into one file', async () => {
    const checked = await checkArchive(file([...GOOD, ...GOOD]))
    expect(checked.ok).toBe(false)
    expect(checked.ok === false && checked.error).toMatch(/more than one end marker/)
  })
})

// ---------- the hook ----------

describe('the transfer hook', () => {
  it('writes nothing at all when the file is refused', async () => {
    // The requirement, and the reason for reading the file twice: a training
    // history missing an unknown fraction of itself is worse than one that
    // never arrived.
    const { result } = renderHook(() => useHistoryTransfer())
    act(() => result.current.importFile(asFile(file([header(), attemptLine('a')]))))

    await waitFor(() => expect(result.current.importState.status).toBe('error'))
    expect(result.current.importState.error).toMatch(/ends part-way through/)
    expect(result.current.importState.report).toBeUndefined()
    expect(await getDb()!.attempts.count()).toBe(0)
  })

  it('imports an accepted file and reports what it did', async () => {
    const { result } = renderHook(() => useHistoryTransfer())
    act(() => result.current.importFile(asFile(file(GOOD))))

    await waitFor(() => expect(result.current.importState.status).toBe('done'))
    expect(result.current.importState.report?.sections.attempt.added).toBe(1)
    expect(result.current.importState.counts?.attempt).toBe(1)
    expect(await getDb()!.attempts.count()).toBe(1)
  })

  it('builds a file whose size is known before it is saved', async () => {
    // "State the size before writing it": the exact figure ends up on the
    // control that writes the file, so it is still actionable.
    const { result } = renderHook(() => useHistoryTransfer())

    act(() => result.current.prepare({ includeDatabase: true }))
    await waitFor(() => expect(result.current.exportState.status).toBe('ready'))

    expect(result.current.exportState.file?.bytes).toBeGreaterThan(0)
    expect(result.current.exportState.file?.name).toMatch(/^etude-history-\d{4}-\d{2}-\d{2}\.jsonl$/)
    expect(createObjectURL).toHaveBeenCalled()
  })
})

describe('the file it writes', () => {
  it('is one JSON value per line, header first and footer last', async () => {
    const blob = await buildArchive({ includeDatabase: true }, 1_700_000_000_000, 'test')
    const lines = (await textOf(blob)).trim().split('\n')
    expect(JSON.parse(lines[0]!)).toMatchObject({ format: 'etude-chess-history', version: 1 })
    expect(JSON.parse(lines[lines.length - 1]!)).toMatchObject({ end: 'etude-chess-history' })
  })

  it('is named so it sorts by date and says what it is', () => {
    expect(archiveFileName(new Date(2026, 7, 15))).toBe('etude-history-2026-08-15.jsonl')
  })
})
