/**
 * Importing your own games from chess.com: the half that touches the network
 * (#145).
 *
 * The rules it applies are pure and live in `domain/chesscom.ts`; the storing is
 * `app/useChesscomSync.ts`. Games come out of here in exactly the shape
 * `content/pgnImport.ts` produces — `ImportedRecord` — so both routes into the
 * database go through the same `normalizeGame` → `describeGame` → `filterGame`
 * path and there is only ever one set of rules about what a stored game is.
 *
 * **This is a free, public, unauthenticated API, and we behave like it.**
 * Everything below is shaped by that and not by speed:
 *
 * - the archive index is fetched **once** per sync, and months that are settled
 *   and already covered are never asked for again (`monthsToFetch`);
 * - months are fetched **one at a time**, and the caller's write of each month is
 *   *awaited* before the next request goes out, so a slow disk throttles the
 *   network rather than the two racing;
 * - there is a deliberate **pause between months**, so a first sync of a decade
 *   is a steady trickle rather than 150 requests as fast as the socket allows;
 * - a **429 is obeyed**, once, using the server's own `Retry-After`, and then we
 *   stop and say so rather than hammering;
 * - nothing here runs on its own. Syncing is a button (`ui/Database.tsx`), never
 *   something that happens because the app loaded.
 *
 * Two things we deliberately do **not** do. We do not set `User-Agent`: browsers
 * forbid it, the endpoint does not need it, and attempting it only produces a
 * console error. And we do not fetch per game — the monthly payload carries the
 * full PGN of every game inline, which is the reason a whole account costs one
 * request per month.
 *
 * No Web Worker either, unlike the file import. That one exists because parsing
 * a few hundred megabytes is a frozen tab; here a month is a few hundred small
 * games parsed in the gaps between network round trips, so a worker would buy
 * nothing and cost a second import path to keep in step.
 */

import { parsePgn } from 'chessops/pgn'
import {
  acceptGame,
  archiveIndexUrl,
  gamesOfMonth,
  monthsToFetch,
  parseArchiveIndex,
  type ArchiveMonth,
  type SyncedMonth,
  type TimeClass,
} from '../domain/chesscom'
import {
  describeGame,
  filterGame,
  MY_GAMES_FILTERS,
  normalizeGame,
  type ImportFilters,
  type SkipReason,
} from '../domain/pgnImport'
import type { ImportedRecord } from './pgnImport'

// ---------- failures ----------

/**
 * The ways a sync fails, kept apart because they need different answers.
 *
 * `no-such-user` exists as its own kind for one reason: a 404 on the index used
 * to fall through to an empty archive list, which finished the sync with "0
 * games imported" — a sentence that reads like success and sends you looking at
 * your filters instead of at your spelling.
 */
export type ChesscomFailure = 'no-such-user' | 'rate-limited' | 'unavailable' | 'network'

export class ChesscomError extends Error {
  constructor(
    readonly failure: ChesscomFailure,
    message: string,
  ) {
    super(message)
    this.name = 'ChesscomError'
  }
}

/** What each failure says to the person who pressed the button. */
export const CHESSCOM_FAILURE_MESSAGE: Record<ChesscomFailure, string> = {
  'no-such-user': 'No such user on chess.com — check the spelling of the handle.',
  'rate-limited':
    'chess.com asked us to slow down and is still asking. Nothing was lost — wait a few minutes and sync again; it will carry on from where it stopped.',
  unavailable: 'chess.com could not be reached just now. Try again in a few minutes.',
  network:
    'The request never reached chess.com. Check that you are online, then try again.',
}

// ---------- fetching ----------

/** The slice of `fetch` we use, so a test can supply one without a network. */
export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>

/** Pause between month requests. Not a rate limit we were given — a courtesy. */
export const DEFAULT_PAUSE_MS = 300

/** Longest we will sit on a `Retry-After` before giving the user back control. */
export const MAX_RETRY_AFTER_MS = 60_000

const wait = (ms: number) =>
  ms > 0 ? new Promise<void>((resolve) => setTimeout(resolve, ms)) : Promise.resolve()

/**
 * `Retry-After` in milliseconds — seconds or an HTTP date, both of which the
 * standard allows and CDNs use interchangeably.
 *
 * Capped, and never negative: a header we cannot read, or one naming next
 * Tuesday, must not turn a rate limit into a hung button.
 */
export function retryAfterMs(header: string | null, now: number): number {
  if (!header) return 0
  const seconds = Number(header.trim())
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - now
  if (!Number.isFinite(ms) || ms <= 0) return 0
  return Math.min(ms, MAX_RETRY_AFTER_MS)
}

interface FetchContext {
  fetchImpl: FetchLike
  signal?: AbortSignal
  now: () => number
  /** Fallback wait when a 429 arrives without a usable `Retry-After`. */
  pauseMs: number
}

/**
 * One GET, as JSON, with the single retry a 429 earns.
 *
 * A status is turned into a `ChesscomFailure` here and nowhere else, so every
 * caller reports the same failure the same way.
 */
async function getJson(url: string, ctx: FetchContext): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    let response: Response
    try {
      response = await ctx.fetchImpl(url, ctx.signal ? { signal: ctx.signal } : {})
    } catch (e) {
      // An abort is the user's own doing and is handled by the loop below, not
      // reported as a network failure.
      if (ctx.signal?.aborted) throw e
      throw new ChesscomError('network', e instanceof Error ? e.message : 'the request failed')
    }

    if (response.ok) {
      try {
        return (await response.json()) as unknown
      } catch {
        throw new ChesscomError('unavailable', `chess.com sent something we could not read (${url})`)
      }
    }

    if (response.status === 429 && attempt === 0) {
      // Obey the server's own number, falling back to our courtesy pause. One
      // retry only: if it is still limiting us, waiting longer in a loop is how
      // a polite client becomes an impolite one.
      await wait(retryAfterMs(response.headers.get('retry-after'), ctx.now()) || ctx.pauseMs)
      continue
    }
    throw new ChesscomError(failureFor(response.status), `chess.com replied ${response.status}`)
  }
}

const failureFor = (status: number): ChesscomFailure => {
  if (status === 404) return 'no-such-user'
  if (status === 429) return 'rate-limited'
  return 'unavailable'
}

/** The months an account has games in, oldest first. 404 here means the handle is wrong. */
async function fetchArchiveIndex(user: string, ctx: FetchContext): Promise<ArchiveMonth[]> {
  return parseArchiveIndex(await getJson(archiveIndexUrl(user), ctx))
}

// ---------- the sync ----------

export interface SyncProgress {
  /** Months this sync decided to fetch — not months the account has. */
  months: number
  monthsDone: number
  /** The month being fetched, `YYYY-MM`. */
  month?: string
  /** Games seen in the payloads, whether or not we kept them. */
  fetched: number
  kept: number
  skipped: number
  skippedByReason: Partial<Record<SkipReason, number>>
  /** Months the index listed that we did not need to ask for. */
  monthsSkipped: number
}

export interface SyncOptions {
  user: string
  /** Which time classes to bring in. The user's choice; we have no default. */
  classes: readonly TimeClass[]
  /** What previous syncs recorded, so settled months are not re-fetched. */
  synced?: readonly SyncedMonth[]
  /**
   * Import filters. Defaults to `MY_GAMES_FILTERS` (#129) — the preset that
   * exists for exactly this case, since ADR 0018 §4's master-database defaults
   * keep none of a club player's own games.
   */
  filters?: ImportFilters
  /**
   * Store one month's games. **Awaited** before the next request goes out, so
   * the writer paces the network instead of racing it.
   */
  onBatch: (games: ImportedRecord[], month: ArchiveMonth) => void | Promise<void>
  /** A month finished and stored — the caller records it so it is not re-fetched. */
  onMonth?: (record: SyncedMonth) => void | Promise<void>
  onProgress?: (progress: SyncProgress) => void
  signal?: AbortSignal
  fetchImpl?: FetchLike
  /** Courtesy pause between month requests. Tests pass 0. */
  pauseMs?: number
  /** Injected so the domain's "has this month ended?" rule stays testable. */
  now?: () => number
}

/**
 * Fetch an account's games and hand them over month by month.
 *
 * Resolves with the totals, including after an abort — what was already stored
 * stays stored and the caller reports it. It rejects only on a `ChesscomError`,
 * which is a failure the user has to see: a wrong handle, a rate limit, or a
 * site that is down.
 */
export async function syncChesscomGames(options: SyncOptions): Promise<SyncProgress> {
  const {
    user,
    classes,
    synced = [],
    filters = MY_GAMES_FILTERS,
    onBatch,
    onMonth,
    onProgress,
    signal,
    fetchImpl = ((url, init) => fetch(url, init)) as FetchLike,
    pauseMs = DEFAULT_PAUSE_MS,
    now = () => Date.now(),
  } = options

  const ctx: FetchContext = { fetchImpl, now, pauseMs, ...(signal ? { signal } : {}) }

  const progress: SyncProgress = {
    months: 0,
    monthsDone: 0,
    fetched: 0,
    kept: 0,
    skipped: 0,
    skippedByReason: {},
    monthsSkipped: 0,
  }
  const report = () =>
    onProgress?.({ ...progress, skippedByReason: { ...progress.skippedByReason } })

  const skip = (reason: SkipReason) => {
    progress.skipped++
    progress.skippedByReason[reason] = (progress.skippedByReason[reason] ?? 0) + 1
  }

  // No classes, no request. Asking chess.com for games we would reject every one
  // of is the rudest thing this module could do.
  if (classes.length === 0) return progress

  const archives = await fetchArchiveIndex(user, ctx)
  const wanted = monthsToFetch(archives, synced, classes, now())
  progress.months = wanted.length
  progress.monthsSkipped = archives.length - wanted.length
  report()

  for (const [index, archive] of wanted.entries()) {
    if (signal?.aborted) break
    // The pause goes *before* each request but the first, so a single-month
    // sync — the common one, once you are up to date — costs nothing extra.
    if (index > 0) await wait(pauseMs)
    if (signal?.aborted) break

    progress.month = archive.month
    report()

    const payload = await getJson(archive.url, ctx)
    const batch: ImportedRecord[] = []

    for (const game of gamesOfMonth(payload)) {
      progress.fetched++
      const verdict = acceptGame(game, classes)
      if (!verdict.keep) {
        skip(verdict.reason)
        continue
      }
      const record = readOneGame(verdict.pgn, filters)
      if ('reason' in record) {
        skip(record.reason)
        continue
      }
      progress.kept++
      batch.push(record)
    }

    // Hand over even an empty month, so the caller can record it as done and we
    // never ask for it again.
    await onBatch(batch, archive)
    progress.monthsDone++
    await onMonth?.({ month: archive.month, classes: [...classes], syncedAt: now() })
    report()
  }

  delete progress.month
  report()
  return progress
}

/**
 * One game's PGN → the record we store, or the reason we didn't.
 *
 * Straight down the file-import path: the same `normalizeGame` (which strips
 * `[%clk …]`, and a chess.com export stamps one on every ply), the same
 * `describeGame`, the same `filterGame`. A PGN that produces no game at all is
 * `malformed` — chessops' parser has a per-game complexity budget and throwing
 * out of a whole sync because one 2019 game tripped it would be the wrong trade.
 */
function readOneGame(
  pgn: string,
  filters: ImportFilters,
): ImportedRecord | { reason: SkipReason } {
  let parsed
  try {
    parsed = parsePgn(pgn)[0]
  } catch {
    return { reason: 'malformed' }
  }
  if (!parsed) return { reason: 'malformed' }

  const game = normalizeGame(parsed)
  const facts = describeGame(game)
  const verdict = filterGame(facts, filters)
  return verdict.keep ? { game, facts } : { reason: verdict.reason }
}
