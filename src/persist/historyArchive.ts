/**
 * Reading and writing the history archive (#152) — the storage half.
 *
 * The format, and every decision about what wins a merge, is pure and lives in
 * `domain/historyArchive.ts`. This module does the two things that need the
 * database: turn the tables into a stream of lines, and apply a stream of
 * records back onto them.
 *
 * Three properties are worth not re-deriving from the code below.
 *
 * - **Nothing is deleted, ever.** There is no path here that removes a row or
 *   replaces a field with a worse one. An import of an empty archive is a no-op;
 *   an import of somebody else's archive adds their history beside yours. That
 *   is the requirement, not a side effect of the implementation.
 * - **Everything is bounded.** Rows go out a page at a time and come in a chunk
 *   at a time, because the attached database this ships beside is written for
 *   10k–100k games. The one thing held whole in memory is the set of *existing*
 *   attempt identities, which is a few MB at tens of thousands of attempts and
 *   is the price of identifying a record that has no key of its own.
 * - **Best-effort on read, reported on write** — the same split as `dbGames.ts`.
 *   A read that fails means an emptier export, which the counts show; a write
 *   that fails during an import has to say so, because the user is about to
 *   believe their history arrived.
 */

import {
  ARCHIVE_SECTIONS,
  analysisApplies,
  analysisWins,
  attemptIdentity,
  emptyCounts,
  emptyReport,
  estimateSection,
  footerLine,
  headerLine,
  placeGame,
  recordLine,
  type ArchiveCounts,
  type ArchiveRecord,
  type ArchiveSection,
  type MergeReport,
  type SectionSize,
} from '../domain/historyArchive'
import { nameTokens } from '../domain/dbQuery'
import { getDb, type StoredAttempt, type StoredGame } from './db'
import {
  countDbGamesFromSource,
  type DbGame,
  type DbGameAnalysis,
  type DbSource,
} from './dbGames'
import { invalidateSearchIndex } from './searchIndex'

/** Rows read or written per step. `dbGames.ts`'s reasoning, and its number. */
const CHUNK = 500

/** Rows serialised to estimate a section's size. Enough to average a long game against a short one. */
const SAMPLE = 25

/** Drop keys whose value is `undefined`, so Dexie stores absent rather than undefined. */
function defined<T extends object>(record: T): T {
  return Object.fromEntries(Object.entries(record).filter(([, v]) => v !== undefined)) as T
}

// ---------- what is here, and roughly how big ----------

export interface ArchiveEstimate {
  sections: Record<ArchiveSection, SectionSize>
  /** Everything except the attached database — the part that cannot be re-fetched. */
  historyBytes: number
  /** The attached database on its own, which is the part that can be 2 GB. */
  databaseBytes: number
}

async function measure<T extends object>(
  section: ArchiveSection,
  rows: number,
  sample: T[],
): Promise<SectionSize> {
  const sizes = sample.map((row) => recordLine(section, row).length + 1)
  return estimateSection(rows, sizes, sample.length)
}

/**
 * How large an export would be, **before** one is built.
 *
 * The issue's requirement, and it is not a nicety: an attached master database
 * can be gigabytes while the attempts beside it are kilobytes, and the user
 * should know which of those they are about to write to disk. Measured on real
 * rows rather than assumed from a per-record constant — see `estimateSection`.
 *
 * The sample is the first N rows of each table, which for `dbGames` is
 * alphabetical by White rather than random. Good enough for an order of
 * magnitude, which is the decision this number is for.
 */
export async function estimateArchive(): Promise<ArchiveEstimate> {
  const empty = {
    sections: Object.fromEntries(
      ARCHIVE_SECTIONS.map((s) => [s, { rows: 0, bytes: 0, exact: true }]),
    ) as Record<ArchiveSection, SectionSize>,
    historyBytes: 0,
    databaseBytes: 0,
  }
  const d = getDb()
  if (!d) return empty
  try {
    const [attempts, games, dbSources, dbGames, dbAnalysis] = await Promise.all([
      d.attempts.count(),
      d.games.count(),
      d.dbSources.count(),
      d.dbGames.count(),
      d.dbAnalysis.count(),
    ])
    const sections = {
      attempt: await measure('attempt', attempts, await d.attempts.limit(SAMPLE).toArray()),
      game: await measure('game', games, await d.games.limit(SAMPLE).toArray()),
      dbSource: await measure('dbSource', dbSources, await d.dbSources.limit(SAMPLE).toArray()),
      dbGame: await measure('dbGame', dbGames, await d.dbGames.limit(SAMPLE).toArray()),
      dbAnalysis: await measure(
        'dbAnalysis',
        dbAnalysis,
        await d.dbAnalysis.limit(SAMPLE).toArray(),
      ),
    }
    return {
      sections,
      historyBytes:
        sections.attempt.bytes +
        sections.game.bytes +
        sections.dbAnalysis.bytes +
        sections.dbSource.bytes,
      databaseBytes: sections.dbGame.bytes,
    }
  } catch (e) {
    console.warn('etude-chess: could not size the export', e)
    return empty
  }
}

// ---------- writing ----------

export interface ExportOptions {
  /**
   * Include the attached database's games.
   *
   * Its own switch because it is the only part that can be gigabytes, and the
   * only part that is re-fetchable: a PGN file is on disk somewhere and a
   * chess.com account re-syncs in one click (#145). The analyses *of* those
   * games always travel — they are the expensive half and they are useless
   * without being small.
   */
  includeDatabase: boolean
}

/** Read a table in pages, so no export ever holds a whole table in memory. */
async function* pages<T>(
  read: (offset: number, limit: number) => Promise<T[]>,
): AsyncGenerator<T> {
  for (let offset = 0; ; offset += CHUNK) {
    const page = await read(offset, CHUNK)
    for (const row of page) yield row
    if (page.length < CHUNK) return
  }
}

/**
 * The archive, one line at a time.
 *
 * A generator rather than a string because the caller folds it into a `Blob` as
 * it goes: `JSON.stringify` over 100k games would build the whole file as a
 * single string first, which is the failure this format was chosen to avoid.
 *
 * `createdAt` and `app` are passed in — the domain has no clock, and this has no
 * business reading a build constant.
 */
export async function* archiveLines(
  options: ExportOptions,
  createdAt: number,
  app: string,
): AsyncGenerator<string> {
  yield headerLine(createdAt, app)
  const counts: ArchiveCounts = emptyCounts()
  const d = getDb()
  if (d) {
    for await (const row of pages<StoredAttempt>((o, l) => d.attempts.offset(o).limit(l).toArray())) {
      counts.attempt++
      yield recordLine('attempt', row)
    }
    for await (const row of pages<StoredGame>((o, l) => d.games.offset(o).limit(l).toArray())) {
      counts.game++
      yield recordLine('game', row)
    }
    for await (const row of pages<DbSource>((o, l) => d.dbSources.offset(o).limit(l).toArray())) {
      counts.dbSource++
      yield recordLine('dbSource', row)
    }
    if (options.includeDatabase) {
      for await (const row of pages<DbGame>((o, l) => d.dbGames.offset(o).limit(l).toArray())) {
        counts.dbGame++
        yield recordLine('dbGame', row)
      }
    }
    // Always, whether or not the games came with them: an analysis is the
    // expensive thing here, it is a few kB, and it is filed under a key derived
    // from the game — so it finds its game again whenever the file is attached.
    for await (const row of pages<DbGameAnalysis>((o, l) =>
      d.dbAnalysis.offset(o).limit(l).toArray(),
    )) {
      counts.dbAnalysis++
      yield recordLine('dbAnalysis', row)
    }
  }
  yield footerLine(counts)
}

// ---------- applying ----------

/**
 * Apply a stream of records, merging into what is here.
 *
 * The caller has already read the file once and satisfied itself that the whole
 * of it parses (`app/useHistoryTransfer.ts`) — which is why this can write as it
 * goes without risking a half-applied training history.
 *
 * Records are handled a section at a time because that is how they are written,
 * and the buffer is flushed whenever the section changes. The one place that
 * ordering matters is `dbGame` before `dbAnalysis`: an analysis is checked
 * against the game row it claims to be of, and the check is only meaningful once
 * that row has landed.
 */
export interface ApplyResult {
  report: MergeReport
  /**
   * Set when a *write* failed part-way — a full quota, most likely. What landed
   * before it stays, and the report says how much that was.
   *
   * The one thing an import is allowed to do half of, and it is deliberate:
   * `dbGames.ts` draws the same line, because "your history did not fit" is
   * something the user has to be told rather than something to swallow.
   */
  error?: string
}

export async function applyArchive(records: AsyncIterable<ArchiveRecord>): Promise<ApplyResult> {
  const report = emptyReport()
  const d = getDb()
  if (!d) return { report }

  // Identities of every attempt already here. An attempt has no key of its own
  // (see `attemptIdentity`), so the only way to know whether one is already
  // stored is to have looked at all of them.
  const seenAttempts = new Set<string>()
  for await (const row of pages<StoredAttempt>((o, l) => d.attempts.offset(o).limit(l).toArray())) {
    seenAttempts.add(attemptIdentity(row))
  }
  // Played games are dozens, not thousands, and `placeGame` has to be able to
  // walk a chain of ids synchronously.
  const gamesById = new Map<string, StoredGame>()
  for await (const row of pages<StoredGame>((o, l) => d.games.offset(o).limit(l).toArray())) {
    gamesById.set(row.gameId, row)
  }

  const touchedSources = new Set<string>()
  let importedDbGames = false
  let buffer: ArchiveRecord[] = []
  let section: ArchiveSection | null = null

  /** Writes the buffered section. Returns the sentence to show if storage refused. */
  const flush = async (): Promise<string | undefined> => {
    if (!section || buffer.length === 0) return undefined
    const rows = buffer
    buffer = []
    switch (section) {
      case 'attempt':
        return await applyAttempts(rows, seenAttempts, report)
      case 'game':
        return await applyGames(rows, gamesById, report)
      case 'dbSource':
        return await applySources(rows, report, touchedSources)
      case 'dbGame':
        importedDbGames = true
        return await applyDbGames(rows, report, touchedSources)
      case 'dbAnalysis':
        return await applyAnalyses(rows, report)
    }
  }

  let error: string | undefined
  try {
    for await (const record of records) {
      if (record.t !== section) {
        error = await flush()
        if (error) break
        section = record.t
      }
      buffer.push(record)
      if (buffer.length >= CHUNK) {
        error = await flush()
        if (error) break
      }
    }
    if (!error) error = await flush()
  } catch (e) {
    // A record the reader could not parse. Pass one has already been over the
    // whole file, so this is a file that changed under us or a bug — either way
    // what was written stays and is reported.
    error = message(e)
  }

  // The vocabulary the search index is built from just changed, and a stale
  // index looks exactly like "you have no games by that player" (#54). Done even
  // after a failed write, because a partial import changed it just as much.
  if (importedDbGames) await invalidateSearchIndex()
  // An attached source's row says how many games came from it; after a merge
  // that number is whatever is actually stored, not what either device wrote.
  await recountSources(touchedSources)
  return error === undefined ? { report } : { report, error }
}

async function applyAttempts(
  rows: ArchiveRecord[],
  seen: Set<string>,
  report: MergeReport,
): Promise<string | undefined> {
  const d = getDb()!
  const fresh: StoredAttempt[] = []
  for (const { r } of rows) {
    const attempt = defined(r as unknown as StoredAttempt)
    const identity = attemptIdentity(attempt)
    if (seen.has(identity)) {
      report.sections.attempt.unchanged++
      continue
    }
    // Within one file too: an export can only contain a duplicate if the
    // database did, but a hand-concatenated file can, and importing it twice
    // must still leave one copy.
    seen.add(identity)
    delete (attempt as { id?: number }).id
    fresh.push(attempt)
  }
  if (fresh.length === 0) return undefined
  try {
    await d.attempts.bulkAdd(fresh)
    report.sections.attempt.added += fresh.length
  } catch (e) {
    console.warn('etude-chess: could not store imported attempts', e)
    return `Storage stopped accepting attempts (${message(e)}).`
  }
  return undefined
}

/**
 * Merge a played game onto the row it belongs to, or beside it.
 *
 * The merge is field-by-field in one direction only: the incoming row supplies
 * what this one does not have, and the analysis fields move as a **set** — a
 * pass is `evalByPly` + `startEval` + `analysedAt` + `analysisNodes` together,
 * and mixing halves of two passes is how evaluations from two budgets end up on
 * one game and manufacture swings out of nothing.
 */
async function applyGames(
  rows: ArchiveRecord[],
  gamesById: Map<string, StoredGame>,
  report: MergeReport,
): Promise<string | undefined> {
  const d = getDb()!
  for (const { r } of rows) {
    const incoming = defined(r as unknown as StoredGame)
    const sanHistory = Array.isArray(incoming.sanHistory) ? incoming.sanHistory : []
    const placed = placeGame<StoredGame>(
      { gameId: incoming.gameId, createdAt: incoming.createdAt, sanHistory },
      (id) => gamesById.get(id),
    )
    if (placed.renamed) report.renamed++
    const merged: StoredGame = placed.onto
      ? mergeGame(placed.onto, incoming)
      : { ...incoming, gameId: placed.gameId }
    delete merged.id
    if (placed.onto) {
      // Nothing to write: the row here already says everything the file does.
      if (unchanged(placed.onto, merged)) {
        report.sections.game.unchanged++
        continue
      }
      merged.id = placed.onto.id
      report.sections.game.updated++
    } else {
      report.sections.game.added++
    }
    try {
      await d.games.put(merged)
    } catch (e) {
      console.warn('etude-chess: could not store an imported game', e)
      return `Storage stopped accepting games (${message(e)}).`
    }
    gamesById.set(merged.gameId, merged)
  }
  return undefined
}

/** The incoming row fills gaps; a better analysis replaces the one here whole. */
function mergeGame(existing: StoredGame, incoming: StoredGame): StoredGame {
  const { evalByPly, startEval, analysedAt, analysisNodes, id: _id, ...rest } = incoming
  const merged = { ...existing } as unknown as Record<string, unknown>
  for (const [key, value] of Object.entries(rest)) {
    if (value === undefined) continue
    if (merged[key] === undefined || merged[key] === null) merged[key] = value
  }
  if (analysisWins(existing, { evalByPly, startEval, analysedAt, analysisNodes })) {
    Object.assign(merged, defined({ evalByPly, startEval, analysedAt, analysisNodes }))
  }
  return merged as unknown as StoredGame
}

const unchanged = (a: StoredGame, b: StoredGame): boolean =>
  JSON.stringify({ ...a, id: undefined }) === JSON.stringify({ ...b, id: undefined })

/**
 * An attached source, but only if this device does not already know it.
 *
 * The row here describes an import that happened *on this machine* — when, how
 * many games, how many the filters dropped — and the file's copy describes one
 * that happened somewhere else. Neither is more true than the other, so the one
 * already here stands and the count is recomputed at the end from what is
 * actually stored.
 */
async function applySources(
  rows: ArchiveRecord[],
  report: MergeReport,
  touched: Set<string>,
): Promise<undefined> {
  const d = getDb()!
  for (const { r } of rows) {
    const source = defined(r as unknown as DbSource)
    touched.add(source.name)
    try {
      if (await d.dbSources.get(source.name)) {
        report.sections.dbSource.unchanged++
        continue
      }
      await d.dbSources.put(source)
      report.sections.dbSource.added++
    } catch (e) {
      console.warn('etude-chess: could not record an imported source', e)
      report.sections.dbSource.skipped++
    }
  }
  return undefined
}

/**
 * Imported games, which are the one section that gets idempotency for free.
 *
 * The dedup key (#128) is the primary key, so a `bulkPut` lands on the same row
 * whether the game arrived from a file, from a chess.com sync, or from an
 * archive written on another machine — that is the property #145 leans on and it
 * holds here unchanged. The only work is telling "added" from "already here",
 * which a `bulkPut` will not report, so the keys are asked for first.
 */
async function applyDbGames(
  rows: ArchiveRecord[],
  report: MergeReport,
  touched: Set<string>,
): Promise<string | undefined> {
  const d = getDb()!
  const games = rows.map(({ r }) => {
    const game = defined(r as unknown as DbGame)
    touched.add(game.source)
    // Rows written before #54 carry no `names`, and a multiEntry index can only
    // index a field that is there — so without this they would be stored and be
    // silently missing from every search. `db.ts`'s v4 upgrade does the same for
    // rows already here; this is that backfill for rows arriving now.
    return game.names?.length ? game : { ...game, names: nameTokens(game) }
  })
  try {
    const present = new Set(
      await d.dbGames.where(':id').anyOf(games.map((g) => g.key).sort()).primaryKeys(),
    )
    await d.dbGames.bulkPut(games)
    for (const game of games) {
      if (present.has(game.key)) report.sections.dbGame.unchanged++
      else report.sections.dbGame.added++
    }
  } catch (e) {
    console.warn('etude-chess: could not store imported database games', e)
    return `Storage stopped accepting games (${message(e)}).`
  }
  return undefined
}

/**
 * The expensive rows: a whole-game pass over an imported game (#133).
 *
 * Two checks, and both of them protect the same thing — that a stored pass is
 * about the game it is filed against, at the budget it claims.
 *
 * `analysisApplies` is the trap #133 wrote down: the dedup key hashes movetext
 * but not the `[FEN]` tag, so an analysis carries its own `startFen` and is
 * discarded on a mismatch. An import that ignored that would attach minutes of
 * engine work to a row it was never computed for.
 *
 * `analysisWins` is #144's: a completed deeper pass supersedes a shallower one
 * and nothing supersedes it, so the budget has to survive the trip.
 */
async function applyAnalyses(
  rows: ArchiveRecord[],
  report: MergeReport,
): Promise<string | undefined> {
  const d = getDb()!
  const analyses = rows.map(({ r }) => defined(r as unknown as DbGameAnalysis))
  const keys = analyses.map((a) => a.key)
  let existing: (DbGameAnalysis | undefined)[] = []
  let games: (DbGame | undefined)[] = []
  try {
    ;[existing, games] = await Promise.all([d.dbAnalysis.bulkGet(keys), d.dbGames.bulkGet(keys)])
  } catch (e) {
    console.warn('etude-chess: could not read the analyses already stored', e)
    return undefined
  }
  const write: DbGameAnalysis[] = []
  analyses.forEach((analysis, i) => {
    if (!analysisApplies(analysis, games[i])) {
      // A different game sits under this key on this device. The pass is not
      // wrong, it is about something else — dropping it is the same answer
      // `getDbAnalysis` gives when it reads one.
      report.sections.dbAnalysis.skipped++
      return
    }
    const here = existing[i]
    if (!here) {
      write.push(analysis)
      report.sections.dbAnalysis.added++
      return
    }
    // An analysis here whose startFen no longer matches the row is already
    // being ignored on read, so anything applicable beats it.
    const stale = !analysisApplies(here, games[i])
    if (stale || analysisWins(here, analysis)) {
      write.push(analysis)
      report.sections.dbAnalysis.updated++
      return
    }
    report.sections.dbAnalysis.unchanged++
  })
  if (write.length === 0) return undefined
  try {
    await d.dbAnalysis.bulkPut(write)
  } catch (e) {
    console.warn('etude-chess: could not store imported analyses', e)
    return `Storage stopped accepting analyses (${message(e)}).`
  }
  return undefined
}

/**
 * Put the real game count back on every source an import touched.
 *
 * `DbSource.games` is what the "Attached" table prints, and after a merge
 * neither device's number is right — the file says what *that* machine imported
 * and the row here says what this one did. Counting an index is cheap and the
 * number then means what the column says it means.
 */
async function recountSources(names: Set<string>): Promise<void> {
  const d = getDb()
  if (!d || names.size === 0) return
  for (const name of names) {
    try {
      const source = await d.dbSources.get(name)
      if (!source) continue
      const games = await countDbGamesFromSource(name)
      if (games !== source.games) await d.dbSources.put({ ...source, games })
    } catch (e) {
      console.warn('etude-chess: could not update the attached source count', e)
    }
  }
}

const message = (e: unknown) => (e instanceof Error ? e.message : 'storage refused the write')
