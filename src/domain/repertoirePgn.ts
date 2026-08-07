// Render a crawled repertoire tree as PGN with variations (ADR 0021, issue #88).
//
// This is the half of the generator's output that pays off immediately: En
// Croissant's spaced-repetition trainer takes a repertoire PGN as input and has
// no way to produce one. The annotated JSON alongside it is what etude-chess
// consumes when epic:opening arrives.
//
// Pure, like the rest of the domain: the caller supplies the date, because
// nothing in here may read the clock.
//
// Runtime-import-free so scripts/repertoire/ can load it under Node's type
// stripping — see repertoire.ts for why that constraint exists.

/** One move out of a position, as the crawler recorded it. */
export interface RepertoireChild {
  san: string
  fen: string
  /**
   * How this move earned its place. `ours` is our repertoire choice from human
   * play; `ours-engine` is the engine's refutation, used where no move humans
   * actually play is sound — typically right after the opponent falls into a
   * trap. `mass` and `trap` are the two ways an opponent move earns coverage.
   */
  reason: 'ours' | 'ours-engine' | 'mass' | 'trap' | 'mass+trap'
  /**
   * Which book chose our move: `canon` = master games (still in theory),
   * `band` = our own rating band (master theory has run out here). Only set
   * when a canonical source was configured, so its absence means "not asked".
   */
  source?: 'canon' | 'band'
  /** Centipawns after this move, **White's perspective**, for `[%eval]`. */
  evalCp?: number
  /** Share of opponents who play this here, 0–1. */
  frequency?: number
  /** What they actually score with it, 0–1. */
  practical?: number
  /** What the position after it is worth, 0–1. */
  expected?: number
  /** Games backing `practical`. */
  games?: number
  /**
   * Whether the punishment actually materialised: after our reply to this trap,
   * are we measurably better? A trap whose refutation only equalises is one you
   * would drill into false confidence, so it is marked rather than dropped.
   */
  punished?: boolean
  /** Our win% after replying to this trap, 0–100. */
  afterReplyWinPercent?: number
  /** Win% the mover gives up versus best, 0–100. Absent on our own moves. */
  swing?: number
  /**
   * The named variation this move commits the line to, when it changes one.
   *
   * The reason a repertoire prefers one sound move over another. Without it a
   * trainer that demands 3.cxd5 over 3.Nc3 is indistinguishable from guessing —
   * both are fine, and "the engine liked it slightly more" is not something a
   * player can act on. "This is the Exchange Variation" is.
   */
  entersVariation?: string
  /** ECO code for `entersVariation`. */
  eco?: string
  /**
   * Name of the manifest branch that owns everything after this move. Set when
   * a multi-branch build hands the subtree to another crawl, so a trap can point
   * at where its refutation lives instead of claiming to have verified it here.
   */
  delegatedTo?: string
}

export interface RepertoireNode {
  children: RepertoireChild[]
  terminal?: boolean
  terminalReason?: 'quiet' | 'depth-cap' | 'out-of-book' | 'no-sound-move' | 'delegated'
  quiet?: { breadth: number }
  games?: number
  /** Branch that covers this position, when `terminalReason` is `delegated`. */
  delegatedTo?: string
}

/** How the evaluations in this file were produced, so they can be audited. */
export interface AnalysisProvenance {
  engine?: string
  /** Fixed node budget per position. */
  nodes?: number
  /** Threads. Anything above 1 makes the numbers unreproducible. */
  threads?: number
  /** Shallowest search depth reached anywhere in the crawl. */
  minDepth?: number
}

export interface PgnInput {
  /** Positions by FEN key (first four FEN fields). */
  nodes: Map<string, RepertoireNode>
  /** Position the crawl started from, after the curated prefix. */
  rootFen: string
  /** The curated prefix, in SAN, played verbatim from the initial position. */
  forcedSans: string[]
  ourColor: 'w' | 'b'
  /** ISO date (YYYY-MM-DD). Passed in — the domain never reads the clock. */
  date: string
  /** Recorded in the headers; omit only if genuinely unknown. */
  provenance?: AnalysisProvenance
  /**
   * Branch name from the manifest. A repertoire PGN holds one game per branch,
   * and a trainer that lists them all as "Repertoire — White" is unusable.
   */
  name?: string
  /** Why this branch exists, emitted as the comment before the first move. */
  why?: string
  /**
   * The named variation this branch heads for, and its ECO code.
   *
   * `[Opening]` used to hold the curated prefix in SAN — a move list in a tag
   * that every reader expects to contain a name.
   */
  opening?: string
  eco?: string
  /**
   * A variation name per curated-prefix move, or null where it commits to
   * nothing new. Parallel to `forcedSans`.
   *
   * The prefix moves are the branch's own decisions — `3.cxd5` is *why* the QGD
   * Exchange branch exists — and the trainer makes cards from them like any
   * other move. Rendering them bare left the most important forks unlabelled.
   */
  prefixNotes?: (string | null)[]
}

/** PGN comments are `{...}`, so a brace inside one would close it early. */
function safeComment(text: string): string {
  return text.replace(/[{}]/g, '')
}

/**
 * A header value is a quoted string, so a quote inside one ends it early and
 * makes the whole game unparseable.
 *
 * Stripped rather than escaped, though the spec allows `\"`: chess.js rejects
 * the escaped form outright, so spec-correct output would still be a file this
 * project's own parser will not read. Losing a quote from a branch name we
 * wrote ourselves costs nothing next to that.
 */
function safeTag(text: string): string {
  return text.replace(/["\\]/g, '')
}

/** Positions are keyed by the first four FEN fields, so transpositions collapse. */
export function fenKey(fen: string): string {
  return fen.split(' ').slice(0, 4).join(' ')
}

/**
 * The scale a move glyph is read off, exported whole.
 *
 * The first two mirror grade.ts's tiers and are **not imported** from it: this
 * module must stay runtime-import-free so the .mjs scripts can load it under
 * Node's type stripping, the same constraint repertoire.ts documents.
 * repertoirePgn.test.ts pins both to the real ones so they cannot drift.
 *
 * `BLUNDER_SWING` has no counterpart there — grade.ts's tiers stop at "a
 * mistake or blunder" without separating the two, and a move giving up more
 * than a quarter of the result has not conceded an edge, it has handed the
 * game over.
 *
 * All three are exported together because they are one scale: a caller
 * rendering these grades elsewhere needs the whole of it, not the one constant
 * a test happened to reach for.
 */
export const CONCESSION_SWING = 5 // === TIER_A_MAX_SWING
export const MISTAKE_SWING = 15 // === TIER_B_MAX_SWING
export const BLUNDER_SWING = 25

/**
 * Mark how bad an opponent's move is, so the trainer shows it at a glance.
 *
 * Anchored to the project's own tiers rather than to round numbers. The
 * thresholds used to be 10/15/25, which left the whole of Tier B between 5 and
 * 10 unmarked even though grade.ts calls that "a real concession" — across the
 * built repertoire it produced **3 glyphs in 450 moves**, which reads as
 * "nothing here is a mistake" when a third of the moves covered are errors we
 * are specifically preparing against.
 */
function annotate(child: RepertoireChild): string {
  if (child.reason === 'ours' || child.reason === 'ours-engine') return ''
  if (typeof child.swing !== 'number') return ''
  if (child.swing > BLUNDER_SWING) return '??'
  if (child.swing > MISTAKE_SWING) return '?'
  if (child.swing > CONCESSION_SWING) return '?!'
  return ''
}

/**
 * A share, rounded so it stays informative at the bottom of the range: a trap
 * played 0.4% of the time must not print as "0% play this", which reads as
 * "never" for a line that is worth preparing.
 */
const pct = (x: number) => (x < 0.01 ? `${(x * 100).toFixed(1)}%` : `${Math.round(x * 100)}%`)

/** `[%eval]`, which En Croissant and Lichess render as a graph. */
function evalComment(child: RepertoireChild): string | null {
  if (typeof child.evalCp !== 'number') return null
  return `{ [%eval ${(child.evalCp / 100).toFixed(2)}] }`
}

/**
 * Why this move is here, in facts rather than verdicts.
 *
 * The numbers matter more than the label. "trap" tells you nothing actionable;
 * *"one opponent in twenty plays this and scores 45% where 33% is deserved"*
 * tells you how often you will meet it and how much free score you are leaking
 * — which is what decides whether it is worth your evening. It is also
 * checkable, so you can disagree with the ranking, per constitution §5 and
 * ADR 0012: state the fact bundle, don't hand down a verdict.
 */
function childComment(child: RepertoireChild): string | null {
  // One comment, always. Everything a move has to say goes inside a single pair
  // of braces — see `mergeComments` for what two of them in a row cost.
  const bits: string[] = []

  if (child.reason === 'trap' || child.reason === 'mass+trap') {
    bits.push('trap')
    if (typeof child.frequency === 'number') bits.push(`${pct(child.frequency)} play this`)
    if (typeof child.practical === 'number' && typeof child.expected === 'number') {
      bits.push(`they score ${pct(child.practical)} where ${pct(child.expected)} is deserved`)
    }
    if (typeof child.games === 'number') bits.push(`n=${child.games}`)
  }

  if (child.entersVariation) bits.push(`→ ${safeComment(child.entersVariation)}`)

  if (child.delegatedTo) {
    // Where another branch owns everything after this move, that is the rest of
    // the story — including for a trap, whose refutation is crawled and verified
    // there. Saying so beats both alternatives: claiming a punishment this crawl
    // never checked, and warning about one that has in fact been checked.
    bits.push(`covered in the "${safeComment(child.delegatedTo)}" line`)
  } else if (child.reason === 'trap' || child.reason === 'mass+trap') {
    // A trap whose refutation does not actually leave us better is worse than
    // no trap at all — you would drill it as a win and reach an equal game.
    //
    // Note the test is `!== true`, not `=== false`. `undefined` means the check
    // never ran (the position transposed into one already visited, or sat on the
    // depth cap), and treating "not verified" as "verified" is precisely the
    // silent-success failure this annotation exists to prevent.
    if (child.punished === false) {
      const after =
        typeof child.afterReplyWinPercent === 'number'
          ? ` (only ${child.afterReplyWinPercent.toFixed(0)}% after our reply)`
          : ''
      bits.push(`WARNING: punishment unconfirmed${after} — play it out, don't trust the label`)
    } else if (child.punished !== true) {
      bits.push('punishment not verified — play it out yourself')
    }
  } else if (child.reason === 'ours-engine') {
    bits.push('engine refutation — too rare to appear in human play')
  } else if (child.reason === 'ours' && child.source === 'band') {
    // Worth flagging: past this point the move is not backed by master practice,
    // so it is a reasonable choice rather than established theory.
    bits.push('beyond master theory — chosen from club play')
  }

  return bits.length ? `{${bits.join(' · ')}}` : null
}

function token(san: string, ply: number, needsNumber: boolean): string {
  const number = Math.floor(ply / 2) + 1
  if (ply % 2 === 0) return `${number}. ${san}`
  return needsNumber ? `${number}... ${san}` : san
}

function terminalComment(node: RepertoireNode | undefined): string | null {
  if (!node?.terminal) return null
  switch (node.terminalReason) {
    case 'quiet':
      return `quiet: ${node.quiet?.breadth ?? '?'} playable moves — judgment from here`
    case 'depth-cap':
      return 'depth cap'
    case 'out-of-book':
      return `out of book (${node.games ?? 0} games)`
    case 'no-sound-move':
      return 'no sound continuation found'
    case 'delegated':
      return `covered in the "${safeComment(node.delegatedTo ?? '?')}" line`
    default:
      return null
  }
}

function emitFrom(
  nodes: Map<string, RepertoireNode>,
  fen: string,
  ply: number,
  needsNumber: boolean,
): string[] {
  const node = nodes.get(fenKey(fen))
  const out: string[] = []

  if (!node || node.children.length === 0) {
    const comment = terminalComment(node)
    if (comment) out.push(`{${comment}}`)
    return out
  }

  // The main line is the most popular reply — unless another branch owns
  // everything after it, in which case following it would make this game's own
  // content a footnote and its main line a single pointer elsewhere.
  const mainIndex = Math.max(
    0,
    node.children.findIndex((c) => !c.delegatedTo),
  )
  const main = node.children[mainIndex]
  const alts = node.children.filter((_, i) => i !== mainIndex)
  if (!main) return out
  out.push(token(`${main.san}${annotate(main)}`, ply, needsNumber))
  const mainEval = evalComment(main)
  if (mainEval) out.push(mainEval)
  const mainNote = childComment(main)
  if (mainNote) out.push(mainNote)

  // Work out the continuation first. When the main line stops here its only
  // token is the terminal note, and a comment sitting after a closing
  // parenthesis is something real parsers reject — so it is folded onto the
  // move, ahead of the variations, where it also reads better.
  const rest = main.delegatedTo ? [] : emitFrom(nodes, main.fen, ply + 1, alts.length > 0)
  while (rest.length && isComment(rest[0]!)) out.push(rest.shift()!)

  for (const alt of alts) {
    const inner = [token(`${alt.san}${annotate(alt)}`, ply, true)]
    const altEval = evalComment(alt)
    if (altEval) inner.push(altEval)
    const note = childComment(alt)
    if (note) inner.push(note)
    // Not into a branch someone else owns: the move's own comment says where it
    // is covered, and descending would only repeat that on the position after.
    if (!alt.delegatedTo) inner.push(...emitFrom(nodes, alt.fen, ply + 1, true))
    out.push(`(${mergeComments(inner).join(' ')})`)
  }

  // After a variation closes, a following black move must restate its number —
  // which `rest` was already built with.
  out.push(...rest)
  return out
}

const isComment = (t: string) => t.startsWith('{') && t.endsWith('}')

/**
 * Fold runs of adjacent `{…}` comments into one.
 *
 * Two comments in a row are legal by the PGN spec and rejected by real parsers
 * — chess.js among them, which is this project's own. A move carrying an
 * evaluation, a fact bundle and a terminal note emitted three of them, so the
 * generated repertoire did not load anywhere. The file looked perfect.
 */
function mergeComments(tokens: string[]): string[] {
  const out: string[] = []
  for (const t of tokens) {
    const prev = out[out.length - 1]
    if (isComment(t) && prev && isComment(prev)) {
      out[out.length - 1] = `${prev.slice(0, -1).trimEnd()} · ${t.slice(1).trimStart()}`
    } else out.push(t)
  }
  return out
}

function wrap(tokens: string[], width = 80): string {
  const lines: string[] = []
  let line = ''
  for (const t of tokens) {
    if (line && line.length + t.length + 1 > width) {
      lines.push(line)
      line = t
    } else {
      line = line ? `${line} ${t}` : t
    }
  }
  if (line) lines.push(line)
  return lines.join('\n')
}

/**
 * Render the tree. The main line is each node's first child; every other child
 * becomes a parenthesised variation attached to the same ply.
 *
 * Terminal positions carry a comment saying *why* the line stopped. That is
 * load-bearing rather than decorative: `{quiet: 4 playable moves}` marks the
 * point where the scaffolding ends and judgment begins, which is the whole
 * reason this is a judgment trainer and not a memorisation deck.
 */
export function toPgn(input: PgnInput): string {
  const { nodes, rootFen, forcedSans, ourColor, date } = input
  const colour = ourColor === 'b' ? 'Black' : 'White'

  // The curated prefix runs contiguously from ply 0, so no black move in it
  // needs to restate its number.
  const tokens = input.why ? [`{${safeComment(input.why)}}`] : []
  for (const [i, san] of forcedSans.entries()) {
    tokens.push(token(san, i, false))
    const note = input.prefixNotes?.[i]
    if (note) tokens.push(`{→ ${safeComment(note)}}`)
  }
  tokens.push(...emitFrom(nodes, rootFen, forcedSans.length, false))

  const headers = [
    `[Event "Repertoire — ${colour}${input.name ? `: ${safeTag(input.name)}` : ''}"]`,
    `[Site "etude-chess repertoire generator"]`,
    `[Date "${date.replace(/-/g, '.')}"]`,
    `[White "${colour === 'White' ? 'Repertoire' : 'Opponent'}"]`,
    `[Black "${colour === 'Black' ? 'Repertoire' : 'Opponent'}"]`,
    `[Result "*"]`,
    // Not decoration: En Croissant's practice mode builds its deck with
    // `headers.orientation || "white"`, so without this a Black repertoire
    // drills you as White — it hands you the opponent's side of every line and
    // marks our own moves wrong. Splitting the files by colour does not fix
    // that; this tag is what the trainer actually reads.
    `[Orientation "${colour.toLowerCase()}"]`,
    `[Annotator "Stockfish + Lichess explorer"]`,
    ...(input.eco ? [`[ECO "${safeTag(input.eco)}"]`] : []),
    ...(input.opening ? [`[Opening "${safeTag(input.opening)}"]`] : []),
    ...(forcedSans.length ? [`[Variation "${safeTag(forcedSans.join(' '))}"]`] : []),
    // Provenance is not bookkeeping. Multithreaded Stockfish at a fixed node
    // count is not reproducible, and every number here was silently
    // unrepeatable until that was found — so an evaluation without the
    // conditions that produced it cannot be trusted.
    ...(input.provenance?.engine ? [`[Engine "${safeTag(input.provenance.engine)}"]`] : []),
    ...(input.provenance?.nodes
      ? [`[EngineNodes "${input.provenance.nodes}"]`]
      : []),
    ...(typeof input.provenance?.threads === 'number'
      ? [
          `[EngineThreads "${input.provenance.threads}"]`,
          `[Reproducible "${input.provenance.threads === 1 ? 'yes' : 'no — multithreaded search'}"]`,
        ]
      : []),
    ...(input.provenance?.minDepth ? [`[MinDepth "${input.provenance.minDepth}"]`] : []),
  ]

  return `${headers.join('\n')}\n\n${wrap(mergeComments([...tokens, '*']))}\n`
}
