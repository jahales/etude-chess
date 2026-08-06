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
}

/** PGN comments are `{...}`, so a brace inside one would close it early. */
function safeComment(text: string): string {
  return text.replace(/[{}]/g, '')
}

/** Positions are keyed by the first four FEN fields, so transpositions collapse. */
export function fenKey(fen: string): string {
  return fen.split(' ').slice(0, 4).join(' ')
}

/** Mark how bad an opponent's move is, so the trainer shows it at a glance. */
function annotate(child: RepertoireChild): string {
  if (child.reason === 'ours' || child.reason === 'ours-engine') return ''
  if (typeof child.swing !== 'number') return ''
  if (child.swing > 25) return '??'
  if (child.swing > 15) return '?'
  if (child.swing > 10) return '?!'
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
  // Where another branch owns everything after this move, that is the whole
  // story — including for a trap, whose refutation is crawled and verified
  // there. Said once, on the move, rather than repeated by the position after.
  const covered = child.delegatedTo ? `{covered in the "${child.delegatedTo}" line}` : null

  if (child.reason === 'trap' || child.reason === 'mass+trap') {
    const bits: string[] = ['trap']
    if (typeof child.frequency === 'number') bits.push(`${pct(child.frequency)} play this`)
    if (typeof child.practical === 'number' && typeof child.expected === 'number') {
      bits.push(`they score ${pct(child.practical)} where ${pct(child.expected)} is deserved`)
    }
    if (typeof child.games === 'number') bits.push(`n=${child.games}`)
    const head = `{${bits.join(' · ')}}`
    // Saying where it is covered beats both alternatives: claiming a punishment
    // this crawl never checked, and warning about one that has in fact been
    // checked in the branch that owns it.
    if (covered) return `${head} ${covered}`
    // A trap whose refutation does not actually leave us better is worse than
    // no trap at all — you would drill it as a win and reach an equal game.
    //
    // Note the test is `!== true`, not `=== false`. `undefined` means the check
    // never ran (the position transposed into one already visited, or sat on the
    // depth cap), and treating "not verified" as "verified" is precisely the
    // silent-success failure this annotation exists to prevent.
    if (child.punished !== true) {
      if (child.punished === false) {
        const after =
          typeof child.afterReplyWinPercent === 'number'
            ? ` (only ${child.afterReplyWinPercent.toFixed(0)}% after our reply)`
            : ''
        return `${head} {WARNING: punishment unconfirmed${after} — play it out, don't trust the label}`
      }
      return `${head} {punishment not verified — play it out yourself}`
    }
    return head
  }
  if (covered) return covered
  if (child.reason === 'ours-engine') return '{engine refutation — too rare to appear in human play}'
  // Worth flagging: past this point the move is not backed by master practice,
  // so it is a reasonable choice rather than established theory.
  if (child.reason === 'ours' && child.source === 'band') {
    return '{beyond master theory — chosen from club play}'
  }
  return null
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
      return `covered in the "${node.delegatedTo ?? '?'}" line`
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

  for (const alt of alts) {
    const inner = [token(`${alt.san}${annotate(alt)}`, ply, true)]
    const altEval = evalComment(alt)
    if (altEval) inner.push(altEval)
    const note = childComment(alt)
    if (note) inner.push(note)
    // Not into a branch someone else owns: the move's own comment says where it
    // is covered, and descending would only repeat that on the position after.
    if (!alt.delegatedTo) inner.push(...emitFrom(nodes, alt.fen, ply + 1, true))
    out.push(`(${inner.join(' ')})`)
  }

  // After a variation closes, a following black move must restate its number.
  if (!main.delegatedTo) out.push(...emitFrom(nodes, main.fen, ply + 1, alts.length > 0))
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
  tokens.push(...forcedSans.map((san, i) => token(san, i, false)))
  tokens.push(...emitFrom(nodes, rootFen, forcedSans.length, false))

  const headers = [
    `[Event "Repertoire — ${colour}${input.name ? `: ${input.name}` : ''}"]`,
    `[Site "etude-chess repertoire generator"]`,
    `[Date "${date.replace(/-/g, '.')}"]`,
    `[White "${colour === 'White' ? 'Repertoire' : 'Opponent'}"]`,
    `[Black "${colour === 'Black' ? 'Repertoire' : 'Opponent'}"]`,
    `[Result "*"]`,
    `[Annotator "Stockfish + Lichess explorer"]`,
    ...(forcedSans.length ? [`[Opening "${forcedSans.join(' ')}"]`] : []),
    // Provenance is not bookkeeping. Multithreaded Stockfish at a fixed node
    // count is not reproducible, and every number here was silently
    // unrepeatable until that was found — so an evaluation without the
    // conditions that produced it cannot be trusted.
    ...(input.provenance?.engine ? [`[Engine "${input.provenance.engine}"]`] : []),
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

  return `${headers.join('\n')}\n\n${wrap([...tokens, '*'])}\n`
}
