/**
 * Browsing the attached database: the pure half (#54, docs/v0.3.0-plan.md §10).
 *
 * #53 stores the games; this decides which of them a browse screen is asking
 * for. Everything here is a pure function over data — the query the user typed,
 * the predicate that decides a row, and the *plan* that says which index should
 * drive the query. No Dexie, no MiniSearch, no React, no I/O.
 *
 * Four things worth not re-deriving:
 *
 * - **The plan is a cost decision, never a correctness one.** `queryPlan` picks
 *   one index to walk and hands back everything it did not enforce as a
 *   `residual`, re-checked with `matchesQuery`. Reorder the preferences, add an
 *   index, drop one — the results cannot change, only the work. A test pins
 *   exactly that, which is what makes the ordering free to be a heuristic.
 * - **Free text is resolved to index tokens before anything queries.** The
 *   matching itself is fuzzy and lives in `persist/searchIndex.ts` (MiniSearch,
 *   ADR 0018 §6); what arrives here is its *answer* — for each word typed, the
 *   set of index tokens that satisfy it (`TermMatch`). So the fuzzy matcher is
 *   injected as data, this module stays pure and exhaustively testable, and the
 *   matcher can be replaced without touching a rule.
 * - **`tokens: null` means "too many to enumerate", not "no matches".** A word
 *   broad enough to match hundreds of distinct names is answered by a prefix
 *   range over the index instead, which is complete for the prefix and drops
 *   only the fuzzy extras. Capping a ranked list instead would silently drop
 *   *exact* matches from the tail, which is the worse failure.
 * - **A filter that cannot be shown to hold excludes the game.** #53's ingest
 *   rule is the opposite — never reject on what the file didn't say — and both
 *   are right. Ingest is deciding what to keep; a browse filter is a claim about
 *   the rows it shows, and an undated game is not evidence of a date. Unfiltered
 *   it is still there. Conveniently this is also what the indexes do on their
 *   own: IndexedDB does not index `undefined`, so the predicate and the index
 *   agree without either being taught about the other.
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
  /** Free text over both players and the event. Matched by `searchIndex`. */
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

/**
 * Split text into words. **Shared with the search index**, which takes this as
 * its `tokenize` option — the vocabulary it is built from and the words a query
 * is cut into have to be cut the same way, and one function is how that is
 * guaranteed rather than remembered.
 */
export function tokenize(text: string): string[] {
  return text.toLowerCase().split(SEPARATORS).filter(Boolean)
}

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
    for (const token of tokenize(field)) {
      if (token.length < MIN_INDEXED_TOKEN) continue
      tokens.add(token)
      if (tokens.size >= MAX_INDEXED_TOKENS) return [...tokens]
    }
  }
  return [...tokens]
}

/**
 * The words of a typed query. Split the same way names are, but **without** the
 * minimum length: a query word is matched against whole tokens, and `g` is a
 * fine start for `garry` even though `g` is not a name worth indexing.
 */
export function queryTokens(text: string): string[] {
  return [...new Set(tokenize(text))]
}

// ---------- resolving free text ----------

/** One word of a query, and the index tokens that satisfy it. */
export interface TermMatch {
  /** The word as typed, lowercased. */
  term: string
  /**
   * The index tokens it matches — or `null` when there were too many to
   * enumerate, in which case the word falls back to being a **prefix**.
   */
  tokens: string[] | null
}

/**
 * A query whose free text has been resolved against the search index.
 *
 * Everything downstream — the predicate, the plan, the count — works from this
 * rather than from raw text, so nothing below this line knows how a name is
 * matched.
 */
export interface ResolvedQuery {
  /** The structured filters. Never carries `text`. */
  filters: GameQuery
  /** One entry per word of the free text; empty when none was typed. */
  terms: TermMatch[]
}

/** Turns a query word into the index tokens satisfying it, or `null` for "too many". */
export type TermExpander = (term: string) => string[] | null

/**
 * The expander to use when there is no search index — during a rebuild, or where
 * storage is unavailable. Every word becomes a prefix, which is what the
 * `*names` index can answer on its own.
 */
export const BY_PREFIX: TermExpander = () => null

export function resolveQuery(query: GameQuery, expand: TermExpander): ResolvedQuery {
  const { text, ...filters } = query
  return {
    filters: compact(filters),
    terms: text ? queryTokens(text).map((term) => ({ term, tokens: expand(term) })) : [],
  }
}

/** Whether a game's own tokens satisfy one word of the query. */
function satisfies(names: string[], match: TermMatch): boolean {
  if (match.tokens === null) return names.some((name) => name.startsWith(match.term))
  const wanted = new Set(match.tokens)
  return names.some((name) => wanted.has(name))
}

// ---------- the predicate ----------

/** Whether a game satisfies a resolved query. The one definition of "matches". */
export function matchesQuery(game: SearchableGame, query: ResolvedQuery): boolean {
  if (query.terms.length > 0) {
    const names = nameTokens(game)
    if (!query.terms.every((match) => satisfies(names, match))) return false
  }
  const f = query.filters
  if (f.yearFrom != null && !(game.year != null && game.year >= f.yearFrom)) return false
  if (f.yearTo != null && !(game.year != null && game.year <= f.yearTo)) return false
  if (f.result && game.result !== f.result) return false
  if (f.eco && !(game.eco ?? '').toUpperCase().startsWith(f.eco.toUpperCase())) return false
  if (f.minRating != null && !(game.minElo != null && game.minElo >= f.minRating)) return false
  if (f.speed && game.speed !== f.speed) return false
  if (f.source && game.source !== f.source) return false
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
 * `names` and `namePrefix` are both the **multiEntry** index, so a query through
 * either **must** be paired with `.distinct()`: one game can sit at several keys
 * inside the range being walked (two of its names matching, or two tokens
 * sharing a prefix) and would otherwise come back once per hit. Plan §10 flags
 * this — a compound index cannot be multiEntry, which is why this one stands
 * alone.
 */
export type QueryDriver =
  /** The resolved tokens of one word, looked up directly. */
  | { index: 'names'; tokens: string[] }
  /** A word with too many matches to enumerate, walked as a key range. */
  | { index: 'namePrefix'; prefix: string }
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
  residual: ResolvedQuery
  /**
   * True when the residual is empty — the driver *is* the query. Worth knowing
   * because it is the difference between counting an index range and walking it.
   */
  indexOnly: boolean
}

const EMPTY_RESIDUAL = (residual: ResolvedQuery): boolean =>
  residual.terms.length === 0 && Object.keys(residual.filters).length === 0

/**
 * Choose the index to drive a query, and say what it leaves over.
 *
 * A word of free text always wins, and among several the one with the **fewest
 * resolved tokens** goes first: that count is a real measure of selectivity
 * rather than a guess, which is the one place this planner knows more than a
 * heuristic. A word that could not be enumerated is used only if no word could.
 *
 * Below that the order is a **selectivity heuristic**, in rough order of how
 * much of a real database each field cuts away:
 *
 * 1. an ECO code — ~500 of them, and a full code is narrow;
 * 2. a year range — usually a slice, occasionally the whole thing;
 * 3. a rating floor — narrow at the top end, everything at the bottom;
 * 4. a source file — narrow only if several are attached;
 * 5. a result, then a speed — three or four values over the whole database, so
 *    these drive only when nothing else is on offer.
 *
 * Being wrong about the order costs time and never answers. The test that pins
 * "driver + residual = the whole query" is what buys that freedom.
 */
export function queryPlan(query: ResolvedQuery): QueryPlan {
  const filters = compact({ ...query.filters })
  const terms = [...query.terms]

  const driver = ((): QueryDriver => {
    if (terms.length > 0) {
      const enumerated = terms.filter((t) => t.tokens !== null)
      const chosen = enumerated.length
        ? enumerated.reduce((a, b) => (b.tokens!.length < a.tokens!.length ? b : a))
        : terms.reduce((a, b) => (b.term.length > a.term.length ? b : a))
      terms.splice(terms.indexOf(chosen), 1)
      return chosen.tokens !== null
        ? { index: 'names', tokens: chosen.tokens }
        : { index: 'namePrefix', prefix: chosen.term }
    }
    if (filters.eco) {
      const prefix = filters.eco
      delete filters.eco
      return { index: 'eco', prefix }
    }
    if (filters.yearFrom != null || filters.yearTo != null) {
      const { yearFrom, yearTo } = filters
      delete filters.yearFrom
      delete filters.yearTo
      return {
        index: 'year',
        ...(yearFrom === undefined ? {} : { from: yearFrom }),
        ...(yearTo === undefined ? {} : { to: yearTo }),
      }
    }
    if (filters.minRating != null) {
      const atLeast = filters.minRating
      delete filters.minRating
      return { index: 'minElo', atLeast }
    }
    if (filters.source) {
      const value = filters.source
      delete filters.source
      return { index: 'source', value }
    }
    if (filters.result) {
      const value = filters.result
      delete filters.result
      return { index: 'result', value }
    }
    if (filters.speed) {
      const value = filters.speed
      delete filters.speed
      return { index: 'speed', value }
    }
    return { index: 'none' }
  })()

  const residual: ResolvedQuery = { filters, terms }
  return { driver, residual, indexOnly: EMPTY_RESIDUAL(residual) }
}
