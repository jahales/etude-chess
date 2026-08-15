/**
 * The attached game database — storage for imported PGN (#53, ADR 0018).
 *
 * Deliberately a **separate table** from `games` in db.ts. Those are games *you
 * played*, carrying the coach's verdict on each of your moves; these are games
 * you *imported*, carrying whatever annotations came with the file. They share
 * almost no fields and nothing sensible reads both at once, so keeping them
 * apart means neither has to grow an "is this actually mine?" column.
 *
 * Two decisions worth not re-deriving:
 *
 * - **Movetext is stored as text.** One byte per move (an index into the legal
 *   moves) is 5× smaller, but producing it needs legal-move generation at every
 *   ply — measured at ~12 games/sec, over two hours for a 100k-game import.
 *   CPU is the binding constraint, not storage: 100k games of raw PGN is ~76 MB,
 *   well inside Chrome's and Firefox's quotas. The byte encoding stays a
 *   documented escape hatch (docs/spikes/games-corpus.md §5).
 * - **The dedup key is the primary key.** Importing the same file twice
 *   overwrites row for row instead of doubling the database, which is what makes
 *   re-attaching after an eviction free rather than a merge problem.
 *
 * Everything here is best-effort in the same sense as db.ts — the app keeps
 * running when storage is unavailable — but an import reports its failures
 * rather than swallowing them: a quota error mid-import is something the user
 * has to know about.
 */

import { dedupKey, type GameFacts, type GameResult, type ImportedGame, type Speed } from '../domain/pgnImport'
import type { PositionEval } from '../domain/gameRecord'
import {
  matchesQuery,
  nameTokens,
  queryPlan,
  queryTokens,
  resolveQuery,
  PAGE_SIZE,
  type GameQuery,
  type QueryDriver,
  type QueryPlan,
  type ResolvedQuery,
} from '../domain/dbQuery'
import { expandTerms, invalidateSearchIndex } from './searchIndex'
import { getDb, type EtudeDb } from './db'

/** One imported game. Field names match `GameFacts` so the mapping stays boring. */
export interface DbGame {
  /** Primary key: White+Black+Date+Event+Result+a hash of the whole game. */
  key: string
  white: string
  black: string
  event?: string
  site?: string
  date?: string
  year?: number
  result: GameResult
  eco?: string
  whiteElo?: number
  blackElo?: number
  /** The lower of the two ratings. Absent when either is unknown — never a zero. */
  minElo?: number
  speed: Speed
  /** The `[TimeControl]` tag verbatim, so the UI can show what the file said. */
  timeControl?: string
  plies: number
  /** Mainline SAN, space-separated. Text, not a move encoding — see above. */
  movetext: string
  /**
   * The position the game starts from, when it is not the standard one.
   *
   * Absent for the overwhelming majority. Without it a study or endgame
   * collection replayed its movetext from move 1 — see `GameFacts.startFen`.
   * Rows imported before this existed have no way to recover it; re-attaching
   * the file fixes them.
   */
  startFen?: string
  /** The file's own comments, by ply. Item 11 shows these at the reveal. */
  comments?: Record<number, string>
  nags?: Record<number, number[]>
  /** Provenance: the file this came from, and when it was attached. */
  source: string
  importedAt: number
  /**
   * Searchable tokens of White, Black and Event (`domain/dbQuery.nameTokens`),
   * carried on the row because a **multiEntry** index can only index a field
   * that is there (#54). Optional in the type because rows written by #53
   * predate it — `db.ts`'s v4 upgrade backfills them, and this stays optional so
   * a reader can never assume a migration ran.
   */
  names?: string[]
}

/**
 * A whole-game analysis pass over an imported game (#133).
 *
 * One row per game, in its own table rather than as columns on `DbGame` —
 * `db.ts`'s v7 comment has the reasoning, and it is about what a 100k-game
 * import costs, not about tidiness. Field names match `StoredGame`'s so the one
 * pure pass (`app/gameAnalysis.ts`) can serve both without a translation layer.
 *
 * Everything but the key is optional, in the same sense as everywhere else here:
 * absent means "not recorded", never an error.
 */
export interface DbGameAnalysis {
  /** Primary key: the `DbGame.key` this is an analysis of. */
  key: string
  /**
   * Eval after each ply, White's perspective. Sparse — a gap is a position the
   * pass could not score, and must stay distinguishable from a score of zero.
   */
  evalByPly?: (PositionEval | undefined)[]
  /**
   * Evaluation of the position *before* move 0. `evalByPly` is indexed by the
   * move it follows, so without this the first move can never be scored (#74).
   */
  startEval?: PositionEval
  /** When the pass completed. Absent ⇒ it was interrupted; the evals so far still stand. */
  analysedAt?: number
  /** Nodes per position, so a later pass can tell whether this work still counts. */
  analysisNodes?: number
  /**
   * The position the pass started from — the game's `startFen`, absent for the
   * standard start.
   *
   * Stored so a stale analysis can be spotted rather than served. The dedup key
   * hashes the movetext but **not** the `[FEN]` tag (`domain/pgnImport.keyFrom`),
   * and rows imported before #128 carry no `startFen` at all — so re-attaching a
   * file can replace the row under a key an older analysis is still filed at,
   * with every evaluation in it belonging to a different game. `getDbAnalysis`
   * discards on a mismatch; the cost is one pass, and the alternative is scores
   * that are quietly about positions the user is not looking at.
   */
  startFen?: string
}

/** One attached file, so the UI can list what is attached and offer to re-attach. */
export interface DbSource {
  /** Primary key: the file's name. Re-importing it updates this row. */
  name: string
  importedAt: number
  /** Games kept. */
  games: number
  /** Games the parser produced, kept or not. */
  parsed: number
  skipped: number
  sizeBytes?: number
}

/**
 * Rows per transaction. §9's guidance is 500–1000: Dexie sustains ~3k rec/s, so
 * a chunk is roughly a fifth of a second — small enough that progress moves and
 * large enough that per-transaction overhead stays in the noise.
 */
export const BULK_CHUNK = 500

/** Drop keys whose value is `undefined` so Dexie stores absent rather than `undefined`. */
function defined<T extends object>(record: T): T {
  return Object.fromEntries(Object.entries(record).filter(([, v]) => v !== undefined)) as T
}

/** An imported game plus its provenance → the row we store. */
export function toDbGame(
  game: ImportedGame,
  facts: GameFacts,
  provenance: { source: string; importedAt: number },
): DbGame {
  return defined<DbGame>({
    key: dedupKey(game),
    white: facts.white,
    black: facts.black,
    event: facts.event,
    site: facts.site,
    date: facts.date,
    year: facts.year,
    result: facts.result,
    eco: facts.eco,
    whiteElo: facts.whiteElo,
    blackElo: facts.blackElo,
    minElo: facts.minElo,
    speed: facts.timeControl.speed,
    timeControl: facts.timeControl.raw,
    plies: facts.plies,
    movetext: game.sanMoves.join(' '),
    startFen: facts.startFen,
    comments: game.comments,
    nags: game.nags,
    source: provenance.source,
    importedAt: provenance.importedAt,
    names: nameTokens(facts),
  })
}

export interface BulkPutResult {
  written: number
  /** Set when a chunk failed — a full quota, most likely. Earlier chunks stand. */
  error?: string
}

/**
 * Write games in chunked transactions.
 *
 * Reports rather than throws: an import that hits the storage quota has still
 * written everything before that point, and the caller needs to say so instead
 * of losing the whole run.
 */
export async function putDbGames(games: DbGame[], chunkSize = BULK_CHUNK): Promise<BulkPutResult> {
  const d = getDb()
  if (!d || games.length === 0) return { written: 0 }

  let written = 0
  for (let i = 0; i < games.length; i += chunkSize) {
    const chunk = games.slice(i, i + chunkSize)
    try {
      await d.dbGames.bulkPut(chunk)
      written += chunk.length
    } catch (e) {
      console.warn('etude-chess: could not store imported games', e)
      return { written, error: e instanceof Error ? e.message : 'could not store games' }
    }
  }
  return { written }
}

/**
 * Which of these games are already stored (#145).
 *
 * A `bulkPut` overwrites by key without saying whether it landed on a row or
 * made one, so a sync that re-fetches a month it partly had could only report
 * "12 imported" for twelve games that were all already there. Asked *before* the
 * write, and against the index alone — `primaryKeys()` reads keys, never the
 * movetext beside them, which is the difference between a few kB and a few MB
 * for a busy month.
 */
export async function existingDbGameKeys(keys: readonly string[]): Promise<Set<string>> {
  const d = getDb()
  if (!d || keys.length === 0) return new Set()
  try {
    // `anyOf` wants its keys sorted; Dexie then walks the index once.
    const found = await d.dbGames.where(':id').anyOf([...keys].sort()).primaryKeys()
    return new Set(found)
  } catch (e) {
    // Not knowing is not a reason to refuse to import: the write below still
    // deduplicates by key, and the count is a report, not a gate.
    console.warn('etude-chess: could not check for games already stored', e)
    return new Set()
  }
}

/** How many stored games came from one source. Counts an index; loads no rows. */
export async function countDbGamesFromSource(source: string): Promise<number> {
  const d = getDb()
  if (!d) return 0
  try {
    return await d.dbGames.where('source').equals(source).count()
  } catch (e) {
    console.warn('etude-chess: could not count the games from that source', e)
    return 0
  }
}

// ---------- browsing (#54, plan §10) ----------

/**
 * How many matches a filtered count will look at before it gives up and says
 * "more than this".
 *
 * A query the driving index answers by itself is counted from the index and is
 * exact whatever its size. A query with a residual has to *walk* the driver's
 * range to apply it, and over 100k games an exact total would mean reading every
 * row to put one number on screen. "1,000+" is worth more than a spinner.
 */
export const COUNT_CAP = 1000

/** One page of results, plus what the caller needs to draw the pager. */
export interface DbGamePage {
  rows: DbGame[]
  /** Whether a further page exists. Known by fetching one row more than asked for. */
  hasMore: boolean
  /**
   * The index the rows came back through — which is also the order they are in,
   * since sorting them any other way would mean loading all of them first.
   */
  order: QueryDriver['index']
}

export interface DbGameCount {
  count: number
  /** False when the count stopped at `COUNT_CAP`, so the real total is higher. */
  exact: boolean
}

/**
 * Resolve a query's free text through the search index (#54, ADR 0018 §6).
 *
 * This is the only place the fuzzy matcher is consulted. Everything below works
 * from the resolved tokens, so the rules stay pure and the matcher stays
 * replaceable.
 */
async function resolve(query: GameQuery): Promise<ResolvedQuery> {
  const terms = query.text ? queryTokens(query.text) : []
  const expanded = await expandTerms(terms)
  let i = 0
  return resolveQuery(query, () => expanded[i++] ?? null)
}

/**
 * A query plan → the Dexie collection that walks it.
 *
 * The one rule here that is not obvious: **both name drivers must be
 * `.distinct()`**. `names` is a multiEntry index, so one game sits at several
 * keys inside the range being walked whenever two of its tokens match — two
 * spellings of the same surname resolved together, "Hastings" as both player and
 * event, two tokens sharing a prefix — and would otherwise be yielded once per
 * hit (plan §10).
 *
 * `none` walks the primary key rather than `orderBy('year')`, because a game
 * whose file gave no date has no entry in the year index and would silently
 * vanish from the unfiltered list. The primary key is the dedup key, which
 * begins with White, so browsing everything is alphabetical by White.
 */
function collectionFor(d: EtudeDb, driver: QueryDriver) {
  const t = d.dbGames
  switch (driver.index) {
    case 'names':
      // `anyOf` wants its keys sorted; Dexie then walks the index once, jumping
      // between them, rather than once per key.
      return t.where('names').anyOf([...driver.tokens].sort()).distinct()
    case 'namePrefix':
      return t.where('names').startsWith(driver.prefix).distinct()
    case 'eco':
      return t.where('eco').startsWithIgnoreCase(driver.prefix)
    case 'year':
      if (driver.from != null && driver.to != null) {
        return t.where('year').between(driver.from, driver.to, true, true)
      }
      return driver.from != null
        ? t.where('year').aboveOrEqual(driver.from)
        : t.where('year').belowOrEqual(driver.to!)
    case 'minElo':
      return t.where('minElo').aboveOrEqual(driver.atLeast)
    case 'source':
      return t.where('source').equals(driver.value)
    case 'result':
      return t.where('result').equals(driver.value)
    case 'speed':
      return t.where('speed').equals(driver.value)
    case 'none':
      return t.toCollection()
  }
}

/** The driver's collection with anything it did not enforce re-checked on top. */
function matching(d: EtudeDb, plan: QueryPlan) {
  const collection = collectionFor(d, plan.driver)
  return plan.indexOnly ? collection : collection.filter((g) => matchesQuery(g, plan.residual))
}

/**
 * One page of the games matching a query.
 *
 * Never loads more than a page: `offset`/`limit` are applied to the index walk,
 * and one extra row is read to answer "is there a next page?" without counting
 * anything. That is the whole reason a plan exists — 100k games is a normal
 * import, and a results table that renders them all is a hung tab.
 */
export async function queryDbGames(
  query: GameQuery,
  page = 0,
  pageSize = PAGE_SIZE,
): Promise<DbGamePage> {
  const d = getDb()
  // `resolve` awaits `expandTerms`, which reaches into MiniSearch — so it has to
  // be inside the guard, not in front of it. Outside, anything it threw escaped
  // both this handler and the caller's, and `useDbBrowse` was left on its
  // loading state permanently with only a console warning to show for it.
  try {
    const plan = queryPlan(await resolve(query))
    if (!d) return { rows: [], hasMore: false, order: plan.driver.index }
    const rows = await matching(d, plan)
      .offset(page * pageSize)
      .limit(pageSize + 1)
      .toArray()
    return {
      rows: rows.slice(0, pageSize),
      hasMore: rows.length > pageSize,
      order: plan.driver.index,
    }
  } catch (e) {
    console.warn('etude-chess: could not search the attached database', e)
    // No plan to report an order from — it may be what failed. `key` is the
    // order an unplanned walk would have used anyway.
    return { rows: [], hasMore: false, order: 'none' }
  }
}

/**
 * How many games match, exactly where that is cheap and capped where it isn't.
 *
 * The honest caveat: the cap bounds the *matches* counted, not the rows
 * examined, so a query whose residual matches almost nothing still walks its
 * driver's range. That is why the planner spends its effort choosing a selective
 * driver — with a name in the query there always is one.
 */
export async function countMatchingDbGames(
  query: GameQuery,
  cap = COUNT_CAP,
): Promise<DbGameCount> {
  const d = getDb()
  if (!d) return { count: 0, exact: true }
  try {
    // Inside the guard for the same reason as `queryDbGames`: `resolve` awaits
    // term expansion, and a throw there used to escape this handler entirely.
    const plan = queryPlan(await resolve(query))
    // No residual: the index range *is* the answer, and IndexedDB counts a range
    // without reading the records in it.
    if (plan.indexOnly) return { count: await matching(d, plan).count(), exact: true }
    const keys = await matching(d, plan).limit(cap).primaryKeys()
    return { count: keys.length, exact: keys.length < cap }
  } catch (e) {
    console.warn('etude-chess: could not count the attached database', e)
    return { count: 0, exact: true }
  }
}

/** One imported game by its key. The seam #55 opens a game for study through. */
export async function getDbGame(key: string): Promise<DbGame | undefined> {
  const d = getDb()
  if (!d) return undefined
  try {
    return await d.dbGames.get(key)
  } catch (e) {
    console.warn('etude-chess: could not load the game', e)
    return undefined
  }
}

/** How many imported games are stored. Counts the index; loads no rows. */
export async function countDbGames(): Promise<number> {
  const d = getDb()
  if (!d) return 0
  try {
    return await d.dbGames.count()
  } catch {
    return 0
  }
}

/** Attached files, most recently attached first. */
export async function listDbSources(): Promise<DbSource[]> {
  const d = getDb()
  if (!d) return []
  try {
    return await d.dbSources.orderBy('importedAt').reverse().toArray()
  } catch (e) {
    console.warn('etude-chess: could not list attached databases', e)
    return []
  }
}

/** Record an attachment. Re-importing the same filename updates its row. */
export async function recordDbSource(source: DbSource): Promise<void> {
  const d = getDb()
  if (!d) return
  try {
    await d.dbSources.put(defined(source))
  } catch (e) {
    console.warn('etude-chess: could not record the attached database', e)
  }
}

/**
 * Detach a file: remove its games and its record. Returns how many games went.
 *
 * Analyses of those games are deliberately **left behind** — see `db.ts`'s v7
 * comment. They are a few kB each, they are filed under a key derived from the
 * game itself, and leaving them is what makes re-attaching the file give the
 * user their engine time back instead of asking for it again.
 */
export async function deleteDbSource(name: string): Promise<number> {
  const d = getDb()
  if (!d) return 0
  try {
    const removed = await d.dbGames.where('source').equals(name).delete()
    await d.dbSources.delete(name)
    // The vocabulary just changed, so the search index is stale by definition.
    await invalidateSearchIndex()
    return removed
  } catch (e) {
    console.warn('etude-chess: could not detach the database', e)
    return 0
  }
}

// ---------- analysing an imported game (#133) ----------

/**
 * The stored pass for a game, or nothing.
 *
 * Takes the row rather than its key so it can check the one thing that can go
 * wrong: that the pass was computed from the position this game actually starts
 * from. A row can be replaced under a key an older analysis is still filed at
 * (see `DbGameAnalysis.startFen`), and the evaluations would then describe
 * positions the game was never in. Discarding a mismatch costs one pass and is
 * the same answer `searchIndex`'s stamp gives to the same class of problem.
 *
 * Best-effort like every other read here: no storage, or a read that fails, is
 * an unanalysed game rather than an error (ADR 0011).
 */
export async function getDbAnalysis(
  game: Pick<DbGame, 'key' | 'startFen'>,
): Promise<DbGameAnalysis | undefined> {
  const d = getDb()
  if (!d) return undefined
  try {
    const stored = await d.dbAnalysis.get(game.key)
    if (!stored) return undefined
    return stored.startFen === game.startFen ? stored : undefined
  } catch (e) {
    console.warn('etude-chess: could not load the analysis', e)
    return undefined
  }
}

/**
 * Write a pass, replacing whatever was there.
 *
 * A plain `put`, unlike `db.ts`'s `saveAnalysis`, which merges: that row is
 * written by two independent writers (the play session and the pass) from
 * separate snapshots, and each was silently reverting the other's fields. This
 * table has exactly one writer, and a pass supersedes the pass before it.
 */
export async function saveDbAnalysis(analysis: DbGameAnalysis): Promise<void> {
  const d = getDb()
  if (!d) return
  try {
    await d.dbAnalysis.put(defined(analysis))
  } catch (e) {
    console.warn('etude-chess: could not persist the analysis', e)
  }
}
