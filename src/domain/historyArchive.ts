/**
 * The history archive — what an export *is*, and what an import is allowed to
 * do with it (#152).
 *
 * IndexedDB is per-origin and per-profile, so nothing here travels: sync your
 * games in one browser and the review screen is empty in another (and
 * `localhost:5173` and `127.0.0.1:5173` are two origins besides). Durability
 * *within* a profile is `persist/storage.ts`'s job and is already handled. This
 * is portability, which nothing addressed.
 *
 * **The games are the cheap part.** Since #145 a full re-sync from chess.com is
 * one click, and chess.com is the durable source of truth. What cannot be
 * re-fetched is the analysis (#133 — minutes of engine per game) and the
 * attempts: your answers, your tiers, and the free-text reason you typed before
 * each reveal. There is no source to re-derive an attempt from. The rules below
 * are written in that order of care; games ride along for convenience and
 * offline use.
 *
 * ## Why JSON Lines and not one JSON document
 *
 * An attached master database is 10k–100k games (~76 MB of movetext at 100k),
 * and `JSON.stringify` over an array that size builds the whole thing as one
 * string first — the same "read it all into memory" mistake `content/pgnImport`
 * exists to avoid, in the other direction. So the file is **one JSON value per
 * line**: a header, then a record per row, then a footer. Both ends stream, and
 * the format stays something you can open in a text editor and read.
 *
 * ## Four rules the format is built around
 *
 * - **Merge, never replace.** Nothing an import does may remove or downgrade
 *   history already on the target. Every rule below resolves ties in favour of
 *   what is already here.
 * - **Idempotent.** Importing the same file twice leaves one copy. Games get
 *   this free from the dedup key (#128); attempts are identified by their whole
 *   content (`attemptIdentity`) and analyses by the game they are of.
 * - **Versioned, and refused rather than half-applied.** A file this build does
 *   not understand is rejected with a reason and *nothing* is written — which is
 *   why an import reads the file twice (see `ARCHIVE_VERSION`).
 * - **Nothing is derived on the way through.** An analysis carries the
 *   `startFen` it ran from and the node budget it ran at, because both are
 *   load-bearing downstream and neither can be recovered from the evaluations.
 *
 * Pure, like everything else in `src/domain`: no I/O, no clock. The caller
 * supplies the timestamp for the header.
 */

// ---------- the format ----------

/** The first line's `format` field. Anything else is not one of our files. */
export const ARCHIVE_FORMAT = 'etude-chess-history'

/**
 * The format version this build writes.
 *
 * Bump it when a change means an older build would *misread* a file — not for
 * adding a field, which is absent-means-not-recorded like every other stored
 * record here. `MIN_READABLE_VERSION` is the oldest we still know how to apply.
 */
export const ARCHIVE_VERSION = 1

/** The oldest version this build can still read. */
export const MIN_READABLE_VERSION = 1

/**
 * The tables an archive carries, in the order they are written.
 *
 * The order is load-bearing in exactly one place: `dbGame` comes before
 * `dbAnalysis`, so an analysis is resolved against the game row it belongs to
 * *after* that row has landed (see `analysisApplies`). Everything else is
 * written smallest-and-most-precious first, so that a human opening the file in
 * an editor sees the attempts at the top.
 */
export const ARCHIVE_SECTIONS = ['attempt', 'game', 'dbSource', 'dbGame', 'dbAnalysis'] as const

export type ArchiveSection = (typeof ARCHIVE_SECTIONS)[number]

/** Prose for each section, for a UI that has to say what it did. */
export const SECTION_LABEL: Record<ArchiveSection, string> = {
  attempt: 'Guesses you committed',
  game: 'Games you played',
  dbSource: 'Attached sources',
  dbGame: 'Games in the database',
  dbAnalysis: 'Engine analyses',
}

export type ArchiveCounts = Record<ArchiveSection, number>

export const emptyCounts = (): ArchiveCounts => ({
  attempt: 0,
  game: 0,
  dbSource: 0,
  dbGame: 0,
  dbAnalysis: 0,
})

/** Line 1. Deliberately tiny: what this is, and whether we can read it. */
export interface ArchiveHeader {
  format: typeof ARCHIVE_FORMAT
  version: number
  /** When the export was taken (ms since epoch). Supplied by the caller. */
  createdAt: number
  /** The app version that wrote it — for a bug report, never for a decision. */
  app: string
}

/**
 * The last line, and the reason a truncated file can be refused.
 *
 * The counts are what was actually written. A file whose body does not match
 * them, or which has no footer at all, ended early — a stopped download, a full
 * disk, a copy interrupted — and a training history half-imported is worse than
 * one refused.
 */
export interface ArchiveFooter {
  end: typeof ARCHIVE_FORMAT
  counts: ArchiveCounts
}

/** One row, tagged with the table it came from. */
export interface ArchiveRecord {
  t: ArchiveSection
  r: Record<string, unknown>
}

// ---------- writing ----------

export function headerLine(createdAt: number, app: string): string {
  const header: ArchiveHeader = {
    format: ARCHIVE_FORMAT,
    version: ARCHIVE_VERSION,
    createdAt,
    app,
  }
  return JSON.stringify(header)
}

export function footerLine(counts: ArchiveCounts): string {
  const footer: ArchiveFooter = { end: ARCHIVE_FORMAT, counts }
  return JSON.stringify(footer)
}

/**
 * One row → one line.
 *
 * `id` is dropped on the way out: it is IndexedDB's auto-increment key, it means
 * nothing on another machine, and carrying it would invite an import to write
 * rows at ids the target's own sequence is going to hand out again.
 */
export function recordLine(t: ArchiveSection, row: object): string {
  const { id: _id, ...rest } = row as Record<string, unknown>
  return JSON.stringify({ t, r: rest } satisfies ArchiveRecord)
}

// ---------- reading ----------

/** Either a value, or the sentence to show the user about why there isn't one. */
export type Read<T> = { ok: true; value: T } | { ok: false; error: string }

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error })

const NOT_OURS =
  'This is not an étude history file. Pick the file an export produced — it starts with a line saying so. Nothing has been imported.'

function parseLine(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line)
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/**
 * Line 1, or a refusal.
 *
 * The version check is the whole point of the header, and it refuses in **both**
 * directions. A newer file is the dangerous one: its records would parse, most
 * of their fields would apply, and whatever the new version added would be
 * dropped silently — which for a training history is the worst outcome
 * available. Say what the file is and stop.
 */
export function readHeader(line: string): Read<ArchiveHeader> {
  const parsed = parseLine(line)
  if (!parsed || parsed.format !== ARCHIVE_FORMAT) return fail(NOT_OURS)
  const version = parsed.version
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    return fail(
      'This history file does not say which format version it is, so it cannot be read safely. Nothing has been imported.',
    )
  }
  if (version > ARCHIVE_VERSION) {
    return fail(
      `This file was written by a newer version of étude (format ${version}); this one reads up to format ${ARCHIVE_VERSION}. Update étude and import it again — nothing has been imported.`,
    )
  }
  if (version < MIN_READABLE_VERSION) {
    return fail(
      `This file is in format ${version}, which this version of étude no longer reads (the oldest it understands is ${MIN_READABLE_VERSION}). Nothing has been imported.`,
    )
  }
  return {
    ok: true,
    value: {
      format: ARCHIVE_FORMAT,
      version,
      createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : 0,
      app: typeof parsed.app === 'string' ? parsed.app : 'unknown',
    },
  }
}

/**
 * The fields that make a row *identifiable*, per section.
 *
 * Checked on every line, and a row missing one is a refusal rather than a skip:
 * a record we cannot file is a record we would either drop silently or write
 * somewhere wrong, and both are worse than declining the file. The rest of a
 * row is deliberately **not** validated — every stored record here is
 * forward-compatible, absent means "not recorded", and a schema check would
 * turn that into an error the first time a field is added.
 */
const REQUIRED: Record<ArchiveSection, readonly string[]> = {
  attempt: ['gameId', 'sessionId', 'createdAt'],
  game: ['gameId', 'sanHistory'],
  dbSource: ['name'],
  dbGame: ['key', 'movetext'],
  dbAnalysis: ['key'],
}

const isSection = (t: unknown): t is ArchiveSection =>
  typeof t === 'string' && (ARCHIVE_SECTIONS as readonly string[]).includes(t)

/**
 * One body line: a record, the footer, or a refusal.
 *
 * An unrecognised `t` is refused rather than skipped. Within a version we know
 * every table there is, so an unknown one means the file is not what its header
 * claims — which is exactly the case the version number exists to catch and
 * cannot, because the header would still say 1.
 */
export function readBodyLine(line: string): Read<ArchiveRecord | ArchiveFooter> {
  const parsed = parseLine(line)
  if (!parsed) return fail(truncated('a line in this file is not readable JSON'))
  if (parsed.end === ARCHIVE_FORMAT) {
    const counts = parsed.counts
    if (!counts || typeof counts !== 'object') return fail(truncated('its final line is incomplete'))
    const read = emptyCounts()
    for (const section of ARCHIVE_SECTIONS) {
      const n = (counts as Record<string, unknown>)[section]
      read[section] = typeof n === 'number' && Number.isFinite(n) ? n : 0
    }
    return { ok: true, value: { end: ARCHIVE_FORMAT, counts: read } }
  }
  if (!isSection(parsed.t)) {
    return fail(
      `This file contains a kind of record this version of étude does not know ("${String(parsed.t)}"). Nothing has been imported.`,
    )
  }
  const row = parsed.r
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    return fail(`A ${parsed.t} record in this file has nothing in it. Nothing has been imported.`)
  }
  const record = row as Record<string, unknown>
  for (const field of REQUIRED[parsed.t]) {
    if (record[field] === undefined || record[field] === null) {
      return fail(
        `A ${parsed.t} record in this file is missing its ${field}, so it cannot be filed. Nothing has been imported.`,
      )
    }
  }
  return { ok: true, value: { t: parsed.t, r: reviveRow(record) } }
}

const truncated = (what: string) =>
  `This history file ends part-way through — ${what}. It was probably truncated by an interrupted download or a full disk; export it again. Nothing has been imported.`

/** What a body with no footer at the end of it means. */
export const NO_FOOTER = truncated('it has no end marker')

export function countMismatch(section: ArchiveSection, declared: number, found: number): string {
  return truncated(
    `it says it holds ${declared} ${section} records and ${found} are actually in it`,
  )
}

/**
 * `null` inside an array is `undefined` coming back.
 *
 * `evalByPly` is deliberately **sparse** — a gap is a position the pass could
 * not score and must stay distinguishable from a score of zero — and JSON has
 * no hole, so `JSON.stringify` writes `null`. Reading it straight back would
 * make every gap a `null`, which is not what a `(PositionEval | undefined)[]`
 * says it is even though most readers happen to survive it.
 *
 * Only array *elements* are converted. A `null` on an object property is
 * meaningful and stays: `CoachEntry.bestMoveSan` is `string | null`, and "the
 * engine offered no best move" is not the same as "not recorded".
 */
function reviveRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(row)) out[key] = revive(value)
  return out
}

function revive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => (v === null ? undefined : revive(v)))
  if (value && typeof value === 'object') return reviveRow(value as Record<string, unknown>)
  return value
}

// ---------- identity: what makes two rows the same row ----------

/**
 * JSON with the keys in a fixed order, so two equal records produce one string.
 *
 * `JSON.stringify` preserves insertion order, and a row that has been through
 * IndexedDB, a file and a merge has no reason to keep the order it was written
 * in. Array holes become `null` here, exactly as they do on the way out, so an
 * identity survives the round trip.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${Array.from(value, canonicalJson).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
}

/**
 * What makes two attempts the same attempt: **everything about them**.
 *
 * An attempt has no natural key — `++id` is IndexedDB's and means nothing on
 * another machine — so identity is the whole record, canonically serialised.
 * That is a deliberate choice of which way to be wrong. Keying on
 * `sessionId + itemIndex` would be shorter and would *collapse* two records that
 * differ anywhere else; here the only records that collapse are byte-identical
 * ones, which are the same attempt by any definition. Two attempts that differ
 * in a single character of the typed reason both survive, and the reasons are
 * the part of this data with no other source.
 *
 * It also means the rule cannot drift when a field is added to `StoredAttempt`:
 * there is no field list here to forget to update.
 */
export function attemptIdentity(attempt: object): string {
  const { id: _id, ...rest } = attempt as Record<string, unknown>
  return canonicalJson(rest)
}

// ---------- merging: games you played ----------

/** The two fields that say a stored game is the game it claims to be. */
export interface GameIdentity {
  gameId: string
  createdAt: number
  sanHistory: string[]
}

/** Whether two rows are the same played game rather than two under one id. */
export function sameGame(a: GameIdentity, b: GameIdentity): boolean {
  return (
    a.createdAt === b.createdAt &&
    a.sanHistory.length === b.sanHistory.length &&
    a.sanHistory.every((san, i) => san === b.sanHistory[i])
  )
}

/**
 * Where an incoming played game goes: onto a row, or beside it.
 *
 * `gameId` is `m${Date.now()}` (`app/usePlaySession.ts`), which is unique on one
 * machine and *not* unique across two. Two games started in the same millisecond
 * on a laptop and a desktop would share an id, and a merge that trusted the id
 * would overwrite one of them with the other — the single thing an import is
 * forbidden to do. So the id is checked against the game itself, and a genuine
 * clash lands at `${gameId}~1`, `~2`, … instead of on top of anything.
 *
 * Deterministic, which is what keeps it idempotent: the same file imported twice
 * walks the same chain and finds its own row at `~1` the second time.
 */
export function placeGame<T extends GameIdentity>(
  incoming: GameIdentity,
  existing: (gameId: string) => T | undefined,
): { gameId: string; onto?: T; renamed: boolean } {
  let gameId = incoming.gameId
  for (let n = 0; ; n++) {
    const row = existing(gameId)
    if (!row) return { gameId, renamed: n > 0 }
    if (sameGame(row, { ...incoming, gameId })) return { gameId, onto: row, renamed: n > 0 }
    gameId = `${incoming.gameId}~${n + 1}`
  }
}

// ---------- merging: analysis passes ----------

/**
 * What an earlier pass recorded. Structural on purpose — the same two fields are
 * kept in two places (`StoredGame` for a game you played, `DbGameAnalysis` for
 * one you imported), and `app/gameAnalysis.ts`'s `AnalysisRecord` is the same
 * pair for the same reason.
 */
export interface AnalysisFields {
  analysedAt?: number
  analysisNodes?: number
  evalByPly?: unknown[]
  startEval?: unknown
}

/** Whether a record holds any engine work at all. */
export function hasAnalysis(a: AnalysisFields | undefined): boolean {
  return !!a && (a.analysedAt != null || a.startEval != null || (a.evalByPly?.length ?? 0) > 0)
}

/**
 * Whether an incoming pass should replace the one already here.
 *
 * The ordering is the one `app/gameAnalysis.supersedes` uses to decide whether
 * stored work answers a request, applied to two records instead of a record and
 * a budget: **a completed pass beats an unfinished one, and between two of the
 * same kind the deeper budget wins.** A tie keeps what is here, which is what
 * makes a second import of the same file change nothing.
 *
 * The budget is why an import must carry `analysisNodes` rather than
 * reconstructing it: #144 hangs `supersedes` off that number, so an import that
 * dropped it would make a 4M off-app pass look like a 400k one and invite the
 * app to redo three quarters of an hour of engine work over the top of it.
 *
 * Two partial passes at the same budget are *not* merged position by position.
 * It would be sound — the budget is what makes evaluations comparable — but a
 * completed pass is never at risk from this rule, and the failure mode of
 * getting it wrong is a game holding evaluations from two budgets, which
 * manufactures win% swings out of nothing.
 */
export function analysisWins(
  existing: AnalysisFields | undefined,
  incoming: AnalysisFields | undefined,
): boolean {
  if (!hasAnalysis(incoming)) return false
  if (!hasAnalysis(existing)) return true
  const done = (a: AnalysisFields) => a.analysedAt != null
  if (done(incoming!) !== done(existing!)) return done(incoming!)
  return (incoming!.analysisNodes ?? 0) > (existing!.analysisNodes ?? 0)
}

/**
 * Whether an imported-game analysis is about the game now stored under its key.
 *
 * **The trap #133 documented.** The dedup key hashes the movetext but *not* the
 * `[FEN]` tag, so a study or endgame collection can put a different game under
 * the same key — which is why an analysis carries the `startFen` it ran from and
 * `getDbAnalysis` throws away a mismatch. An import has to respect the same
 * rule, or it files minutes of engine work against a row it was never computed
 * for and the evaluations quietly describe positions the user is not looking at.
 *
 * A game we do not have is not a mismatch: the file may be attached later, and
 * the row is validated again when it is read.
 */
export function analysisApplies(
  analysis: { startFen?: string },
  game: { startFen?: string } | undefined,
): boolean {
  return !game || game.startFen === analysis.startFen
}

// ---------- what an import did ----------

export interface SectionReport {
  /** Rows that were not on this device before. */
  added: number
  /** Rows already here that took something better from the file. */
  updated: number
  /** Rows already here that the file had nothing new for. */
  unchanged: number
  /** Rows the file offered that do not belong on this device. */
  skipped: number
}

export interface MergeReport {
  sections: Record<ArchiveSection, SectionReport>
  /**
   * Played games whose id was already taken by a *different* game, and which
   * were therefore filed under a new one. Reported rather than buried: it is
   * rare, and it is the one case where what you see in the library is not
   * exactly what the file said.
   */
  renamed: number
}

export const emptyReport = (): MergeReport => ({
  sections: Object.fromEntries(
    ARCHIVE_SECTIONS.map((s) => [s, { added: 0, updated: 0, unchanged: 0, skipped: 0 }]),
  ) as Record<ArchiveSection, SectionReport>,
  renamed: 0,
})

/** Whether an import changed anything at all — the second-import case. */
export function changedNothing(report: MergeReport): boolean {
  return ARCHIVE_SECTIONS.every(
    (s) => report.sections[s].added === 0 && report.sections[s].updated === 0,
  )
}

/** Whether the file had anything in it for this device. */
export function isEmptyReport(report: MergeReport): boolean {
  return ARCHIVE_SECTIONS.every((s) => {
    const r = report.sections[s]
    return r.added + r.updated + r.unchanged + r.skipped === 0
  })
}

// ---------- size, before anything is written ----------

/**
 * What one section will cost, measured rather than guessed.
 *
 * An attached master database is the reason this exists: 200 kB and 2 GB are
 * both plausible exports and the difference is entirely how many games are
 * attached. The estimate comes from serialising a sample of real rows, because
 * a per-row constant is wrong by an order of magnitude between a 20-move
 * blitz game and an annotated 100-move classical one.
 */
export interface SectionSize {
  rows: number
  /** Estimated bytes, or the exact figure when every row was measured. */
  bytes: number
  exact: boolean
}

export function estimateSection(rows: number, sample: number[], sampled: number): SectionSize {
  if (rows === 0) return { rows: 0, bytes: 0, exact: true }
  if (sample.length === 0) return { rows, bytes: 0, exact: false }
  const total = sample.reduce((a, b) => a + b, 0)
  // Every line carries its own newline and its `{"t":"…","r":}` wrapper, which
  // the sample already includes because it is measured on the written line.
  const mean = total / sample.length
  return { rows, bytes: Math.round(mean * rows), exact: sampled >= rows }
}
