/**
 * PGN import: the pure half.
 *
 * We ship no corpus — the user attaches their own PGN and we parse, filter and
 * index it locally (ADR 0018, docs/v0.3.0-plan.md §9). Everything in this file
 * is a pure function over data: the mapping from a parse tree to our own type,
 * the facts derived from the headers, the ingest filters, and the dedup key.
 *
 * Streaming and storage live outside the domain (`content/pgnImport.ts` and
 * `persist/dbGames.ts`); this module has no idea a file or a database exists,
 * which is what makes the rules cheap to test exhaustively.
 *
 * Three design points worth not re-deriving:
 *
 * - **We consume a parse tree structurally, not `chessops`' types.** The
 *   `ParsedPgn*` interfaces below are the shape chessops' `Game<PgnNodeData>`
 *   happens to have; declaring them here keeps the domain import-free and makes
 *   the parser swappable. We test *our* mapping, not chessops.
 * - **Nothing here replays a move.** Validating legality means generating the
 *   legal move list at every ply, measured at ~12 games/sec — over two hours for
 *   a 100k-game import (docs/spikes/games-corpus.md §5). Games are stored as
 *   text; illegality is discovered when something actually replays one.
 * - **Unknown is never a guess.** A missing time control or rating keeps the
 *   game and marks the field unknown (ADR 0018 §4). A filter may only reject on
 *   what the file actually says.
 */

// ---------- the parse tree we consume ----------

/** One move of a parse tree, with whatever annotation came with it. */
export interface ParsedPgnNodeData {
  san: string
  /** Comments written *before* this move (`{ ... } 12. Rxe7`). */
  startingComments?: string[]
  /** Comments written after this move. */
  comments?: string[]
  /** Numeric annotation glyphs (`$2`, and the `?`/`!` forms that map onto them). */
  nags?: number[]
}

/** One game of a parse tree. Structurally what `chessops/pgn` emits. */
export interface ParsedPgnGame {
  headers: Map<string, string>
  /** Comments before the first move, belonging to the game rather than to a move. */
  comments?: string[]
  moves: { mainlineNodes(): Iterable<{ data: ParsedPgnNodeData }> }
}

// ---------- our own type ----------

/**
 * One imported game, normalised.
 *
 * `sanMoves` is the **mainline only**. Variations are dropped: storing a tree
 * needs a tree-shaped record and nothing downstream reads one yet. Comments and
 * NAGs on the mainline *are* kept, because ADR 0018 §3 is explicit that a user's
 * own annotations are preserved rather than stripped.
 *
 * `comments` and `nags` are absent rather than empty when a game has none — at
 * 100k rows an empty object per game is 100k objects that say nothing.
 */
export interface ImportedGame {
  /** PGN tags, with the standard's `?` / `????.??.??` placeholders removed. */
  headers: Record<string, string>
  sanMoves: string[]
  /** Mainline comments, keyed by the 0-based ply index of the move they sit on. */
  comments?: Record<number, string>
  /** Mainline NAGs by ply index. */
  nags?: Record<number, number[]>
}

export type GameResult = '1-0' | '0-1' | '1/2-1/2' | '*'

export type Speed = 'bullet' | 'blitz' | 'rapid' | 'classical' | 'correspondence' | 'unknown'

export interface TimeControl {
  /** Exactly what the `[TimeControl]` tag said, so the UI can show it honestly. */
  raw?: string
  speed: Speed
  /** Base seconds of the first period. Absent when the file didn't say. */
  baseSeconds?: number
  incrementSeconds?: number
}

/** What the headers tell us about a game — derived once, then filtered and indexed on. */
export interface GameFacts {
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
  /** The lower of the two ratings — what a minimum-rating filter actually means. */
  minElo?: number
  timeControl: TimeControl
  /** The `Variant` tag, if the file carried one. */
  variant?: string
  plies: number
  fullMoves: number
}

// ---------- normalising ----------

/** The PGN standard's "this tag is unknown" placeholders. Absent beats a literal `?`. */
const PLACEHOLDER = /^[?.\s]*$/

/**
 * A parse tree → our own type. Total: it never throws, whatever the file holds.
 */
export function normalizeGame(game: ParsedPgnGame): ImportedGame {
  const headers: Record<string, string> = {}
  for (const [name, value] of game.headers) {
    const trimmed = value.trim()
    if (trimmed && !PLACEHOLDER.test(trimmed)) headers[name] = trimmed
  }

  const sanMoves: string[] = []
  let comments: Record<number, string> | undefined
  let nags: Record<number, number[]> | undefined

  for (const node of game.moves.mainlineNodes()) {
    const ply = sanMoves.length
    sanMoves.push(node.data.san)
    // A comment before a move and one after it are both *about* that move as far
    // as a reader is concerned, so they land on the same ply.
    const text = [...(node.data.startingComments ?? []), ...(node.data.comments ?? [])]
      .map((c) => c.trim())
      .filter(Boolean)
      .join(' ')
    if (text) {
      comments ??= {}
      comments[ply] = text
    }
    if (node.data.nags?.length) {
      nags ??= {}
      nags[ply] = [...node.data.nags]
    }
  }

  return {
    headers,
    sanMoves,
    ...(comments ? { comments } : {}),
    ...(nags ? { nags } : {}),
  }
}

// ---------- derived facts ----------

const RESULTS: GameResult[] = ['1-0', '0-1', '1/2-1/2', '*']

const toResult = (raw: string | undefined): GameResult =>
  RESULTS.find((r) => r === raw?.trim()) ?? '*'

const toElo = (raw: string | undefined): number | undefined => {
  const n = Number.parseInt(raw ?? '', 10)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

/** `1895.08.17` and `1972.??.??` both carry a usable year; prose does not. */
const toYear = (raw: string | undefined): number | undefined => {
  const match = /^(\d{4})\b/.exec(raw?.trim() ?? '')
  return match ? Number(match[1]) : undefined
}

export function describeGame(game: ImportedGame): GameFacts {
  const h = game.headers
  const whiteElo = toElo(h.WhiteElo)
  const blackElo = toElo(h.BlackElo)
  const plies = game.sanMoves.length
  return {
    // A name we can show beats an empty cell, and "Unknown" is what the file means.
    white: h.White ?? 'Unknown',
    black: h.Black ?? 'Unknown',
    event: h.Event,
    site: h.Site,
    date: h.Date,
    year: toYear(h.Date),
    result: toResult(h.Result),
    eco: h.ECO,
    whiteElo,
    blackElo,
    // Only meaningful when *both* are known: one player's rating is not a
    // minimum, and reading a missing rating as 0 would silently reject.
    minElo: whiteElo != null && blackElo != null ? Math.min(whiteElo, blackElo) : undefined,
    timeControl: parseTimeControl(h.TimeControl, h.Event),
    variant: h.Variant,
    plies,
    fullMoves: Math.ceil(plies / 2),
  }
}

// ---------- time control ----------

/** Speed boundaries in base seconds. Classified on the base alone — see below. */
const BULLET_UNDER = 180
const BLITZ_UNDER = 600
const RAPID_UNDER = 1500
const CORRESPONDENCE_FROM = 86_400

/**
 * Speeds a file can *name*, and only the fast ones.
 *
 * Naming is an exclusion signal, never a promotion: an event calling itself
 * "Classical" with no `[TimeControl]` stays **unknown**, because ADR 0018 §4
 * says we mark an unknown control rather than guessing at one. Reading "Blitz"
 * as blitz rejects a game; reading "Classical" as classical would accept one on
 * the strength of a tournament's name.
 */
const NAMED_FAST_SPEEDS: [RegExp, Speed][] = [
  [/\bhyper ?bullet\b|\bbullet\b/i, 'bullet'],
  [/\bblitz\b|\barmageddon\b/i, 'blitz'],
  [/\brapid\b|\bquick ?play\b/i, 'rapid'],
]

/** The speeds "prefer strong, standard time controls" excludes (ADR 0018 §4). */
export const FAST_SPEEDS: readonly Speed[] = ['bullet', 'blitz', 'rapid']

function speedFromBase(baseSeconds: number): Speed {
  if (baseSeconds >= CORRESPONDENCE_FROM) return 'correspondence'
  if (baseSeconds < BULLET_UNDER) return 'bullet'
  if (baseSeconds < BLITZ_UNDER) return 'blitz'
  if (baseSeconds < RAPID_UNDER) return 'rapid'
  return 'classical'
}

/** The fast speed a string calls itself, if any. Only consulted when there's no clock. */
export function namedSpeed(...text: (string | undefined)[]): Speed | undefined {
  const joined = text.filter(Boolean).join(' ')
  return NAMED_FAST_SPEEDS.find(([pattern]) => pattern.test(joined))?.[1]
}

/**
 * Read a `[TimeControl]` tag, falling back to what the event calls itself.
 *
 * Handles the forms the standard defines and the ones real files use: `600`,
 * `300+3`, `40/9000`, `40/7200:1800+30` (the first period is the one a game
 * starts with), `*180` (sandclock), and `?` / `-` / absent (unknown).
 *
 * **Classification is on the base alone**, not on an estimated game duration.
 * §9's rule is "base < 600 s", and a rule the UI can state in one line beats a
 * better-calibrated one nobody can check against their own file.
 */
export function parseTimeControl(raw: string | undefined, event?: string): TimeControl {
  const text = raw?.trim()
  const named = namedSpeed(text, event)
  const withoutClock: TimeControl = {
    speed: named ?? 'unknown',
    ...(text ? { raw: text } : {}),
  }
  // `?` is "unknown" and `-` is "no time control"; neither is a clock.
  if (!text || text === '?' || text === '-') return withoutClock

  const firstPeriod = text.split(':')[0]!
  const match = /^\*?(?:\d+\/)?(\d+)(?:\+(\d+))?$/.exec(firstPeriod)
  if (!match) return withoutClock

  const baseSeconds = Number(match[1])
  const incrementSeconds = match[2] === undefined ? undefined : Number(match[2])
  return {
    raw: text,
    // An explicit clock outranks the event's name: the clock is data, the name
    // is prose, and prose is wrong more often.
    speed: speedFromBase(baseSeconds),
    baseSeconds,
    ...(incrementSeconds === undefined ? {} : { incrementSeconds }),
  }
}

// ---------- filters ----------

export type SkipReason =
  | 'variant'
  | 'no-moves'
  | 'too-short'
  | 'fast-time-control'
  | 'below-min-rating'
  /** The parser gave up on this game — it blew its complexity budget. */
  | 'malformed'

/** What each skip reason says to a person reading an import summary. */
export const SKIP_REASON_LABEL: Record<SkipReason, string> = {
  variant: 'not standard chess',
  'no-moves': 'no moves',
  'too-short': 'too short',
  'fast-time-control': 'blitz, rapid or bullet',
  'below-min-rating': 'below the rating minimum',
  malformed: 'could not be parsed',
}

export interface ImportFilters {
  /**
   * Reject a game whose *known* base time is under this many seconds. A game
   * with no time control is kept and marked unknown, never measured against it.
   */
  minBaseSeconds: number
  /**
   * Reject bullet, blitz and rapid — by the clock where there is one, and by
   * what the event or the tag calls itself where there isn't. §9 asks for both
   * rules because either alone leaks: `600+0` clears a 600-second floor, and a
   * `[TimeControl "?"]` blitz event has no clock to measure.
   */
  excludeFastSpeeds: boolean
  /** Reject when both players are rated and the lower rating is under this. */
  minElo: number
  /** Reject stubs: abandoned games and header-only records. */
  minFullMoves: number
}

/**
 * The defaults of ADR 0018 §4 — "prefer strong, standard time controls".
 *
 * `minElo` is the one number §9 leaves open. 2200 is the master band, which is
 * the material this trainer is for; it is also the default most likely to
 * surprise someone attaching their own club games, which is why the import
 * screen shows every filter *before* it runs and reports what each one rejected.
 */
export const DEFAULT_IMPORT_FILTERS: ImportFilters = {
  minBaseSeconds: 600,
  excludeFastSpeeds: true,
  minElo: 2200,
  minFullMoves: 10,
}

export type FilterVerdict = { keep: true } | { keep: false; reason: SkipReason }

const STANDARD_VARIANTS = new Set(['standard', 'chess', 'normal', 'classical', 'from position'])

/**
 * Whether to keep a game, and if not, the one reason to report.
 *
 * The order is fixed and shallow-to-deep — what the game *is*, then how long it
 * is, then the conditions it was played under — so the same file always explains
 * itself the same way. A game failing several tests reports the first.
 */
export function filterGame(facts: GameFacts, filters: ImportFilters): FilterVerdict {
  if (facts.variant && !STANDARD_VARIANTS.has(facts.variant.trim().toLowerCase())) {
    return { keep: false, reason: 'variant' }
  }
  if (facts.plies === 0) return { keep: false, reason: 'no-moves' }
  if (facts.fullMoves < filters.minFullMoves) return { keep: false, reason: 'too-short' }

  const { speed, baseSeconds } = facts.timeControl
  if (baseSeconds != null && baseSeconds < filters.minBaseSeconds) {
    return { keep: false, reason: 'fast-time-control' }
  }
  if (filters.excludeFastSpeeds && FAST_SPEEDS.includes(speed)) {
    return { keep: false, reason: 'fast-time-control' }
  }

  // An unknown rating is kept: the filter may only reject on what the file says.
  if (facts.minElo != null && facts.minElo < filters.minElo) {
    return { keep: false, reason: 'below-min-rating' }
  }
  return { keep: true }
}

// ---------- dedup ----------

/**
 * How much of the opening goes into the dedup key (§9: "first ~10 plies").
 *
 * The trade: two games between the same players, on the same day, with the same
 * result, diverging only after ply 10, collide. Rare enough to be worth a key
 * short enough to compute without replaying anything.
 */
export const DEDUP_PLIES = 10

/** Unit separator — a delimiter that cannot occur inside a player's name. */
const FIELD_SEP = '\u001f'

const canonical = (value: string | undefined): string =>
  (value ?? '').trim().toLowerCase().replace(/\s+/g, ' ')

/**
 * White + Black + Date + Result + the opening, as one string.
 *
 * Used as the **primary key** of the games table, so importing the same file
 * twice overwrites rather than duplicates — which is what makes §9's
 * re-import-after-eviction path free instead of a merge problem.
 */
export function dedupKey(game: ImportedGame): string {
  return [
    canonical(game.headers.White),
    canonical(game.headers.Black),
    canonical(game.headers.Date),
    canonical(game.headers.Result),
    game.sanMoves.slice(0, DEDUP_PLIES).join(' '),
  ].join(FIELD_SEP)
}
