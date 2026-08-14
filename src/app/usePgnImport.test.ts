// The import hook: what happens between the Worker and IndexedDB.
//
// The Worker itself is faked — jsdom has none, and its contents are already
// covered by content/pgnImport.test.ts. What is worth testing here is the
// orchestration the Worker cannot see: that each batch is stored *and then*
// acknowledged (the back-pressure contract), that persistence is requested when
// a database is attached, and that a full disk stops the import loudly.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import Dexie from 'dexie'
import type { ImportProgress } from '../content/pgnImport'
import { countDbGames, listDbSources, type DbGame } from '../persist/dbGames'
import { usePgnImport, type ImportWorker } from './usePgnImport'
import type { ImportEvent } from './pgnImportWorker'

const game = (key: string): DbGame => ({
  key,
  white: 'Keres, Paul',
  black: 'Fischer, Robert James',
  result: '1-0',
  speed: 'classical',
  plies: 24,
  movetext: 'e4 e5',
  source: 'masters.pgn',
  importedAt: 0,
})

const progress = (over: Partial<ImportProgress> = {}): ImportProgress => ({
  parsed: 2,
  kept: 2,
  skipped: 0,
  bytesRead: 100,
  totalBytes: 100,
  skippedByReason: {},
  ...over,
})

/** A Worker stand-in that records what it was told and can push events back. */
class FakeWorker implements ImportWorker {
  sent: unknown[] = []
  terminated = false
  onmessage: ((event: MessageEvent<ImportEvent>) => void) | null = null
  onerror: ((event: { message?: string }) => void) | null = null

  postMessage(message: unknown) {
    this.sent.push(message)
  }
  terminate() {
    this.terminated = true
  }
  /** Deliver an event as the real worker would, inside React's act(). */
  async emit(event: ImportEvent) {
    await act(async () => {
      this.onmessage?.({ data: event } as MessageEvent<ImportEvent>)
      await Promise.resolve()
    })
  }
  acks() {
    return this.sent.filter((m): m is { type: 'ack'; id: number } => (m as { type: string }).type === 'ack')
  }
}

const file = (name = 'masters.pgn') => new File(['[Event "x"]'], name, { type: 'application/x-chess-pgn' })

let worker: FakeWorker
const render = () => renderHook(() => usePgnImport(() => worker))

beforeEach(async () => {
  worker = new FakeWorker()
  const d = new Dexie('etude-chess')
  try {
    await d.open()
    await Promise.all([d.table('dbGames').clear(), d.table('dbSources').clear()])
  } catch {
    // First run: nothing to clear.
  } finally {
    d.close()
  }
})

afterEach(() => vi.restoreAllMocks())

describe('usePgnImport', () => {
  it('hands the file and the filters to the worker', async () => {
    const { result } = render()
    await act(async () => result.current.attach(file()))

    expect(worker.sent[0]).toMatchObject({ type: 'import', filters: { minBaseSeconds: 600 } })
    expect(result.current.state).toMatchObject({ status: 'importing', fileName: 'masters.pgn' })
  })

  it('stores each batch and only then acknowledges it', async () => {
    // The ack is what releases the worker. Sending it before the write lands
    // would restore exactly the unbounded buffering the protocol exists to stop.
    const { result } = render()
    await act(async () => result.current.attach(file()))

    await worker.emit({ type: 'batch', id: 1, games: [game('a'), game('b')] })

    await waitFor(() => expect(worker.acks()).toEqual([{ type: 'ack', id: 1 }]))
    expect(await countDbGames()).toBe(2)
  })

  it('reports progress as the worker sends it', async () => {
    const { result } = render()
    await act(async () => result.current.attach(file()))

    await worker.emit({ type: 'progress', progress: progress({ parsed: 40, kept: 30, skipped: 10 }) })

    expect(result.current.state.progress).toMatchObject({ parsed: 40, kept: 30, skipped: 10 })
  })

  it('records the attached file when the import finishes', async () => {
    // The record is what lets the screen list what is attached and offer to
    // re-attach it, which §9 requires because Safari evicts.
    const { result } = render()
    await act(async () => result.current.attach(file()))
    await worker.emit({ type: 'batch', id: 1, games: [game('a'), game('b')] })
    // The real worker cannot finish before its last batch is acknowledged, so
    // neither does the fake — the ordering is the protocol, not a nicety.
    await waitFor(() => expect(worker.acks()).toHaveLength(1))
    await worker.emit({ type: 'done', progress: progress() })

    await waitFor(() => expect(result.current.completed).toBe(1))
    expect(result.current.state).toMatchObject({ status: 'done', written: 2 })
    expect(await listDbSources()).toEqual([
      expect.objectContaining({ name: 'masters.pgn', games: 2, parsed: 2, skipped: 0 }),
    ])
    expect(worker.terminated).toBe(true)
  })

  it('asks for persistent storage when a database is attached', async () => {
    // Safari evicts script-written storage after about a week without a visit.
    // This request is what exempts the origin — asking at the moment the user
    // deliberately attaches something is the moment most likely to be granted.
    const persist = vi.fn().mockResolvedValue(true)
    vi.stubGlobal('navigator', {
      storage: { persist, persisted: vi.fn().mockResolvedValue(false) },
    })

    const { result } = render()
    await act(async () => result.current.attach(file()))

    await waitFor(() => expect(result.current.state.persisted).toBe(true))
    expect(persist).toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('says so when persistence is refused rather than looking permanent', async () => {
    vi.stubGlobal('navigator', {
      storage: { persist: vi.fn().mockResolvedValue(false), persisted: vi.fn().mockResolvedValue(false) },
    })

    const { result } = render()
    await act(async () => result.current.attach(file()))

    await waitFor(() => expect(result.current.state.persisted).toBe(false))
    vi.unstubAllGlobals()
  })

  it('stops loudly, keeping what it stored, when storage gives out', async () => {
    const d = new Dexie('etude-chess')
    await d.open()
    vi.spyOn(d.table('dbGames'), 'bulkPut') // touch the table so Dexie is open
    d.close()

    const { result } = render()
    await act(async () => result.current.attach(file()))
    await worker.emit({ type: 'batch', id: 1, games: [game('a')] })
    await waitFor(() => expect(result.current.state.written).toBe(0))

    // Now break the next write the way a full quota would.
    const { getDb } = await import('../persist/db')
    vi.spyOn(getDb()!.dbGames, 'bulkPut').mockRejectedValue(new Error('QuotaExceededError'))
    await worker.emit({ type: 'batch', id: 2, games: [game('b')] })

    await waitFor(() => expect(result.current.state.status).toBe('error'))
    expect(result.current.state.error).toMatch(/QuotaExceededError/)
    expect(result.current.state.written).toBe(1) // the first batch is still there
    expect(worker.terminated).toBe(true)
  })

  it('surfaces a worker that fails outright', async () => {
    const { result } = render()
    await act(async () => result.current.attach(file()))

    await worker.emit({ type: 'error', message: 'could not read the file' })

    expect(result.current.state).toMatchObject({
      status: 'error',
      error: 'could not read the file',
    })
    expect(worker.terminated).toBe(true)
  })

  it('ignores a second file while one is still importing', async () => {
    const { result } = render()
    await act(async () => result.current.attach(file('a.pgn')))
    await act(async () => result.current.attach(file('b.pgn')))

    expect(result.current.state.fileName).toBe('a.pgn')
    expect(worker.sent.filter((m) => (m as { type: string }).type === 'import')).toHaveLength(1)
  })

  it('cancelling stops the worker and returns to idle', async () => {
    const { result } = render()
    await act(async () => result.current.attach(file()))
    await act(async () => result.current.cancel())

    expect(worker.terminated).toBe(true)
    expect(result.current.state.status).toBe('idle')
  })

  it('terminates the worker if the screen goes away mid-import', async () => {
    const { result, unmount } = render()
    await act(async () => result.current.attach(file()))
    unmount()
    expect(worker.terminated).toBe(true)
  })
})
