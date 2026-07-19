/**
 * Storage durability.
 *
 * IndexedDB is not permanent by default. **Safari evicts script-written storage
 * after ~7 days without interaction** unless the origin is granted persistence
 * or installed as a PWA, and Chrome/Firefox may evict under pressure. The game
 * library is the only copy of your history, so asking for persistence is not an
 * optimisation — it is the difference between keeping that history and silently
 * losing it (docs/spikes/games-corpus.md §5).
 *
 * All of this is best-effort and never throws: the API is absent in some
 * browsers and some contexts, and the app must run either way.
 */

export interface StorageStatus {
  /** The browser exposes the Storage API at all. */
  supported: boolean
  /** The origin has been granted persistent storage. */
  persisted: boolean
  usageBytes?: number
  quotaBytes?: number
}

function storageManager(): StorageManager | null {
  return typeof navigator !== 'undefined' && navigator.storage ? navigator.storage : null
}

/**
 * Ask for persistent storage, once.
 *
 * Deliberately called after the user has created something worth keeping rather
 * than on load: browsers weigh engagement when deciding silently, and a prompt
 * that follows a saved game is one the user can actually make sense of.
 *
 * Returns whether storage is persisted afterwards — including when it already
 * was, and `false` when unsupported or refused.
 */
export async function ensurePersistence(): Promise<boolean> {
  const storage = storageManager()
  if (!storage?.persist || !storage.persisted) return false
  try {
    if (await storage.persisted()) return true
    return await storage.persist()
  } catch {
    return false
  }
}

/** Current durability and usage, for the UI to report honestly. */
export async function storageStatus(): Promise<StorageStatus> {
  const storage = storageManager()
  if (!storage) return { supported: false, persisted: false }
  try {
    const persisted = storage.persisted ? await storage.persisted() : false
    const estimate = storage.estimate ? await storage.estimate() : undefined
    return {
      supported: true,
      persisted,
      usageBytes: estimate?.usage,
      quotaBytes: estimate?.quota,
    }
  } catch {
    return { supported: true, persisted: false }
  }
}

/** Human-readable byte size, e.g. "4.2 MB". */
export function formatBytes(bytes: number | undefined): string {
  if (bytes == null) return '—'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`
}
