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
 * Lines of traps that survived cross-month replication.
 *
 * `replicate.mjs` splits its findings three ways and only `confirmed` means
 * two independent months agreed on both the finding and its magnitude. A trap
 * seen in one month is one month's evidence, which for a statistic over noisy
 * human data is close to none.
 */
export function confirmedTraps(replications) {
  const lines = new Set()
  for (const r of replications) for (const c of r?.confirmed ?? []) lines.add(c.line)
  return lines
}

/**
 * Decisions that answer a confirmed trap, with the trap line that earned them.
 *
 * A trap is the *opponent's* move, so it is never a decision itself and never
 * ranks. Our refutation is the ply after it, and that is what has to be in the
 * deck — otherwise pruning removes the whole subtree and the highest-value
 * content in the repertoire is the part you never drill. Measured: the standard
 * White deck contained **two** trap comments out of 282 confirmed.
 */
export function trapRefutations(ranked, confirmed) {
  const pinned = new Map()
  // Depth in plies, not characters. Comparing string length picks the wrong
  // decision whenever the immediate reply has a long SAN and a deeper line has
  // short ones — `T Qxd8+` is seven characters past the trap and the two-ply
  // `T f6 e4` is six, so the continuation would win and the refutation itself
  // would be left unpinned, which is the exact failure this function prevents.
  const plies = (line) => line.split(' ').length
  for (const trap of confirmed) {
    // The shallowest decision below the trap is the reply to it.
    let best = null
    for (const r of ranked) {
      if (!r.line.startsWith(`${trap} `)) continue
      if (!best || plies(r.line) < plies(best.line)) best = r
    }
    if (best) pinned.set(best.line, trap)
  }
  return pinned
}

/**
 * Assign every decision to a tier, prefix-closed.
 *
 * Greedy by value, but a decision costs its whole unadmitted ancestry: a
 * brilliant move eleven plies down only enters a tier if the ten decisions
 * leading to it fit as well. That is what makes each tier a set of complete
 * lines rather than a list of positions.
 *
 * @param {{line: string, value?: number, skipped?: string}[]} ranked  from studyOrder
 * @param {number[]} sizes  cumulative budgets; the rest is the last tier
 * @param {Set<string>} [pin]  lines admitted to the first tier regardless of rank
 * @returns {Map<string, number>} line -> tier index
 */
export function assignTiers(ranked, sizes, pin = new Set()) {
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

  // Pinned lines go in first and over budget. A confirmed trap is the one thing
  // `studyOrder` cannot rank: its value is in what the *opponent* does, so the
  // reach × cost of our reply understates it badly — the Englund refutation is
  // the highest-value trap in the repertoire and the owner's worst-scoring
  // opening, and it ranked nowhere near the top.
  let current = 0
  for (const line of pin) {
    for (const need of closure(line)) tier.set(need, 0)
  }

  // `used` is the running total admitted across *all* tiers so far, which is
  // what makes the comparison against a cumulative budget meaningful. It starts
  // at whatever pinning admitted, including however far that went over
  // sizes[0]: resetting it to the nominal boundary on each advance would hand
  // the overflow back as free space and let every later tier drift past its
  // stated size. With one boundary the last tier is unbounded so nothing shows;
  // with two, six pinned lines under `--sizes 3,5` produced tiers of 6/2/2 —
  // eight decisions inside a budget of five.
  let used = tier.size

  for (const row of order) {
    if (tier.has(row.line)) continue
    // `closure` always returns at least `row.line` itself: it is in `byLine`
    // (it came from `ranked`) and not yet in `tier` (just checked).
    const need = closure(row.line)

    // Advance a tier when this admission would overflow the budget. The last
    // tier has no budget: everything left belongs to it.
    while (current < sizes.length && used + need.length > sizes[current]) current++
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
export function prunePgn(text, keep, confirmed = null) {
  const games = []
  for (const game of parsePgn(text)) {
    const walk = (node, line) => {
      node.children = node.children.filter((child) => {
        const next = [...line, child.data.san]
        const path = next.join(' ')

        // A `trap` label has to mean *replicated*, or it means nothing: one
        // month's data cannot tell a real trap from a coin flip, and 51 of 366
        // did not survive a second month. The statistics stay — they are still
        // true of the month they came from — but the word that invites you to
        // trust them is removed.
        if (confirmed && !confirmed.has(path)) {
          child.data.comments = (child.data.comments ?? []).map((c) =>
            c.includes(' trap ') ? c.replace(' trap ·', ' one month only ·') : c,
          )
        }

        // Keep a node if it is retained itself, if a confirmed trap sits here,
        // or if anything under it survives.
        const survives = walk(child, next)
        return keep.has(path) || confirmed?.has(path) || survives
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
 * Detecting one needs to know whose move a node holds, because two children are
 * *correct* under the opponent — that is us answering their alternatives — and
 * wrong under us, where the whole point is that there is one move to play. The
 * root's children are White's first move, so depth parity plus the deck's
 * orientation settles it. Without `orientation` the check cannot run and is
 * skipped rather than guessed at.
 *
 * @param {object[]} games
 * @param {'w'|'b'|null} [orientation]  the side this deck drills
 * @returns {{root: object, conflicts: {line: string, a: string, b: string}[]}}
 */
export function mergeGames(games, orientation = null) {
  const root = { children: [] }
  const conflicts = []
  const oursAt = (depth) => orientation !== null && (depth % 2 === 0 ? 'w' : 'b') === orientation

  const graft = (into, from, line, depth) => {
    for (const child of from.children) {
      const san = child.data.san
      let match = into.children.find((c) => c.data.san === san)
      if (!match) {
        // A second distinct move where *we* are to play is two branches
        // prescribing different answers to one position — the defect branch
        // ownership exists to prevent, and one that would drill you as wrong
        // half the time. Recorded with the path so it can be found by hand.
        //
        // Except at the root, where alternatives are the design: 1.d4 and 1.e4
        // are two repertoires you choose between at the board, which is why a
        // White deck holds both. Flagging that would fire on every run and
        // train the reader to ignore the warning (issue #114).
        if (depth > 0 && oursAt(depth) && into.children.length) {
          conflicts.push({ line: line.join(' '), a: into.children[0].data.san, b: san })
        }
        // Copy the node rather than splicing the original in, so two decks
        // built from the same source cannot alias each other's children.
        match = { data: { ...child.data }, children: [] }
        into.children.push(match)
      } else if (child.data.comments?.length && !match.data.comments?.length) {
        match.data.comments = child.data.comments
      }
      graft(match, child, [...line, san], depth + 1)
    }
  }

  for (const game of games) graft(root, game.moves, [], 0)
  return { root, conflicts }
}

/**
 * One PGN game per first move, rather than one per manifest branch.
 *
 * @returns {{pgn: string, conflicts: {line: string, a: string, b: string}[]}}
 */
export function mergeByRoot(text, headers, orientation = null) {
  const games = [...parsePgn(text)]
  if (!games.length) return { pgn: '', conflicts: [] }
  const { root, conflicts } = mergeGames(games, orientation)

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
  return { pgn: out.join('\n'), conflicts }
}

/**
 * Names for `count` tiers, last one always `complete`.
 *
 * Keyed on how many there are rather than fixed, because the names are what
 * appears in a filename you pick at drilling time and a two-tier split labelled
 * `core` / `standard` would leave the *complete* repertoire called "standard".
 */
export function tierNames(count) {
  if (count <= 1) return ['complete']
  if (count === 2) return ['standard', 'complete']
  if (count === 3) return ['core', 'standard', 'complete']
  return [...Array(count - 1).keys()].map((i) => `tier${i + 1}`).concat('complete')
}

async function main() {
  const args = parseArgs(process.argv.slice(2), ['pgn', 'index', 'book', 'sizes', 'out', 'replicated'])
  const pgnPaths = (stringFlag(args, 'pgn') ?? '').split(',').filter(Boolean).map((p) => p.trim())
  if (!pgnPaths.length) throw new Error('--pgn is required (comma-separated repertoire PGNs)')

  // Validated rather than trusted: `--sizes abc` yields [NaN], every budget
  // comparison against NaN is false, so nothing ever advances a tier and the
  // run writes two identically-sized decks under different names and exits 0.
  // Descending sizes are just as quiet, and mean nothing as cumulative budgets.
  const sizes = (stringFlag(args, 'sizes') ?? '150,500').split(',').map(Number)
  if (!sizes.length || sizes.some((n) => !Number.isInteger(n) || n <= 0)) {
    throw new Error(`--sizes must be positive whole numbers, got "${stringFlag(args, 'sizes')}"`)
  }
  if (sizes.some((n, i) => i > 0 && n <= sizes[i - 1])) {
    throw new Error(`--sizes must ascend — they are cumulative budgets, got ${sizes.join(',')}`)
  }
  const outDir = stringFlag(args, 'out') ?? join(repoRoot, 'out', 'decks')

  const db = createEvalDb({ dir: stringFlag(args, 'index') ?? join(repoRoot, 'db', 'eval-index') })
  const band = await createLocalBook({
    path: stringFlag(args, 'book') ?? join(repoRoot, 'db', 'book-band-2026-07.json'),
  })

  const ranked = await studyOrder({ pgnPaths, db, band })

  // Traps that survived cross-month replication are pinned into the first tier:
  // studyOrder cannot rank them, because a trap's value lies in what the
  // *opponent* does and our reply's reach x cost understates it badly.
  const replicated = (stringFlag(args, 'replicated') ?? '')
    .split(',').filter(Boolean)
    .map((p) => JSON.parse(readFileSync(join(repoRoot, p.trim()), 'utf8')))
  const confirmed = confirmedTraps(replicated)
  const pinned = trapRefutations(ranked, confirmed)
  if (confirmed.size) {
    process.stdout.write(
      `\n${confirmed.size} replicated trap(s) · ${pinned.size} refutation(s) pinned into the first tier\n`,
    )
  }

  const tier = assignTiers(ranked, sizes, new Set(pinned.keys()))
  const names = tierNames(sizes.length + 1)

  mkdirSync(outDir, { recursive: true })
  process.stdout.write(`\n${ranked.length} decisions across ${pgnPaths.length} file(s)\n\n`)

  // Read and classify each source once. Neither the file's contents nor which
  // colour it drills depends on the tier, and doing it inside the loop parsed
  // every multi-megabyte PGN twice per tier — once here and once in prunePgn.
  const sources = pgnPaths.map((path) => {
    const text = readFileSync(path, 'utf8')
    return { text, colour: orientationOf([...parsePgn(text)][0]) === 'w' ? 'white' : 'black' }
  })
  const allConflicts = []

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
    for (const { text, colour } of sources) {
      const pruned = prunePgn(text, keep, confirmed.size ? confirmed : null)
      if (!pruned.trim()) continue
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
      const { pgn: merged, conflicts } = mergeByRoot(
        mergePgn(parts),
        headers,
        colour === 'white' ? 'w' : 'b',
      )
      for (const c of conflicts) allConflicts.push({ deck: `${colour}-${label}`, ...c })
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

  // Loud, and non-zero. A deck that answers one position two ways marks you
  // wrong half the time you drill it, and the decks are already on disk by
  // here — so this has to be impossible to read as a clean run.
  if (allConflicts.length) {
    process.stderr.write(
      `\n${allConflicts.length} position(s) answered two different ways — the decks are wrong:\n`,
    )
    for (const c of allConflicts) {
      process.stderr.write(`  ${c.deck}  after "${c.line || '(start)'}": ${c.a} vs ${c.b}\n`)
    }
    process.stderr.write('\nbranch ownership should make this impossible; fix the manifest.\n')
    process.exitCode = 1
  }
}

// Windows gives `file:///C:/…` from import.meta.url but argv[1] is a plain path,
// so compare through pathToFileURL — as build.mjs, crawl.mjs and buildBook.mjs do.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
