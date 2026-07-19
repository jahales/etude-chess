import { describe, it, expect, vi, afterEach } from 'vitest'
import { ensurePersistence, storageStatus, formatBytes } from './storage'

/** Install a fake Storage API; pass null to simulate a browser without one. */
function withStorage(storage: Partial<StorageManager> | null) {
  Object.defineProperty(globalThis, 'navigator', {
    value: storage === null ? {} : { storage },
    configurable: true,
    writable: true,
  })
}

afterEach(() => vi.restoreAllMocks())

describe('ensurePersistence', () => {
  it('does not re-request when storage is already persisted', () => {
    const persist = vi.fn()
    withStorage({ persisted: async () => true, persist })
    return expect(ensurePersistence()).resolves.toBe(true).then(() => {
      expect(persist).not.toHaveBeenCalled()
    })
  })

  it('requests persistence when it has not been granted', async () => {
    const persist = vi.fn(async () => true)
    withStorage({ persisted: async () => false, persist })
    await expect(ensurePersistence()).resolves.toBe(true)
    expect(persist).toHaveBeenCalledOnce()
  })

  it('reports refusal rather than pretending it succeeded', async () => {
    // The user or the browser can say no. The app must keep working and must not
    // imply durability it does not have.
    withStorage({ persisted: async () => false, persist: async () => false })
    await expect(ensurePersistence()).resolves.toBe(false)
  })

  it('is safe in a browser with no Storage API', async () => {
    withStorage(null)
    await expect(ensurePersistence()).resolves.toBe(false)
  })

  it('never throws when the API rejects', async () => {
    // Some contexts (private windows, embedded frames) throw rather than resolve.
    withStorage({
      persisted: async () => {
        throw new Error('denied')
      },
      persist: async () => true,
    })
    await expect(ensurePersistence()).resolves.toBe(false)
  })
})

describe('storageStatus', () => {
  it('reports persistence and usage', async () => {
    withStorage({
      persisted: async () => true,
      estimate: async () => ({ usage: 1024 * 1024, quota: 1024 * 1024 * 100 }),
    })
    await expect(storageStatus()).resolves.toMatchObject({
      supported: true,
      persisted: true,
      usageBytes: 1024 * 1024,
    })
  })

  it('says unsupported rather than guessing', async () => {
    withStorage(null)
    await expect(storageStatus()).resolves.toEqual({ supported: false, persisted: false })
  })

  it('degrades when estimate is unavailable but persisted is not', async () => {
    withStorage({ persisted: async () => false })
    const s = await storageStatus()
    expect(s).toMatchObject({ supported: true, persisted: false })
    expect(s.usageBytes).toBeUndefined()
  })
})

describe('formatBytes', () => {
  it('scales through the units', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
    expect(formatBytes(2 * 1024 * 1024 * 1024)).toBe('2.0 GB')
  })

  it('shows an em dash rather than "0" when nothing is known', () => {
    expect(formatBytes(undefined)).toBe('—')
  })
})
