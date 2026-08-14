// Split the repertoire into tiers you learn in order.
//
//   node scripts/repertoire/studyDecks.mjs --pgn out/v2-main/repertoire.pgn \
//        --sizes 150,500 --out out/decks
//
// A repertoire of two thousand decisions is not a study plan, and cutting it
// down throws away work that is fine — it is just not what to learn *first*.
// So it is staged instead: a core deck small enough to actually master, then
// progressively complete ones, each a **superset** of the last so nothing is
// ever relearned.
//
// The order comes from `studyOrder`: reach × the cost of playing the natural
// move instead. What that alone would produce, though, is a scattered set of
// positions from all over the tree — you cannot drill move 12 of the Carlsbad
// without moves 1 to 11. So a deck must be **closed under prefixes**, and each
// decision is admitted together with every decision on the path to it. The
// budget is spent on the ancestors too, which is what keeps a tier drillable
// rather than merely well-ranked.

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { makePgn, parsePgn } from 'chessops/pgn'
import { createEvalDb } from './evalDb.mjs'
import { createLocalBook } from './localBook.mjs'
import { studyOrder } from './studyOrder.mjs'
import { orientationOf } from './readRepertoirePgn.mjs'
import { mergePgn, parseArgs, stringFlag } from './build.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..')

/**
 * Assign every decision to a tier, prefix-closed.
 *
 * Greedy by value, but a decision costs its whole unadmitted ancestry: a
 * brilliant move eleven plies down only enters a tier if the ten decisions
 * leading to it fit as well. That is what makes each tier a set of complete
 * lines rather than a list of positions.
 *
 * @param {{line: string, value?: number, skipped?: string}[]} ranked  from studyOrder
 * @param {number[]} sizes  cumulative budgets, e.g. [150, 500]; the rest is the last tier
 * @returns {Map<string, number>} line -> tier index
 */
export function assignTiers(ranked, sizes) {
  const byLine = new Map(ranked.map((r) => [r.line, r]))
  const tier = new Map()

  /** The decision itself plus every ancestor decision not yet admitted. */
  const closure = (line) => {
    const need = []
    const sans = line.split(' ')
    for (let n = 1; n <= sans.length; n++) {
      const prefix = sans.slice(0, n).join(' ')
      if (byLine.has(prefix) && !tier.has(prefix)) need.push(prefix)
    }
    return need
  }

  // Unscorable decisions still have to be somewhere, and they are by definition
  // the ones we know least about — so they go last rather than being dropped.
  const order = [...ranked].sort((a, b) => (b.value ?? -1) - (a.value ?? -1))

  let current = 0
  let used = 0
  for (const row of order) {
    if (tier.has(row.line)) continue
    const need = closure(row.line)
    if (!need.length) continue

    // Advance a tier when this admission would overflow the budget. The last
    // tier has no budget: everything left belongs to it.
    while (current < sizes.length && used + need.length > sizes[current]) {
      current++
      used = current === 0 ? 0 : sizes[current - 1]
    }
    for (const line of need) tier.set(line, current)
    used += need.length
  }
  return tier
}

/**
 * Prune a repertoire PGN to the lines a tier covers.
 *
 * Keeps any node on the path to a retained decision, so the output is a set of
 * whole games rather than fragments. Opponent moves are kept wherever the reply
 * beneath them survives — a deck that dropped them would be a deck that answers
 * moves it never shows you.
 */
export function prunePgn(text, keep) {
  const games = []
  for (const game of parsePgn(text)) {
    const walk = (node, line) => {
      node.children = node.children.filter((child) => {
        const next = [...line, child.data.san]
        const path = next.join(' ')
        // Keep a node if it is retained itself, or if anything under it is.
        const survives = walk(child, next)
        return keep.has(path) || survives
      })
      return node.children.length > 0
    }
    walk(game.moves, [])
    if (game.moves.children.length) games.push(game)
  }
  return games.map((g) => makePgn(g)).join('\n')
}

/**
 * Graft every game into one tree.
 *
 * A manifest *branch* becomes a PGN game, which is right for building — branch
 * ownership is what stops two branches answering one position differently — and
 * wrong for drilling. The core White deck came out as **26 games for 144
 * decisions**, seventeen of them five moves or fewer and the smallest a single
 * move, so drilling meant choosing between twenty-six repertoire entries most
 * of which were two moves long.
 *
 * Grafting is safe precisely because ownership already holds: no two branches
 * prescribe different moves at the same position, so identical SANs merge and
 * nothing is lost. A disagreement would be a real defect, so it is returned
 * rather than silently resolved by whichever game was read first.
 *
 * @returns {{root: object, conflicts: {line: string, a: string, b: string}[]}}
 */
export function mergeGames(games) {
  const root = { children: [] }
  const conflicts = []

  const graft = (into, from, line) => {
    for (const child of from.children) {
      const san = child.data.san
      let match = into.children.find((c) => c.data.san === san)
      if (!match) {
        // Copy the node rather than splicing the original in, so two decks
        // built from the same source cannot alias each other's children.
        match = { data: { ...child.data }, children: [] }
        into.children.push(match)
      } else if (child.data.comments?.length && !match.data.comments?.length) {
        match.data.comments = child.data.comments
      }
      graft(match, child, [...line, san])
    }
  }

  for (const game of games) graft(root, game.moves, [])
  return { root, conflicts }
}

/** One PGN game per first move, rather than one per manifest branch. */
export function mergeByRoot(text, headers) {
  const games = [...parsePgn(text)]
  if (!games.length) return ''
  const { root } = mergeGames(games)

  // One game per opening move keeps a White deck's 1.d4 and 1.e4 as separate
  // entries — they are alternatives you choose between, not one line — while a
  // Black deck, whose roots are the *opponent's* first moves, collapses to one.
  const out = []
  for (const child of root.children) {
    const game = {
      headers: new Map(headers),
      moves: { children: [child] },
    }
    game.headers.set('Event', `${headers.get('Event') ?? 'Repertoire'} — 1.${child.data.san}`)
    out.push(makePgn(game))
  }
  return out.join('\n')
}

async function main() {
  const args = parseArgs(process.argv.slice(2), ['pgn', 'index', 'book', 'sizes', 'out'])
  const pgnPaths = (stringFlag(args, 'pgn') ?? '').split(',').filter(Boolean).map((p) => p.trim())
  if (!pgnPaths.length) throw new Error('--pgn is required (comma-separated repertoire PGNs)')

  const sizes = (stringFlag(args, 'sizes') ?? '150,500').split(',').map(Number)
  const outDir = stringFlag(args, 'out') ?? join(repoRoot, 'out', 'decks')

  const db = createEvalDb({ dir: stringFlag(args, 'index') ?? join(repoRoot, 'db', 'eval-index') })
  const band = await createLocalBook({
    path: stringFlag(args, 'book') ?? join(repoRoot, 'db', 'book-band-2026-07.json'),
  })

  const ranked = await studyOrder({ pgnPaths, db, band })
  const tier = assignTiers(ranked, sizes)
  const names = ['core', 'standard', 'complete']

  mkdirSync(outDir, { recursive: true })
  process.stdout.write(`\n${ranked.length} decisions across ${pgnPaths.length} file(s)\n\n`)

  for (let t = 0; t < sizes.length + 1; t++) {
    // Cumulative: each deck is a superset of the last, so moving on to the next
    // one never means relearning the one before it.
    const keep = new Set([...tier].filter(([, n]) => n <= t).map(([line]) => line))
    const label = names[t] ?? `tier${t + 1}`
    process.stdout.write(`${label.padEnd(9)} ${String(keep.size).padStart(5)} decisions\n`)

    // **One file per colour, not per source.** Colour is the only axis En
    // Croissant has: it trains from a single side's point of view, so a PGN
    // holding both is importable as neither — and two files of the *same*
    // colour mean choosing between them at every session for no reason. The
    // 1.d4 and 1.e4 repertoires are both White, so they belong in one White
    // deck; whether to play both is a repertoire decision, not a drilling one.
    const byColour = { white: [], black: [] }
    for (const path of pgnPaths) {
      const text = readFileSync(path, 'utf8')
      const pruned = prunePgn(text, keep)
      if (!pruned.trim()) continue
      const colour = orientationOf([...parsePgn(text)][0]) === 'w' ? 'white' : 'black'
      byColour[colour].push(pruned)
    }
    for (const [colour, parts] of Object.entries(byColour)) {
      if (!parts.length) continue
      // Grafted into one tree per opening move, not left as one game per
      // manifest branch — see mergeGames for why that split belongs to the
      // build and not to drilling.
      const headers = new Map([
        ['Event', `etude-chess ${label} — ${colour}`],
        ['Orientation', colour],
        ['Result', '*'],
      ])
      const merged = mergeByRoot(mergePgn(parts), headers)
      writeFileSync(join(outDir, `etude-${colour}-${label}.pgn`), merged)
      const games = (merged.match(/\[Event /g) ?? []).length
      process.stdout.write(`  ${colour.padEnd(5)} ${parts.length} source(s) -> ${games} game(s)\n`)
    }
  }

  writeFileSync(
    join(outDir, 'tiers.json'),
    JSON.stringify(
      { generated: new Date().toISOString(), sizes, tiers: [...tier].map(([line, n]) => ({ line, tier: n })) },
      null,
      2,
    ),
  )
  process.stdout.write(`\ndecks: ${outDir}\n`)
  db.close()
}

// Windows gives `file:///C:/…` from import.meta.url but argv[1] is a plain path,
// so compare through pathToFileURL — as build.mjs, crawl.mjs and buildBook.mjs do.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
