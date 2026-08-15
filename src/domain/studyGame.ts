/**
 * Studying a game out of the attached database (#55, plan §11).
 *
 * The guess-the-move session already runs on a `StudyGame` — the curated pack is
 * a list of them — so this is a mapping, not a mode: a stored row becomes a game
 * with a title, a PGN and the side you take, and the session machine is left
 * alone. Everything here is pure, which is what lets the awkward half be tested
 * exhaustively, and the awkward half is the point:
 *
 * - **A database row is not curated content.** A pack game was chosen because it
 *   teaches something; a row is whatever was in the file — a 5-move miniature, a
 *   200-move endgame grind, a header-only stub, or movetext that isn't a legal
 *   game at all. An import stores movetext as *text* and deliberately never
 *   replays it (docs/spikes/games-corpus.md §5), so this module is the first
 *   thing that ever tries. `planStudy` therefore reports a refusal rather than
 *   throwing: the same failure inside the reducer would take the screen with it.
 * - **A game with no winner has no obvious side to take.** The pack takes the
 *   winner's, and every pack game is decisive. A database is full of draws and
 *   of games whose file recorded no result, so `studySides` offers both sides
 *   rather than falling back to White — see the note on it.
 * - **Your own game inverts the winner rule.** The side worth taking in curated
 *   content is the winner's; in a game you played it is yours, including — and
 *   especially — the ones you lost, which are the games most worth reviewing.
 *   `yourSide` matches the names you play under against the row's players, and
 *   `studySides` puts that side first (#130).
 * - **Annotations belong to whoever wrote them.** The file's comments travel
 *   with the name of the file, in one value, so a reveal cannot show someone
 *   else's prose without saying whose it is (constitution §9, §12).
 *
 * The stored row is consumed **structurally** (`DatabaseGame`), the same trick
 * `pgnImport.ts` uses for its parse tree: `persist/dbGames.ts`'s `DbGame`
 * satisfies it, and the domain still imports nothing.
 */

import type { Color } from './types'
import { buildQuiz, heroColorFromResult, parseGame, DEFAULT_START_PLY } from './harness.ts'

// ---------- the shapes ----------

/**
 * Notes that came with a game, and who wrote them.
 *
 * One value rather than two fields, because the attribution is not decoration:
 * these are someone else's words out of a file the user supplied, sitting next
 * to our own engine-derived "why", and a reader must never be unable to tell
 * which is which. Keeping the source *inside* the annotations means a caller
 * cannot render the prose while forgetting where it came from.
 */
export interface Annotations {
  /** The note for each 0-based ply that has one. */
  byPly: Record<number, string>
  /** Where the prose came from — the file name, for an imported game. */
  source: string
}

/**
 * A game a guess-the-move session can run on, whatever it came from: the
 * curated pack (`content/games.ts`) or the attached database.
 */
export interface StudyGame {
  id: string
  title: string
  blurb: string
  pgn: string
  /**
   * The side quizzed. Absent means "take it from the result", which is what the
   * curated pack relies on and what a game with no winner has no answer for.
   */
  heroColor?: Color
  annotations?: Annotations
}

/**
 * The fields of a stored game this needs. `persist/dbGames.ts`'s `DbGame`
 * satisfies it; declaring it here keeps the domain free of the adapter.
 */
export interface DatabaseGame {
  key: string
  white: string
  black: string
  event?: string
  site?: string
  date?: string
  year?: number
  result: string
  /** Mainline SAN, space-separated, exactly as it was stored. */
  movetext: string
  /** The position the game begins from, when it is not the standard one. */
  startFen?: string
  /** The file's own comments, by 0-based ply. */
  comments?: Record<number, string>
  /** The file this game was imported from. */
  source: string
}

// ---------- naming ----------

/** The stored movetext as SAN, tolerating whatever spacing it was written with. */
const plies = (game: DatabaseGame): string[] => game.movetext.split(/\s+/).filter(Boolean)

const RESULT_PROSE: Record<string, string> = {
  '1-0': 'White won',
  '0-1': 'Black won',
  '1/2-1/2': 'Drawn',
}

/** "Paul Morphy vs Duke Karl, Paris Opera 1858" — players, event, year (§11). */
export function studyTitle(game: DatabaseGame): string {
  const where = [game.event, game.year?.toString()].filter(Boolean).join(' ')
  return `${game.white} vs ${game.black}${where ? `, ${where}` : ''}`
}

/** What the game was and where it came from. Provenance is half the point. */
export function studyBlurb(game: DatabaseGame): string {
  const moves = Math.ceil(plies(game).length / 2)
  const outcome = RESULT_PROSE[game.result] ?? 'No result recorded'
  return `${outcome} · ${moves} moves · from ${game.source}`
}

// ---------- the PGN ----------

/**
 * A tag value chess.js will actually read back.
 *
 * PGN's escape for a quote inside a tag is `\"`, and **chess.js' grammar
 * rejects it** — worse, the failure is total: one unreadable tag stops the whole
 * game parsing. So the character is replaced rather than escaped. The stored row
 * stays the source of truth for anything displayed; this string exists only to
 * be parsed back.
 */
const tagValue = (value: string): string => value.replace(/\\/g, '/').replace(/"/g, "'")

/** SAN with move numbers put back, which is what a PGN reader expects to see. */
function numbered(sanMoves: string[]): string {
  const out: string[] = []
  sanMoves.forEach((san, ply) => {
    if (ply % 2 === 0) out.push(`${ply / 2 + 1}.`)
    out.push(san)
  })
  return out.join(' ')
}

/**
 * A stored row → a single-game PGN.
 *
 * Movetext is stored without headers, and the harness parses a PGN, so the tags
 * are rebuilt from the columns they were derived from in the first place. Only
 * the tags that survive a round trip are emitted; a placeholder like `?` was
 * already dropped at import and putting one back would be inventing it.
 */
export function studyPgn(game: DatabaseGame): string {
  const tags: [string, string | undefined][] = [
    ['Event', game.event],
    ['Site', game.site],
    ['Date', game.date],
    ['White', game.white],
    ['Black', game.black],
    ['Result', game.result],
    // A game that does not start from move 1 must say so, and `SetUp` is the
    // flag chess.js's `loadPgn` looks for before it reads the FEN. Without the
    // pair the movetext replays from the standard position: usually illegal at
    // the first move and reported as unreadable, occasionally legal and quietly
    // a different game.
    ...(game.startFen
      ? ([
          ['SetUp', '1'],
          ['FEN', game.startFen],
        ] as [string, string][])
      : []),
  ]
  const header = tags
    .filter(([, value]) => value)
    .map(([name, value]) => `[${name} "${tagValue(value!)}"]`)
    .join('\n')
  return `${header}\n\n${numbered(plies(game))} ${game.result || '*'}`
}

// ---------- whose side ----------

/** A name as it compares: case, surrounding space and doubled space don't count. */
const sameName = (a: string): string => a.trim().replace(/\s+/g, ' ').toLowerCase()

/**
 * The side you played, if one of your names is on the game (#130).
 *
 * A list rather than a field, because the name on a game is whatever the file
 * that recorded it wrote down: a site exports your handle, a game you exported
 * by hand carries "Lastname, Firstname", and a club's file may carry a third
 * spelling. Comparison is case-insensitive and whole-name — a substring rule
 * would hand you the wrong side of every game against someone whose name
 * contains yours, and a short name would claim the database.
 *
 * `null` means "not yours, as far as anything recorded here knows": no names
 * given, no match, or **both** sides matched, which is a game you played against
 * yourself and has no side that is more yours than the other.
 */
export function yourSide(game: DatabaseGame, names: readonly string[]): Color | null {
  const mine = names.map(sameName).filter(Boolean)
  if (mine.length === 0) return null
  // A blank tag must not match a blank name: the file simply didn't say who
  // played, and claiming it as yours would take a stranger's game.
  const isMine = (player: string): boolean => {
    const name = sameName(player)
    return name.length > 0 && mine.includes(name)
  }
  const white = isMine(game.white)
  const black = isMine(game.black)
  if (white === black) return null
  return white ? 'w' : 'b'
}

/**
 * The sides a game can be studied from, most obvious first.
 *
 * A decisive game has one — the winner's, which is what the curated pack has
 * always used, because guessing the loser's moves means being graded against
 * moves that lost. A draw, an unfinished game, or a file that recorded no result
 * has no winner, so **both sides are offered and neither is chosen for you**.
 * The alternative is the fallback the pack can afford and a database cannot:
 * defaulting to White would quietly quiz you as White for every drawn game in
 * the file, and in a strong database that is most of them.
 *
 * **A game you played is the case that rule gets backwards** (#130). Both of the
 * above are about content someone else made, where the winner is the player
 * worth imitating. In your own game you are the player being trained, so `yours`
 * — from `yourSide` — comes first and the other side is still offered. Nothing
 * is being conceded about grading: `planStudy` grades against the engine, not
 * against the move played (`engine/grading.ts`), so the losing side of your own
 * game is a session about your decisions rather than a re-run of them, and a
 * better move than the one you found is still Tier A.
 */
export function studySides(result: string, yours?: Color | null): Color[] {
  if (yours) return [yours, yours === 'w' ? 'b' : 'w']
  const winner = heroColorFromResult(result)
  return winner ? [winner] : ['w', 'b']
}

// ---------- planning ----------

/** Why an imported game cannot be turned into a quiz. */
export type StudyBlocker = 'no-moves' | 'unreadable' | 'no-decisions'

/** What each refusal says to the person who clicked on the game. */
export const STUDY_BLOCKER_LABEL: Record<StudyBlocker, string> = {
  'no-moves': 'This record has no moves — the file stored its headers and nothing else.',
  unreadable:
    'These moves don’t replay as a legal game. An import stores what the file said without checking it, so this is the first time anything has tried.',
  'no-decisions':
    'There’s nothing to guess from this side: the quiz starts after move four, and past that point this side never had a move to choose.',
}

export type StudyPlan =
  | { ok: true; game: StudyGame; positions: number }
  | { ok: false; reason: StudyBlocker }

/** The file's comments, kept with the name of the file, or nothing at all. */
function annotationsOf(game: DatabaseGame): Annotations | undefined {
  const byPly = game.comments
  if (!byPly || Object.keys(byPly).length === 0) return undefined
  return { byPly, source: game.source }
}

/**
 * A stored row + the side you take → a game the session can run, or the reason
 * it can't.
 *
 * The quiz is built here **and thrown away**: the reducer builds its own from
 * the same pure function, so what this returns is a promise about what will
 * happen — how many positions, or that there would be none — made before a
 * session opens on an empty quiz or a reducer throws on illegal movetext.
 */
export function planStudy(game: DatabaseGame, heroColor: Color): StudyPlan {
  if (plies(game).length === 0) return { ok: false, reason: 'no-moves' }

  const studyGame: StudyGame = {
    id: `db:${game.key}`,
    title: studyTitle(game),
    blurb: studyBlurb(game),
    pgn: studyPgn(game),
    heroColor,
    ...(annotationsOf(game) ? { annotations: annotationsOf(game)! } : {}),
  }

  let positions: number
  try {
    // Exactly the path the reducer takes, so a game that plans is a game that runs.
    const parsed = parseGame(studyGame.pgn)
    positions = buildQuiz(parsed.sanMoves, {
      heroColor,
      startPly: DEFAULT_START_PLY,
      // Taken from the parse rather than the row, so this plans against exactly
      // what the reducer will run — the two cannot disagree about where the
      // game starts.
      ...(parsed.startFen ? { startFen: parsed.startFen } : {}),
    }).length
  } catch {
    return { ok: false, reason: 'unreadable' }
  }
  if (positions === 0) return { ok: false, reason: 'no-decisions' }
  return { ok: true, game: studyGame, positions }
}

// ---------- annotations at the board ----------

/**
 * The note for a ply, with the attribution that must travel with it.
 *
 * Returns both or neither — there is no way to get the prose out of here
 * without the name of the file it came from.
 */
export function annotationAt(
  game: { annotations?: Annotations },
  ply: number,
): { text: string; source: string } | null {
  const text = game.annotations?.byPly[ply]?.trim()
  return text ? { text, source: game.annotations!.source } : null
}
