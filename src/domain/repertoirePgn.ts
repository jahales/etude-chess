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
  /** Win% the mover gives up versus best, 0–100. Absent on our own moves. */
  swing?: number
}

export interface RepertoireNode {
  children: RepertoireChild[]
  terminal?: boolean
  terminalReason?: 'quiet' | 'depth-cap' | 'out-of-book' | 'no-sound-move'
  quiet?: { breadth: number }
  games?: number
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

/** Why this move is here, when that isn't obvious from the move itself. */
function childComment(child: RepertoireChild): string | null {
  if (child.reason === 'trap') return '{trap: overperforms its evaluation}'
  if (child.reason === 'ours-engine') return '{engine refutation — too rare to appear in human play}'
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

  const [main, ...alts] = node.children
  if (!main) return out
  out.push(token(`${main.san}${annotate(main)}`, ply, needsNumber))
  const mainNote = childComment(main)
  if (mainNote) out.push(mainNote)

  for (const alt of alts) {
    const inner = [token(`${alt.san}${annotate(alt)}`, ply, true)]
    const note = childComment(alt)
    if (note) inner.push(note)
    inner.push(...emitFrom(nodes, alt.fen, ply + 1, true))
    out.push(`(${inner.join(' ')})`)
  }

  // After a variation closes, a following black move must restate its number.
  out.push(...emitFrom(nodes, main.fen, ply + 1, alts.length > 0))
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
  const tokens = forcedSans.map((san, i) => token(san, i, false))
  tokens.push(...emitFrom(nodes, rootFen, forcedSans.length, false))

  const headers = [
    `[Event "Repertoire — ${colour}"]`,
    `[Site "etude-chess repertoire generator"]`,
    `[Date "${date.replace(/-/g, '.')}"]`,
    `[White "${colour === 'White' ? 'Repertoire' : 'Opponent'}"]`,
    `[Black "${colour === 'Black' ? 'Repertoire' : 'Opponent'}"]`,
    `[Result "*"]`,
    `[Annotator "Stockfish + Lichess explorer"]`,
    ...(forcedSans.length ? [`[Opening "${forcedSans.join(' ')}"]`] : []),
  ]

  return `${headers.join('\n')}\n\n${wrap([...tokens, '*'])}\n`
}
