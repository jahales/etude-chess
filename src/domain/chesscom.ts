/**
 * Importing your own games from chess.com: the rules (#145).
 *
 * We ship no corpus — users attach their own (ADR 0018) — and your own games are
 * squarely inside that: nothing is redistributed, the games are yours, and they
 * are fetched straight from the public read-only API to the browser that asked
 * for them. `api.chess.com` sends `Access-Control-Allow-Origin: *` (verified
 * 2026-08-15), so this needs no backend and the constitution's no-backend rule
 * stays intact.
 *
 * Everything in this file is a pure function over data: which months are worth
 * asking for, which games to keep before we spend a parse on them, and how a
 * month is recorded once it is done. The fetching is `content/chesscom.ts`; the
 * storing is the hook. This module has no idea a network exists.
 *
 * Three things here are load-bearing:
 *
 * - **A month is only "done" once it has ended.** Recording the month you are
 *   currently in as complete would mean every game you play for the rest of it
 *   is never fetched again. So a record carries *when* it was made and is only
 *   believed if that was after the month closed.
 * - **A month is done *for the classes you asked for*.** Sync only rapid, then
 *   come back for blitz, and a plain "done" flag would skip every month you
 *   already visited and quietly return nothing. The record carries the set.
 * - **Your handle appears nowhere in this repo.** It is typed at runtime and
 *   stored on the machine that typed it (`app/chesscomAccount.ts`), the same way
 *   #130 handles the names you play under. There is no default and there will
 *   not be one.
 */

import type { SkipReason } from './pgnImport'

// ---------- time classes ----------

/**
 * chess.com's own classification of a game, which is what we filter on.
 *
 * Taken from the API's `time_class` rather than re-derived from the clock: it is
 * the site's own answer, it is what the account's rating pages are split by, and
 * for daily games it is the only honest one — a 3-day-per-move game has a base
 * of 259200 seconds, which no clock-based rule was written with in mind.
 *
 * Which of these to bring in is **the user's choice, never a default of ours**.
 * The owner moved from blitz to rapid and daily during 2026, and a report that
 * pools the three is not a report about either.
 */
export type TimeClass = 'bullet' | 'blitz' | 'rapid' | 'daily'

export const TIME_CLASSES: readonly TimeClass[] = ['bullet', 'blitz', 'rapid', 'daily']

export const TIME_CLASS_LABEL: Record<TimeClass, string> = {
  bullet: 'Bullet',
  blitz: 'Blitz',
  rapid: 'Rapid',
  daily: 'Daily',
}

const isTimeClass = (value: unknown): value is TimeClass =>
  typeof value === 'string' && (TIME_CLASSES as readonly string[]).includes(value)

/** The classes in `TIME_CLASSES` order, deduplicated — so a stored set is stable. */
export function normalizeClasses(classes: readonly unknown[]): TimeClass[] {
  return TIME_CLASSES.filter((c) => classes.includes(c))
}

// ---------- the account ----------

/** The public, read-only, no-key API root (docs: chess.com/news/view/published-data-api). */
export const CHESSCOM_API = 'https://api.chess.com/pub'

/** Handles are case-insensitive on chess.com; ours is lowercase so a record matches. */
export const canonicalUser = (user: string): string => user.trim().toLowerCase()

/**
 * Whether a handle can go in a URL at all.
 *
 * Deliberately *not* chess.com's signup rule (3–25 characters). This checks the
 * one thing that is our problem: that the text is a single path segment and not
 * a slash, a space or a query string that would send the request somewhere other
 * than where the user thinks. Rejecting a valid-but-unusual handle would be us
 * inventing a rule; letting `../../` through would be a bug.
 */
export const isUsableUser = (user: string): boolean => /^[a-z0-9_-]+$/.test(canonicalUser(user))

export const archiveIndexUrl = (user: string): string =>
  `${CHESSCOM_API}/player/${canonicalUser(user)}/games/archives`

/**
 * The provenance an imported game carries, and the row in the attached-sources
 * list.
 *
 * Includes the handle so two accounts synced on one machine stay separate rather
 * than overwriting each other's source row. That value only ever exists on the
 * user's own machine — the literal in this file is the prefix.
 */
export const CHESSCOM_SOURCE_PREFIX = 'chess.com/'

export const chesscomSourceName = (user: string): string =>
  CHESSCOM_SOURCE_PREFIX + canonicalUser(user)

/** The handle a source row belongs to, or nothing if it was an attached file. */
export const chesscomUserOfSource = (source: string): string | undefined =>
  source.startsWith(CHESSCOM_SOURCE_PREFIX)
    ? source.slice(CHESSCOM_SOURCE_PREFIX.length)
    : undefined

// ---------- the archive index ----------

/** One month of an account's archive: the URL to fetch and the `YYYY-MM` it covers. */
export interface ArchiveMonth {
  url: string
  /** `YYYY-MM`, so it sorts lexicographically and reads as a date. */
  month: string
}

/** The tail of an archive URL: `.../games/2026/08`. */
const MONTH_URL = /\/(\d{4})\/(\d{2})\/?$/

/**
 * The archive index → the months we can ask for, oldest first.
 *
 * A URL whose shape we don't recognise is **dropped, not guessed at**: we record
 * months as done by name, so a month we cannot name is a month we could never
 * record — better to skip it than to fetch it forever or file it under the wrong
 * label. The index has been `{"archives": [...]}` since the API shipped; if that
 * ever changes this returns nothing, which surfaces as "no games found" rather
 * than as a crash.
 */
export function parseArchiveIndex(payload: unknown): ArchiveMonth[] {
  const archives = (payload as { archives?: unknown } | null)?.archives
  if (!Array.isArray(archives)) return []
  const months: ArchiveMonth[] = []
  for (const url of archives) {
    if (typeof url !== 'string') continue
    const match = MONTH_URL.exec(url)
    if (!match) continue
    months.push({ url, month: `${match[1]}-${match[2]}` })
  }
  return months.sort((a, b) => a.month.localeCompare(b.month))
}

// ---------- which months still need fetching ----------

/** What we remember about a month we already pulled. */
export interface SyncedMonth {
  /** `YYYY-MM`. */
  month: string
  /** The classes that were asked for when it was fetched. */
  classes: TimeClass[]
  /** When the fetch happened (epoch ms) — see `isSettled`. */
  syncedAt: number
}

/** The instant a `YYYY-MM` stops being able to gain games: 00:00 UTC on the 1st after. */
export function monthEndMs(month: string): number {
  const [year, ordinal] = month.split('-').map(Number)
  if (!year || !ordinal) return Number.POSITIVE_INFINITY
  // `ordinal` is 1-based and `Date.UTC`'s month is 0-based, so passing it
  // unadjusted names the first day of the *following* month. That is the answer.
  return Date.UTC(year, ordinal, 1)
}

/**
 * Whether a record can be trusted to cover the whole month.
 *
 * The month you are in is still growing, so syncing on the 15th and recording
 * "done" would mean the second half of it never arrives. Compared against the
 * month's end rather than against "is this the current month", because a record
 * made last August is just as wrong if it was made mid-August.
 */
export const isSettled = (record: SyncedMonth): boolean => record.syncedAt >= monthEndMs(record.month)

const covers = (record: SyncedMonth, wanted: readonly TimeClass[]): boolean =>
  wanted.every((c) => record.classes.includes(c))

/**
 * The months worth fetching, oldest first.
 *
 * This is the whole of "be polite to a free public API": a settled month whose
 * games we already have is not requested again, so a routine sync is the index
 * plus the current month rather than a decade of PGN re-downloaded to discover
 * we had it. `now` is passed in because the domain does not read a clock.
 */
export function monthsToFetch(
  archives: readonly ArchiveMonth[],
  synced: readonly SyncedMonth[],
  wanted: readonly TimeClass[],
  now: number,
): ArchiveMonth[] {
  const byMonth = new Map(synced.map((s) => [s.month, s]))
  return archives.filter(({ month }) => {
    // A month that has not ended yet is always re-fetched, whatever we recorded.
    if (monthEndMs(month) > now) return true
    const record = byMonth.get(month)
    return !record || !isSettled(record) || !covers(record, wanted)
  })
}

/**
 * Fold a finished month into the record, widening the classes it covers.
 *
 * Widening rather than replacing: sync rapid in March and blitz in April and
 * March's record must end up saying "rapid and blitz", or the next sync fetches
 * it a third time. The `syncedAt` is the *latest* pass, since that is the one
 * whose coverage the union describes.
 */
export function mergeSyncedMonth(
  synced: readonly SyncedMonth[],
  fresh: SyncedMonth,
): SyncedMonth[] {
  const merged = synced.filter((s) => s.month !== fresh.month)
  const previous = synced.find((s) => s.month === fresh.month)
  merged.push({
    month: fresh.month,
    classes: normalizeClasses([...(previous?.classes ?? []), ...fresh.classes]),
    syncedAt: Math.max(fresh.syncedAt, previous?.syncedAt ?? 0),
  })
  return merged.sort((a, b) => a.month.localeCompare(b.month))
}

// ---------- one game, before it is parsed ----------

/**
 * The fields of a monthly archive's game we actually read.
 *
 * Structural, like `ParsedPgnGame` in `pgnImport.ts`, and every field optional:
 * this is third-party JSON, and a missing field must read as "not stated"
 * instead of throwing halfway through somebody's 2019.
 *
 * **`pgn` carries the whole game inline**, which is why importing an account is
 * one request per month rather than one per game.
 */
export interface ChesscomGame {
  pgn?: string
  time_class?: string
  rules?: string
  url?: string
}

/** A monthly archive payload → its games. Anything else is an empty month. */
export function gamesOfMonth(payload: unknown): ChesscomGame[] {
  const games = (payload as { games?: unknown } | null)?.games
  if (!Array.isArray(games)) return []
  return games.filter((g): g is ChesscomGame => typeof g === 'object' && g !== null)
}

export type PreParseVerdict = { keep: true; pgn: string } | { keep: false; reason: SkipReason }

/**
 * Whether a game is worth parsing, from the JSON alone.
 *
 * Three rejections, all cheaper here than after a parse, and all reported in the
 * same vocabulary the file-import summary uses (`SKIP_REASON_LABEL`) so one
 * screen does not explain the same thing two ways:
 *
 * - **A class you didn't pick.** `time_class` is the site's own answer; an
 *   unrecognised value is treated as unpicked rather than let through, since a
 *   new class we've never heard of is by definition not one the user chose.
 * - **Not standard chess.** `rules` names the variant, and it is more reliable
 *   than the `[Variant]` tag — chess.com's Chess960 PGN carries a `[FEN]` and
 *   sometimes nothing else. `filterGame` still checks the tag afterwards; this
 *   just means we don't pay for the parse.
 * - **No movetext.** Games abandoned before the first move come back with an
 *   empty or absent `pgn`, and an empty string is not a game we failed to read.
 */
export function acceptGame(game: ChesscomGame, wanted: readonly TimeClass[]): PreParseVerdict {
  if (!isTimeClass(game.time_class) || !wanted.includes(game.time_class)) {
    return { keep: false, reason: 'time-class' }
  }
  if (game.rules !== undefined && game.rules !== 'chess') return { keep: false, reason: 'variant' }
  const pgn = typeof game.pgn === 'string' ? game.pgn.trim() : ''
  if (!pgn) return { keep: false, reason: 'no-moves' }
  return { keep: true, pgn }
}
