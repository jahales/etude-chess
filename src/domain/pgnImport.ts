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
 * own annotations are preserved rather than stripped — with the one exception
 * `stripPgnCommands` names: `[%clk …]` and its relatives are a program's data,
 * not a person's note, and a file that carries only those carries no annotation.
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
  /**
   * The position the game starts from, when it is not the standard one.
   *
   * Studies, endgame collections and puzzle sets routinely carry `[SetUp "1"]`
   * and `[FEN …]`, and many of them carry no `[Variant]` tag at all — so the
   * variant check never sees them and they import like any other game. Dropping
   * this made the movetext replay from move 1, which usually fails as
   * "unreadable" (blaming the file for what import discarded) and occasionally
   * succeeds against a different game entirely.
   */
  startFen?: string
  plies: number
  fullMoves: number
}

// ---------- normalising ----------

/** The PGN standard's "this tag is unknown" placeholders. Absent beats a literal `?`. */
const PLACEHOLDER = /^[?.\s]*$/

/**
 * A machine-readable command inside a comment: `[%clk 0:15:09.9]`, `[%eval
 * -0.34]`, `[%emt 0:00:05]`, `[%csl Gd4]`, `[%cal Gd1d4,Rf3g5]`.
 *
 * Matched on the `[%` syntax rather than on a list of names, because tools keep
 * inventing commands — chess.com, Lichess and ChessBase all ship their own — and
 * a name we haven't heard of would otherwise reach the reveal looking like
 * something the annotator wrote. Nothing legitimately puts a `]` inside one, so
 * the match stops at the first.
 */
const PGN_COMMAND = /\[%[^\]]*\]/g

/**
 * The prose in a comment, with the `%`-commands taken out — or **nothing**.
 *
 * Absent, not empty, and that is the whole point (#129). A chess.com export
 * stamps `[%clk …]` on every ply and writes nothing else, so keeping the emptied
 * string would leave a comment on all 55 plies of a 55-ply game. `studyGame`
 * reads the presence of a comment map as "the file annotated this", and #55
 * requires that a note carry the name of the file it came from (constitution
 * §9/§12) — so an empty-string comment renders as an attributed blank under
 * every reveal, crediting the file with prose it never contained.
 *
 * The eval commands go for a second reason: a `[%eval]` written by some other
 * engine at some other budget is not our number, and comparing evals recorded at
 * two different budgets is exactly the mistake that put a `?!` beside a move the
 * coach had called good.
 *
 * **An unterminated command is left alone** — `Down to seconds [%clk 0:00` keeps
 * its stray text. Running to the end of the comment on a bare `[%` would swallow
 * a real annotation, and a discarded note is not recoverable while a visible
 * fragment is merely untidy.
 */
export function stripPgnCommands(comment: string): string | undefined {
  // A space, not '', so two prose fragments a command sat between stay separate.
  return comment.replace(PGN_COMMAND, ' ').replace(/\s+/g, ' ').trim() || undefined
}

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
    // as a reader is concerned, so they land on the same ply. Stripping happens
    // here, at the one door into storage, so no later reader has to know that
    // `[%clk …]` was ever a thing a comment could be.
    const text = stripPgnCommands(
      [...(node.data.startingComments ?? []), ...(node.data.comments ?? [])].join(' '),
    )
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

/** A FEN's board field: eight ranks of pieces and digits. Enough to reject prose. */
const FEN_SHAPE = /^([1-8pnbrqkPNBRQK]+\/){7}[1-8pnbrqkPNBRQK]+ [wb] /

/**
 * The starting position, when the file names one and it is usable.
 *
 * `[SetUp "1"]` is the standard's flag, but real files omit it far more often
 * than they omit the `[FEN]` beside it, so the FEN is what we go on. It is
 * shape-checked rather than trusted: a malformed tag stored as the start
 * position would fail at replay time, deep inside a study session, instead of
 * here where the game can simply be treated as starting from move 1.
 */
function startFen(headers: Record<string, string>): string | undefined {
  const fen = headers.FEN?.trim()
  if (!fen || !FEN_SHAPE.test(fen)) return undefined
  // The standard start needs no recording, and saying so keeps the common case
  // out of the storage and out of the PGN we rebuild.
  return fen.startsWith(STANDARD_START) ? undefined : fen
}

const STANDARD_START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -'

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
    startFen: startFen(h),
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
  /**
   * Not one of the time classes the user asked for (#145).
   *
   * Distinct from `fast-time-control`, which is a *rule about strength* from ADR
   * 0018 §4 — "a blitz game is a weak sample of a strong player". This one is
   * only ever the user's own choice about their own games, and reporting the two
   * under one label would make an explicit pick look like a default we imposed.
   * Nothing in a PGN file produces it; it comes from a source that classifies
   * games itself.
   */
  | 'time-class'
  /** The parser gave up on this game — it blew its complexity budget. */
  | 'malformed'

/** What each skip reason says to a person reading an import summary. */
export const SKIP_REASON_LABEL: Record<SkipReason, string> = {
  variant: 'not standard chess',
  'no-moves': 'no moves',
  'too-short': 'too short',
  'fast-time-control': 'blitz, rapid or bullet',
  'below-min-rating': 'below the rating minimum',
  'time-class': 'in a time control you did not pick',
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

/**
 * The same filters aimed at **your own games** (#129).
 *
 * A preset *beside* the defaults, never a replacement for them: ADR 0018 §4
 * chose those for the master corpus and they stay. But measured against a real
 * chess.com account on 2026-08-15, the defaults kept **0 of 280 games** — 247
 * rejected as fast, 19 below the rating floor, 14 as too short. Every one of
 * those four numbers is editable on the import screen, so this was never a wall;
 * it was four fields to get right before your own games would import at all, and
 * the epic this serves is reviewing your own games.
 *
 * Each relaxation is a different claim:
 *
 * - **The clock rules go entirely.** Club players play online rapid and blitz.
 *   Excluding them here would exclude the material, which is the opposite of the
 *   defaults' purpose, where a blitz game is a weak sample of a strong player.
 * - **The rating floor goes to zero.** Your own rating is not a reason to skip
 *   your own game.
 * - **`minFullMoves` drops to where a game stops being studiable**, not to zero.
 *   The quiz starts at ply 8 (`harness.DEFAULT_START_PLY`), so under 5 full moves
 *   there is no position to ask about for either colour, and importing one only
 *   stores a row that #55 can refuse later. Stubs are still stubs.
 *
 * What a game **is** is untouched: a variant is still rejected, because whose
 * game it is has no bearing on whether we can replay it.
 */
export const MY_GAMES_FILTERS: ImportFilters = {
  minBaseSeconds: 0,
  excludeFastSpeeds: false,
  minElo: 0,
  minFullMoves: 5,
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
 * FNV-1a over a string, as eight hex digits.
 *
 * Only ever used to shorten the movetext inside a key, and it is consulted last:
 * the players, date, event and result all have to match before it decides
 * anything.
 */
function hash32(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/** Unit separator — a delimiter that cannot occur inside a player's name. */
const FIELD_SEP = '\u001f'

const canonical = (value: string | undefined): string =>
  (value ?? '').trim().toLowerCase().replace(/\s+/g, ' ')

/**
 * White + Black + Date + Event + Result + the whole game, as one string.
 *
 * Used as the **primary key** of the games table, so importing the same file
 * twice overwrites rather than duplicates — which is what makes §9's
 * re-import-after-eviction path free instead of a merge problem.
 *
 * It used to end at the first ten plies, on the reasoning that two games between
 * the same players, on the same day, with the same result, diverging only after
 * ply 10, are rare. That quietly assumed the *date* was there to discriminate —
 * and `normalizeGame` strips `????.??.??` as the placeholder it is, which
 * undated corpora (scraped collections, match books) are full of. For those the
 * key degenerated to players + result + opening, so a match collection of the
 * same two players out of one opening imported as a **single row**: `bulkPut`
 * overwrites by key without complaint, and the summary still reports every game
 * as written.
 *
 * Hashing the whole movetext removes the class rather than narrowing it — two
 * games agreeing on all of this *are* the same game. `Event` joins it because it
 * is already a column and costs nothing.
 */
export function dedupKey(game: ImportedGame): string {
  return keyFrom({
    white: game.headers.White,
    black: game.headers.Black,
    date: game.headers.Date,
    event: game.headers.Event,
    result: game.headers.Result,
    movetext: game.sanMoves.join(' '),
  })
}

/**
 * The same key from already-stored columns.
 *
 * `persist/db.ts`'s upgrade needs this: a row written under the old key shape
 * has to be rewritten under the new one, or re-importing its file would land
 * beside it instead of on top of it. Every input is a column already, which is
 * what makes the key changeable at all.
 */
export function keyFrom(row: {
  white?: string
  black?: string
  date?: string
  event?: string
  result?: string
  movetext: string
}): string {
  return [
    canonical(row.white),
    canonical(row.black),
    canonical(row.date),
    canonical(row.event),
    canonical(row.result),
    hash32(row.movetext),
  ].join(FIELD_SEP)
}
