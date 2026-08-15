/**
 * Browsing the attached database: the pure half (#54, docs/v0.3.0-plan.md §10).
 *
 * #53 stores the games; this decides which of them a browse screen is asking
 * for. Everything here is a pure function over data — the query the user typed,
 * the predicate that decides a row, and the *plan* that says which index should
 * drive the query. No Dexie, no React, no I/O.
 *
 * Three things worth not re-deriving:
 *
 * - **The plan is a cost decision, never a correctness one.** `queryPlan` picks
 *   one index to walk and hands back everything it did not enforce as a
 *   `residual` query, re-checked with `matchesQuery`. Reorder the preferences,
 *   add an index, drop one — the results cannot change, only the work. A test
 *   pins exactly that, which is what makes the ordering free to be a heuristic.
 * - **Search is whole-token prefix matching, not substring matching.** A
 *   substring search needs every suffix in the index or a scan of every row, and
 *   at 100k games a scan is the thing this module exists to avoid. `nameTokens`
 *   is what gets stored (a multiEntry index in `persist/dbGames.ts`) and
 *   `queryTokens` is what gets typed; the two must stay the same splitter, so
 *   they share one.
 * - **A filter that cannot be shown to hold excludes the game.** #53's ingest
 *   rule is the opposite — never reject on what the file didn't say — and both
 *   are right. Ingest is deciding what to keep; a browse filter is a claim about
 *   the rows it shows, and an undated game is not evidence of a date. Unfiltered
 *   it is still there. Conveniently this is also what the indexes do on their
 *   own: IndexedDB does not index `undefined`, so the predicate and the index
 *   agree without either being taught about the other.
 *
 * **What this is not.** ADR 0018 §6 and plan §10 specify **MiniSearch** for
 * name search, and this is not it. Whole-token prefix matching over a multiEntry
 * index covers what MiniSearch was wanted for — finding a player or an event
 * without knowing which way round the file wrote the name — and costs no
 * dependency, no second index to keep in step with the table, and none of the
 * "reload it with the identical options object" hazard §10 warns about, because
 * there is no serialized index to reload. What it does **not** do is tolerate a
 * typo or rank by relevance; a search either hits a token or it doesn't. That
 * remains MiniSearch's job if it is ever wanted, and the seam for it is this
 * module plus `persist/dbGames.queryDbGames` — nothing above them knows how a
 * name is matched.
 */

import type { GameResult, Speed } from './pgnImport'

/**
 * The fields a browse query can read.
 *
 * Declared structurally, like `ParsedPgnGame` in pgnImport.ts, so the domain
 * stays free of any knowledge that a database exists. `persist/dbGames.DbGame`
 * satisfies it by having the same field names, which is deliberate.
 */
export interface SearchableGame {
  white: string
  black: string
  event?: string
  year?: number
  result: GameResult
  eco?: string
  /** The lower of the two ratings; absent when either player is unrated. */
  minElo?: number
  speed: Speed
  source: string
}

/**
 * What the browse screen is asking for. Every field is optional and an absent
 * field is no constraint at all, so `{}` is "everything".
 */
export interface GameQuery {
  /** Free text over both players and the event. Whole-token prefixes. */
  text?: string
  yearFrom?: number
  yearTo?: number
  result?: GameResult
  /** An ECO code or the prefix of one: `B44`, `B4` and `B` are all valid. */
  eco?: string
  /** Both players rated at least this. Unrated games are excluded. */
  minRating?: number
  speed?: Speed
  /** The file a game was imported from. */
  source?: string
}

/** Rows per page. A results table over 100k games renders a window, never the table. */
export const PAGE_SIZE = 50

// ---------- tokens ----------

/**
 * Everything that is not a letter or a digit is a separator.
 *
 * Unicode-aware on purpose: `[^a-z0-9]` would cut "Réti" into "r" and "ti" and
 * make the player unfindable by his own name, which is a poor trade for a
 * shorter regex.
 */
const SEPARATORS = /[^\p{L}\p{N}]+/u

/** A single letter in a name is an initial (`Kasparov, G`), not a searchable word. */
const MIN_INDEXED_TOKEN = 2

/**
 * Ceiling on tokens per game. Event names are the wild field in a PGN — some
 * files put a whole tournament description in there — and a multiEntry index
 * costs one entry per token per game.
 */
const MAX_INDEXED_TOKENS = 32

const split = (text: string): string[] => text.toLowerCase().split(SEPARATORS).filter(Boolean)

/**
 * The searchable tokens of a game: both players and the event, deduplicated.
 *
 * This is what goes into the `*names` multiEntry index, so changing it changes
 * what is stored — a change here needs a schema version and a backfill, exactly
 * like adding a field would (see `persist/db.ts`).
 */
export function nameTokens(game: { white?: string; black?: string; event?: string }): string[] {
  const tokens = new Set<string>()
  for (const field of [game.white, game.black, game.event]) {
    if (!field) continue
    for (const token of split(field)) {
      if (token.length < MIN_INDEXED_TOKEN) continue
      tokens.add(token)
      if (tokens.size >= MAX_INDEXED_TOKENS) return [...tokens]
    }
  }
  return [...tokens]
}

/**
 * The tokens of a typed query. Split the same way names are, but **without** the
 * minimum length: a query token is a prefix, and `g` is a fine prefix of `garry`
 * even though `g` is not a name worth indexing.
 */
export function queryTokens(text: string): string[] {
  return [...new Set(split(text))]
}

// ---------- the predicate ----------

/** Whether a game satisfies a query. The one definition of "matches". */
export function matchesQuery(game: SearchableGame, query: GameQuery): boolean {
  if (query.text) {
    const tokens = nameTokens(game)
    for (const term of queryTokens(query.text)) {
      if (!tokens.some((token) => token.startsWith(term))) return false
    }
  }
  if (query.yearFrom != null && !(game.year != null && game.year >= query.yearFrom)) return false
  if (query.yearTo != null && !(game.year != null && game.year <= query.yearTo)) return false
  if (query.result && game.result !== query.result) return false
  if (query.eco && !(game.eco ?? '').toUpperCase().startsWith(query.eco.toUpperCase())) return false
  if (query.minRating != null && !(game.minElo != null && game.minElo >= query.minRating)) {
    return false
  }
  if (query.speed && game.speed !== query.speed) return false
  if (query.source && game.source !== query.source) return false
  return true
}

// ---------- normalising what a form hands over ----------

const RESULTS: GameResult[] = ['1-0', '0-1', '1/2-1/2', '*']
const SPEEDS: Speed[] = ['bullet', 'blitz', 'rapid', 'classical', 'correspondence', 'unknown']

const text = (value: unknown): string | undefined => {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  return trimmed || undefined
}

const count = (value: unknown): number | undefined => {
  if (value === '' || value == null) return undefined
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : undefined
}

/** Drop the keys whose value is `undefined`, so `Object.keys` means "constrained". */
function compact(query: GameQuery): GameQuery {
  return Object.fromEntries(Object.entries(query).filter(([, v]) => v !== undefined)) as GameQuery
}

/**
 * A form's worth of loose values → a query.
 *
 * Inputs arrive as strings and half-typed, so this is where a blank field stops
 * being a filter on the empty string and a half-typed year stops being `NaN`.
 * A backwards year range is **swapped rather than honoured**: typing the later
 * year first is a slip, and returning the empty set for it is technically
 * correct and useless.
 */
export function normalizeQuery(raw: Partial<Record<keyof GameQuery, unknown>>): GameQuery {
  const result = text(raw.result)
  const speed = text(raw.speed)
  let yearFrom = count(raw.yearFrom)
  let yearTo = count(raw.yearTo)
  if (yearFrom != null && yearTo != null && yearFrom > yearTo) [yearFrom, yearTo] = [yearTo, yearFrom]

  return compact({
    text: text(raw.text),
    yearFrom,
    yearTo,
    result: RESULTS.find((r) => r === result),
    eco: text(raw.eco)?.toUpperCase(),
    minRating: count(raw.minRating),
    speed: SPEEDS.find((s) => s === speed),
    source: text(raw.source),
  })
}

/** Whether a query constrains anything at all. */
export function isEmptyQuery(query: GameQuery): boolean {
  return Object.keys(compact(query)).length === 0
}

// ---------- the plan ----------

/**
 * The index a query should be walked through.
 *
 * `names` is the multiEntry one, so a query through it **must** be paired with
 * `.distinct()`: a game whose White, Black and Event share a token matches the
 * same key range several times over (plan §10 — a compound index cannot be
 * multiEntry, which is why this one stands alone).
 */
export type QueryDriver =
  | { index: 'names'; prefix: string; exact: boolean }
  | { index: 'eco'; prefix: string }
  | { index: 'year'; from?: number; to?: number }
  | { index: 'minElo'; atLeast: number }
  | { index: 'source'; value: string }
  | { index: 'result'; value: GameResult }
  | { index: 'speed'; value: Speed }
  | { index: 'none' }

export interface QueryPlan {
  driver: QueryDriver
  /** What the driver did not enforce. Re-checked against every row it yields. */
  residual: GameQuery
  /**
   * True when the residual is empty — the driver *is* the query. Worth knowing
   * because it is the difference between counting an index range and walking it.
   */
  indexOnly: boolean
}

/**
 * Choose the index to drive a query, and say what it leaves over.
 *
 * The order below is a **selectivity heuristic**, in rough order of how much of
 * a real database each field cuts away:
 *
 * 1. a name — one player is a fraction of a percent of any corpus;
 * 2. an ECO code — ~500 of them, and a full code is narrow;
 * 3. a year range — usually a slice, occasionally the whole thing;
 * 4. a rating floor — narrow at the top end, everything at the bottom;
 * 5. a source file — narrow only if several are attached;
 * 6. a result, then a speed — three or four values over the whole database, so
 *    these drive only when nothing else is on offer.
 *
 * Being wrong about the order costs time and never answers. The test that pins
 * "driver + residual = the whole query" is what buys that freedom.
 */
export function queryPlan(query: GameQuery): QueryPlan {
  const rest = compact({ ...query })

  const driver = ((): QueryDriver => {
    const terms = query.text ? queryTokens(query.text) : []
    if (terms.length > 0) {
      // The longest term is the most selective prefix. One term *is* the query,
      // so the index answers it exactly and nothing has to be re-checked.
      const prefix = terms.reduce((a, b) => (b.length > a.length ? b : a))
      const exact = terms.length === 1
      if (exact) delete rest.text
      return { index: 'names', prefix, exact }
    }
    if (query.eco) {
      delete rest.eco
      return { index: 'eco', prefix: query.eco }
    }
    if (query.yearFrom != null || query.yearTo != null) {
      const { yearFrom, yearTo } = query
      delete rest.yearFrom
      delete rest.yearTo
      return {
        index: 'year',
        ...(yearFrom === undefined ? {} : { from: yearFrom }),
        ...(yearTo === undefined ? {} : { to: yearTo }),
      }
    }
    if (query.minRating != null) {
      delete rest.minRating
      return { index: 'minElo', atLeast: query.minRating }
    }
    if (query.source) {
      delete rest.source
      return { index: 'source', value: query.source }
    }
    if (query.result) {
      delete rest.result
      return { index: 'result', value: query.result }
    }
    if (query.speed) {
      delete rest.speed
      return { index: 'speed', value: query.speed }
    }
    return { index: 'none' }
  })()

  return { driver, residual: rest, indexOnly: Object.keys(rest).length === 0 }
}
