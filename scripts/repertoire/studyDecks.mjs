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
import { parseArgs, stringFlag } from './build.mjs'

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

    for (const path of pgnPaths) {
      const text = readFileSync(path, 'utf8')
      const pruned = prunePgn(text, keep)
      if (!pruned.trim()) continue
      // One file per colour per tier: En Croissant trains from a single side's
      // point of view, so a PGN holding both is importable as neither.
      const colour = orientationOf([...parsePgn(text)][0]) === 'w' ? 'white' : 'black'
      // Name from the *directory* as well as the file. Both White decks are
      // called `repertoire-white.pgn` in their own build directory, so keying on
      // the filename alone had the 1.e4 deck silently overwrite the 1.d4 one —
      // a whole repertoire lost with no error and a plausible file left behind.
      const parts = path.split(/[\\/]/)
      const stem = `${parts.at(-2)}-${parts.at(-1).replace(/\.pgn$/, '')}`
      writeFileSync(join(outDir, `${label}-${stem}.pgn`), pruned)
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
