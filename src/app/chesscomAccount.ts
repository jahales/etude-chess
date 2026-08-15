/**
 * Your chess.com account, on your machine (#145).
 *
 * The handle, the time classes you chose, and which months have already been
 * pulled — everything a sync needs to remember, kept exactly the way #130 keeps
 * the names you play under (`settings.ts`): typed at runtime, `localStorage`,
 * never throws, and **no default and never one**. The owner's handle is his to
 * publish; it does not appear in this repo, in a fixture or in a test.
 *
 * `localStorage` rather than the IndexedDB adapter, for the same reason #130
 * gives: this is a preference of a few hundred bytes, read while first rendering
 * a form, and a screen that awaited a database read would have to draw an empty
 * field and then correct itself.
 *
 * It is deliberately a **separate module** from `settings.ts` rather than three
 * more fields on it — an account is not an analysis setting, and the two are
 * edited on different screens.
 */

import {
  canonicalUser,
  mergeSyncedMonth,
  normalizeClasses,
  type SyncedMonth,
  type TimeClass,
} from '../domain/chesscom'

export const CHESSCOM_ACCOUNT_KEY = 'etude-chess:chesscom-account'

export interface ChesscomAccount {
  /** The handle, lowercased. Empty until someone types one. */
  user: string
  /**
   * The time classes to import.
   *
   * Empty by default, and the sync button stays disabled until it isn't. There
   * is no sensible default: bringing in everything pools blitz with rapid and
   * daily, which is the analysis error the `coach` skill is explicit about, and
   * picking one for the user would be us making that choice silently.
   */
  classes: TimeClass[]
  /** Months already pulled, and what they cover. See `domain/chesscom.monthsToFetch`. */
  months: SyncedMonth[]
}

export const EMPTY_ACCOUNT: ChesscomAccount = { user: '', classes: [], months: [] }

const isMonth = (value: unknown): value is SyncedMonth => {
  const m = value as Partial<SyncedMonth> | null
  return (
    typeof m?.month === 'string' &&
    Array.isArray(m.classes) &&
    typeof m.syncedAt === 'number' &&
    Number.isFinite(m.syncedAt)
  )
}

/**
 * Read the account back, best-effort.
 *
 * Everything is re-validated on the way in, not just on the way out: a value
 * written by hand or by an older version must not be able to put a malformed
 * month record in front of `monthsToFetch`, where it would silently mean "we
 * already have that month".
 */
export function loadChesscomAccount(): ChesscomAccount {
  try {
    const raw = localStorage.getItem(CHESSCOM_ACCOUNT_KEY)
    if (!raw) return EMPTY_ACCOUNT
    const stored = JSON.parse(raw) as Partial<ChesscomAccount> | null
    if (!stored || typeof stored !== 'object') return EMPTY_ACCOUNT
    return {
      user: typeof stored.user === 'string' ? canonicalUser(stored.user) : '',
      classes: Array.isArray(stored.classes) ? normalizeClasses(stored.classes) : [],
      months: Array.isArray(stored.months)
        ? stored.months.filter(isMonth).map((m) => ({
            month: m.month,
            classes: normalizeClasses(m.classes),
            syncedAt: m.syncedAt,
          }))
        : [],
    }
  } catch {
    // An embedded context can refuse storage outright, and a stored value can be
    // anything. Either way it means "no account recorded", never a screen that
    // won't open.
    return EMPTY_ACCOUNT
  }
}

export function saveChesscomAccount(account: ChesscomAccount): void {
  try {
    localStorage.setItem(CHESSCOM_ACCOUNT_KEY, JSON.stringify(account))
  } catch {
    // Storage full or refused (Safari private browsing throws here). The sync
    // still works this session; it just won't remember next time, which costs a
    // re-fetch rather than correctness.
  }
}

/**
 * The months already pulled **for this handle**.
 *
 * Empty for any other handle, which is the whole reason this function exists: a
 * record made against one account says nothing about another, and reading it as
 * "already synced" would skip every settled month of the new one and import
 * nothing.
 */
export function monthsFor(account: ChesscomAccount, user: string): SyncedMonth[] {
  return account.user === canonicalUser(user) ? account.months : []
}

/**
 * Point the account at a handle and a choice of classes, for a sync about to run.
 *
 * **Months are dropped when the handle changes**, and that is the whole job. The
 * months live beside the handle rather than under it, so writing the new handle
 * over the old one while keeping the list would leave one account's record
 * claiming another account's months — and `monthsFor` would then agree, skip
 * every settled month of the new account, and import almost none of it.
 */
export function withUser(
  account: ChesscomAccount,
  user: string,
  classes: readonly TimeClass[],
): ChesscomAccount {
  const handle = canonicalUser(user)
  return { user: handle, classes: normalizeClasses(classes), months: monthsFor(account, handle) }
}

/** Record a finished month, keeping the account pointed at the handle it describes. */
export function withSyncedMonth(
  account: ChesscomAccount,
  user: string,
  month: SyncedMonth,
): ChesscomAccount {
  const handle = canonicalUser(user)
  return {
    ...account,
    user: handle,
    months: mergeSyncedMonth(monthsFor(account, handle), month),
  }
}

/**
 * Forget what was pulled, keeping the handle.
 *
 * Called when the account's games are detached: the games are gone, so a record
 * saying those months are done would make the next sync a no-op — the exact
 * failure that makes "detach and try again" stop working.
 */
export function forgetSyncedMonths(account: ChesscomAccount, user: string): ChesscomAccount {
  if (account.user !== canonicalUser(user)) return account
  return { ...account, months: [] }
}
