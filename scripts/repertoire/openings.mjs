// Opening names, keyed by position (#92).
//
// A repertoire picks one move where several are sound, and the trainer then
// demands exactly that move. Without a reason that is indistinguishable from
// guessing: at `1.d4 d5 2.c4 e6` both 3.cxd5 and 3.Nc3 are fine, and being told
// "wrong" for the other one teaches nothing.
//
// The reason a repertoire actually has is *which variation you are learning*.
// So each of our moves is labelled with the variation it enters — "→ Queen's
// Gambit Declined: Exchange Variation" — which is checkable, memorable, and the
// thing a player is really choosing between.
//
// Keyed on the position rather than the move sequence, deliberately: `1.d4 e6
// 2.c4 d5 3.Nc3` and `1.d4 d5 2.c4 e6 3.Nc3` are one board by two orders, and a
// table that named only one of them would reintroduce the transposition problem
// the crawler just had to solve.

import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Chess } from 'chess.js'
import { fenKey } from '../../src/domain/repertoirePgn.ts'

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), 'data')

/** Positions are keyed by the first four FEN fields, as everywhere else here. */
export const positionKeyFor = fenKey

/**
 * One ECO file: `eco · name · pgn`, tab-separated, with a header row.
 *
 * The header is checked rather than skipped blindly. If upstream reorders the
 * columns, every lookup silently returns nothing — which looks exactly like
 * "these positions have no name" and would be found only by noticing the
 * annotations had quietly stopped appearing.
 */
export function parseEcoTsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim())
  const header = lines.shift()
  if (header !== 'eco\tname\tpgn') {
    throw new Error(`unexpected ECO header "${header}" — expected "eco\tname\tpgn"`)
  }
  return lines.map((line) => {
    const [eco, name, pgn] = line.split('\t')
    return { eco, name, sans: pgn.split(/\s+/).filter((t) => !/^\d+\.+$/.test(t)) }
  })
}

let cache = null

/**
 * `positionKey → { eco, name }` for every named opening.
 *
 * Loaded once. Replaying 3,815 short games is a few hundred milliseconds and a
 * build crawls thousands of positions against it.
 */
export function loadOpenings() {
  if (cache) return cache
  const openings = new Map()

  // Named, not left as an opaque ENOENT from readdirSync. The blanket `data/`
  // rule in .gitignore swallowed this directory once — `git add -A` said
  // nothing, every local test passed, and CI was the only thing that noticed.
  let files
  try {
    files = readdirSync(DATA_DIR).filter((f) => f.endsWith('.tsv')).sort()
  } catch (err) {
    throw new Error(
      `no ECO table at ${DATA_DIR} — is that directory gitignored? ` +
        `See scripts/repertoire/data/README.md for how to fetch it.`,
      { cause: err },
    )
  }
  if (files.length === 0) {
    throw new Error(`no .tsv files in ${DATA_DIR} — see its README.md for how to fetch them.`)
  }

  for (const file of files) {
    for (const { eco, name, sans } of parseEcoTsv(readFileSync(join(DATA_DIR, file), 'utf8'))) {
      const board = new Chess()
      let legal = true
      for (const san of sans) {
        try {
          if (!board.move(san)) legal = false
        } catch {
          legal = false
        }
        if (!legal) break
      }
      // A row we cannot replay is upstream's problem, not this build's — skip it
      // rather than failing a repertoire over one malformed line.
      if (legal) openings.set(positionKeyFor(board.fen()), { eco, name })
    }
  }
  cache = openings
  return openings
}

/** The named variation this position is in, or null. */
export function openingAt(fen, openings = loadOpenings()) {
  return openings.get(positionKeyFor(fen)) ?? null
}

/**
 * The variation a line is heading for, found by looking **forward** through our
 * own tree from this position.
 *
 * Not the name of the position itself, deliberately. The table indexes named
 * *lines*, not every position: `1.d4 d5 2.c4 e6 3.cxd5` is unnamed even though
 * the Exchange Variation is named at three other move orders. Annotating the
 * position after our move would therefore say nothing at exactly the fork that
 * needs it — which is the fork the trainer was demanding an unexplained move at.
 *
 * The deepest name wins, because it is the most specific: "Queen's Gambit" is
 * true of the whole branch and tells you nothing about which line you chose.
 */
export function variationFor(nodes, fen, openings = loadOpenings()) {
  const seen = new Set()

  const walk = (positionFen, depth) => {
    const key = positionKeyFor(positionFen)
    // Nodes are keyed by position, so a transposition back into the tree is a
    // cycle; without this the walk never returns.
    if (seen.has(key)) return null
    seen.add(key)

    let best = null
    const here = openings.get(key)
    if (here) best = { ...here, depth }

    for (const child of nodes.get(key)?.children ?? []) {
      const found = walk(child.fen, depth + 1)
      if (found && (!best || found.depth > best.depth)) best = found
    }
    return best
  }

  const found = walk(fen, 0)
  return found ? { eco: found.eco, name: found.name } : null
}

/**
 * Label each of our moves with the variation it commits the line to.
 *
 * Mutates the children in place, setting `entersVariation` where the answer
 * changes. Only on a change: repeating "Queen's Gambit Declined" down twelve
 * plies buries the one label that answers the question, which is what happens
 * at a fork where several moves are sound and the trainer wants exactly one.
 *
 * Our moves only. The opponent's choices are theirs to make; ours are the ones
 * being drilled, and "I was left guessing among candidate moves" is a complaint
 * about our side of the board.
 */
export function labelVariations(nodes, rootFen, openings = loadOpenings()) {
  let labelled = 0
  const walk = (fen, inherited) => {
    const node = nodes.get(positionKeyFor(fen))
    if (!node) return
    for (const child of node.children ?? []) {
      let carry = inherited
      if (node.ours) {
        const heading = variationFor(nodes, child.fen, openings)
        if (heading && heading.name !== inherited) {
          child.entersVariation = heading.name
          child.eco = heading.eco
          labelled++
          carry = heading.name
        }
      }
      walk(child.fen, carry)
    }
  }
  walk(rootFen, null)
  return labelled
}

/**
 * A variation name for each curated-prefix move, or null where it commits to
 * nothing new — parallel to `forcedSans`.
 *
 * The prefix is a run of our decisions, and the trainer quizzes them like any
 * other move. `3.cxd5` in the QGD Exchange is the whole reason that branch
 * exists, and it lives here rather than in the crawled tree.
 */
export function prefixVariations(nodes, forcedSans, ourColor, openings = loadOpenings()) {
  const board = new Chess()
  const notes = []
  const ourPlies = []
  let inherited = null

  for (const [i, san] of forcedSans.entries()) {
    const ourTurn = board.turn() === ourColor
    if (!board.move(san)) break
    // No lookahead here: the crawled tree begins *after* the prefix, so there is
    // nothing to walk forward through. Each move gets its own position's name.
    const here = openings.get(positionKeyFor(board.fen()))
    if (ourTurn) ourPlies.push(i)
    if (ourTurn && here && here.name !== inherited) {
      notes.push(here.name)
      inherited = here.name
    } else {
      notes.push(null)
      if (here) inherited = here.name
    }
  }

  // The last of our prefix moves is where the branch commits — `3.cxd5` is why
  // the QGD Exchange branch exists, and it is unnamed in the table at this move
  // order. That is exactly the fork where several moves are sound and the
  // trainer wants one, so it carries the variation the branch heads for.
  const last = ourPlies.at(-1)
  if (last !== undefined) {
    const heading = variationFor(nodes, board.fen(), openings)
    if (heading && heading.name !== inherited) notes[last] = heading.name
  }
  return notes
}
