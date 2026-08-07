// Build the whole repertoire — every branch of the manifest, one run (#88).
//
// crawl.mjs produces one branch. This produces the repertoire: it loads the
// books and the engine once, crawls each branch of manifest.v1.json with the
// boundaries src/domain/repertoirePlan.ts derives, and emits one PGN holding
// every branch as a game — which is the form En Croissant's repertoire trainer
// wants.
//
// The plan is validated *before* any engine time is spent. A manifest with a
// coverage gap produces a repertoire that looks complete and has no answer to a
// common move, and an hour is a long time to find that out.

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, basename, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Chess } from 'chess.js'
import { delegationsFor, plies, sumLoads, theoryLoad, validatePlan } from '../../src/domain/repertoirePlan.ts'
import { toPgn } from '../../src/domain/repertoirePgn.ts'
import { crawl, DEFAULTS } from './crawl.mjs'
import { createLocalBook } from './localBook.mjs'
import { createExplorer } from './explorer.mjs'
import { createEngine, DEFAULT_ENGINE_PATH } from './engine.mjs'

const here = dirname(fileURLToPath(import.meta.url))
export const DEFAULT_MANIFEST = join(here, 'manifest.v1.json')

/**
 * Plies of its own a branch gets past its curated prefix, when it does not say.
 *
 * Every branch gets the same *crawl*, not the same *depth*. A flat cap is wrong
 * in both directions: at 10 it leaves `e4 c6 d4 d5 exd5 cxd5` two moves to find
 * a quiet position, and it hands a "don't be surprised by 1...c5" sweeper a
 * nine-ply tree — which at half a second per engine search is most of an hour
 * spent on the least valuable branch in the repertoire.
 */
export const CRAWL_PLIES = 6

/**
 * Plies a branch must crawl before it is allowed to stop — one move each.
 *
 * Without this, a branch whose curated prefix is already past the global
 * `minPly` can terminate **on its own root**: the Caro-Kann Advance opens
 * `1.e4 c6 2.d4 d5 3.e5 Bf5`, which is a perfectly quiet position, so the whole
 * branch was one node and no content. The prefix is scaffolding to get to the
 * position worth studying; it cannot also be the study.
 */
export const MIN_OWN_PLIES = 2

export function resolveEntry(entry, defaults = {}) {
  const forced = plies(entry.line)
  const minPly = entry.minPly ?? Math.max(defaults.minPly ?? DEFAULTS.minPly, forced.length + MIN_OWN_PLIES)
  return {
    ...entry,
    forced,
    // The floor keeps a shallow branch from capping out before `minPly`, which
    // would leave it unable to end on a quiet position at all.
    maxPly: entry.maxPly ?? Math.max(minPly + 2, forced.length + (defaults.crawlPlies ?? CRAWL_PLIES)),
    minPly,
  }
}

/** Parse and shallow-check a manifest. Throws on anything unusable. */
export function parseManifest(text) {
  let raw
  try {
    raw = JSON.parse(text)
  } catch (err) {
    throw new Error(`manifest is not valid JSON: ${err.message}`, { cause: err })
  }
  const entries = raw?.entries
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('manifest has no `entries` array')
  }
  for (const entry of entries) {
    if (!entry?.id || !entry?.name) throw new Error(`manifest entry needs an id and a name: ${JSON.stringify(entry)}`)
    if (entry.color !== 'w' && entry.color !== 'b') {
      throw new Error(`entry "${entry.id}" has colour "${entry.color}"; expected "w" or "b"`)
    }
    if (typeof entry.line !== 'string') throw new Error(`entry "${entry.id}" has no line`)
  }
  return entries
}

/**
 * One PGN holding every branch as its own game. Blank-line separated, which is
 * what the PGN standard wants and what En Croissant's importer reads.
 */
export function mergePgn(games) {
  if (games.length === 0) return ''
  return `${games.map((g) => g.trim()).join('\n\n')}\n`
}

/**
 * The repertoire as one file per side.
 *
 * En Croissant trains from one side's point of view, so a file holding both
 * colours is not importable as either — it would try to drill you as White in
 * the Caro-Kann. The split lives in the build rather than in a pair of manual
 * commands, because a manual step drifts the moment the manifest changes.
 *
 * Order within each file follows the input, which `main` has already put in
 * manifest order.
 */
export function splitByColour(results) {
  const ok = results.filter((r) => !r.error)
  const pgnFor = (colour) => mergePgn(ok.filter((r) => r.entry.color === colour).map((r) => r.pgn))
  return { white: pgnFor('w'), black: pgnFor('b') }
}

/**
 * Crawl every branch. Sequential on purpose: they share one engine process, and
 * a single Stockfish at Threads=1 is the only configuration whose numbers
 * reproduce (see engine.mjs).
 *
 * A branch that throws does not take the run with it — losing forty minutes of
 * engine time to one bad line would be its own kind of silent failure, since the
 * obvious response is to stop running the build.
 */
export async function buildAll({
  entries,
  /**
   * The whole manifest, which is what decides the boundaries — not `entries`,
   * which is only what we chose to run today. Rebuilding one branch against a
   * filtered plan would give it a subtree the skipped branch already owns, and
   * the two would answer the same move differently.
   */
  plan = entries,
  engine,
  explorer,
  canon = null,
  defaults = {},
  date,
  provenance = {},
  onEntry = () => {},
}) {
  const results = []
  for (const entry of entries) {
    const resolved = resolveEntry(entry, defaults)
    const delegations = delegationsFor(entry, plan)
    const started = Date.now()
    try {
      const crawled = await crawl({
        ...defaults,
        engine,
        explorer,
        canon,
        ourColor: entry.color,
        forcedLine: resolved.forced,
        delegations,
        maxPly: resolved.maxPly,
        minPly: resolved.minPly,
        ...(entry.trapThreshold !== undefined ? { trapThreshold: entry.trapThreshold } : {}),
        ...(entry.maxEvalPerNode !== undefined ? { maxEvalPerNode: entry.maxEvalPerNode } : {}),
        ...(entry.massTarget !== undefined ? { massTarget: entry.massTarget } : {}),
        ...(entry.maxOpponentMoves !== undefined ? { maxOpponentMoves: entry.maxOpponentMoves } : {}),
      })
      const result = {
        entry: resolved,
        crawled,
        delegations,
        load: theoryLoad(crawled.nodes.values()),
        pgn: toPgn({
          nodes: crawled.nodes,
          rootFen: crawled.rootFen,
          forcedSans: crawled.forcedSans,
          ourColor: entry.color,
          date,
          name: entry.name,
          why: entry.why,
          provenance: {
            ...provenance,
            minDepth: Number.isFinite(crawled.report.minDepth) ? crawled.report.minDepth : undefined,
          },
        }),
        seconds: (Date.now() - started) / 1000,
      }
      // The JSON is kept either way: a rendering fault is not a reason to throw
      // away an expensive crawl, but it is a reason for the run to fail loudly.
      result.pgnError = pgnError(result.pgn)
      results.push(result)
    } catch (err) {
      results.push({ entry: resolved, error: err, seconds: (Date.now() - started) / 1000 })
    }

    // Outside the crawl's error boundary, deliberately. Reporting and writing
    // are not crawling: with `await onEntry(result)` inside the try, a disk
    // error was recorded as a failed crawl for a branch that had in fact
    // succeeded — and the catch block's own `onEntry(failed)` then threw
    // uncaught, taking every remaining branch with it.
    const last = results[results.length - 1]
    try {
      await onEntry(last)
    } catch (err) {
      last.writeError = err?.message ?? String(err)
    }
  }
  return results
}

/**
 * Load the PGN we just produced, and say so if it does not.
 *
 * Not paranoia: the first complete repertoire this script generated parsed
 * nowhere — two comments in a row, and a comment after a closing parenthesis.
 * Both legal by the spec, both rejected by chess.js. Every unit test passed and
 * the file looked immaculate. Checking the artefact against a real parser is
 * the only thing that catches that class of defect.
 */
export function pgnError(pgn) {
  try {
    new Chess().loadPgn(pgn)
    return null
  } catch (err) {
    return err.message
  }
}

/** One branch's two files: the annotated tree, and the PGN to import. */
export async function writeBranch(outDir, r) {
  // Everything that decided these numbers, minus the live objects. An
  // evaluation without the settings that produced it cannot be audited.
  const settings = Object.fromEntries(
    Object.entries(r.crawled.options).filter(
      ([k]) => !['engine', 'explorer', 'canon', 'delegations'].includes(k),
    ),
  )
  await writeFile(
    join(outDir, `${r.entry.id}.json`),
    JSON.stringify(
      {
        meta: { ...r.entry, settings },
        report: {
          ...r.crawled.report,
          minDepth: Number.isFinite(r.crawled.report.minDepth) ? r.crawled.report.minDepth : null,
        },
        load: r.load,
        delegations: Object.fromEntries(r.delegations),
        rootFen: r.crawled.rootFen,
        nodes: Object.fromEntries(r.crawled.nodes),
      },
      null,
      2,
    ),
    'utf8',
  )
  await writeFile(join(outDir, `${r.entry.id}.pgn`), r.pgn, 'utf8')
}

/** Every list `summarise` reads, so a file missing one cannot crash the roll-up. */
const EMPTY_REPORT = {
  traps: [],
  unpunishedTraps: [],
  unverifiedTraps: [],
  tooRareToJudge: [],
  truncatedNodes: [],
  outOfBook: [],
  engineFallbacks: [],
  delegated: [],
}

/**
 * Whether an earlier run finished this branch — **both** files, not just the
 * JSON. `writeBranch` writes the JSON and then the PGN, so a run killed between
 * the two leaves precisely the state that made `--resume` die on ENOENT before
 * it could crawl anything.
 */
export function isBuilt(outDir, entry) {
  return existsSync(join(outDir, `${entry.id}.json`)) && existsSync(join(outDir, `${entry.id}.pgn`))
}

/**
 * Load a branch built by an earlier run, in the shape `buildAll` returns.
 *
 * `--resume` skips branches that are already on disk, so without reading them
 * back the merged PGN would hold only what today's run happened to crawl — a
 * repertoire missing most of itself, written without complaint.
 */
export async function readBranch(outDir, entry, defaults = {}) {
  const saved = JSON.parse(await readFile(join(outDir, `${entry.id}.json`), 'utf8'))
  const pgn = await readFile(join(outDir, `${entry.id}.pgn`), 'utf8')
  const nodes = new Map(Object.entries(saved.nodes ?? {}))
  return {
    // With the run's defaults, so a resumed branch is described by the flags
    // this invocation was given rather than by the built-in constants.
    entry: resolveEntry(entry, defaults),
    crawled: {
      nodes,
      rootFen: saved.rootFen,
      // Filled in field by field. A file written by any earlier version of this
      // script is exactly what --resume exists to read, and taking `report` raw
      // handed `summarise` an undefined it then dereferenced.
      report: { ...EMPTY_REPORT, ...saved.report },
      options: saved.meta?.settings ?? {},
    },
    delegations: new Map(Object.entries(saved.delegations ?? {})),
    // Recomputed rather than defaulted to zero: the positions are right there,
    // and a load of zero would quietly shrink the repertoire's reported cost.
    load: saved.load ?? theoryLoad(nodes.values()),
    pgn,
    // Checked on the way back in, not assumed. A reused branch was written by a
    // different version of the renderer as often as not, and reporting "no
    // unparseable branches" without having looked at most of them is the same
    // silent success this check exists to catch.
    pgnError: pgnError(pgn),
    seconds: 0,
    reused: true,
  }
}

/** Roll the per-branch reports up into the numbers worth looking at. */
export function summarise(results) {
  const ok = results.filter((r) => !r.error)
  const traps = ok
    .flatMap((r) => r.crawled.report.traps.map((t) => ({ ...t, entry: r.entry.id })))
    .sort((a, b) => b.trapValue - a.trapValue)

  return {
    branches: results.length,
    failed: results.filter((r) => r.error).map((r) => ({ id: r.entry.id, error: String(r.error?.message ?? r.error) })),
    /** Branches whose PGN a real parser refused. Always empty, or the run failed. */
    unparseable: ok.filter((r) => r.pgnError).map((r) => ({ id: r.entry.id, error: r.pgnError })),
    /** Branches that crawled fine but never reached disk. Also fails the run. */
    unwritten: results.filter((r) => r.writeError).map((r) => ({ id: r.entry.id, error: r.writeError })),
    /**
     * Branches that produced nothing of their own. Normally a sweeper whose
     * whole coverage target was consumed by moves other branches own — so the
     * replies it exists to catch fell below the mass cut and are covered by
     * nobody. Reported because a branch doing no work looks exactly like a
     * branch with nothing to do.
     */
    emptyBranches: ok
      .filter((r) => r.load.ourDecisions === 0 && r.load.quietTargets === 0)
      .map((r) => ({ id: r.entry.id, positions: r.crawled.nodes.size, delegated: r.load.delegated })),
    positions: ok.reduce((n, r) => n + r.crawled.nodes.size, 0),
    load: sumLoads(ok.map((r) => r.load)),
    traps,
    unpunished: ok.flatMap((r) => r.crawled.report.unpunishedTraps.map((t) => ({ ...t, entry: r.entry.id }))),
    unverified: ok.flatMap((r) => r.crawled.report.unverifiedTraps.map((t) => ({ ...t, entry: r.entry.id }))),
    tooRareToJudge: ok.flatMap((r) => r.crawled.report.tooRareToJudge.map((t) => ({ ...t, entry: r.entry.id }))),
    truncated: ok.flatMap((r) => r.crawled.report.truncatedNodes.map((t) => ({ ...t, entry: r.entry.id }))),
    seconds: results.reduce((n, r) => n + r.seconds, 0),
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export const FLAGS = [
  'manifest',
  'out',
  'book',
  'canon-book',
  'only',
  'nodes',
  'trap',
  'mass',
  'max-eval',
  'min-node-games',
  'max-replies',
  'crawl-plies',
  'resume',
  'check',
  'engine',
  'help',
]

/**
 * Rejects flags it does not know, rather than ignoring them.
 *
 * A silently-dropped `--trap 0.01` runs the whole build at the default and
 * reports success — the same shape of failure as every other defect this
 * pipeline has produced, and an hour of engine time to discover.
 */
export function parseArgs(argv, known = FLAGS) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) throw new Error(`unexpected argument "${a}" — every option takes a --flag`)
    const key = a.slice(2)
    if (!known.includes(key)) {
      throw new Error(`unknown option --${key}. Known: ${known.map((k) => `--${k}`).join(' ')}`)
    }
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) out[key] = true
    else {
      out[key] = next
      i++
    }
  }
  return out
}

/**
 * A flag that takes a number, or nothing at all.
 *
 * `parseArgs` marks a valueless flag `true`, and `Number(true)` is 1 — so
 * `--trap --nodes 120000` silently ran the whole build at a trap threshold of
 * 1, found nothing, and reported success. `Number('abc')` is NaN, which reached
 * Stockfish as `go nodes NaN`. Rejecting flags it does not know was only half
 * the job; this is the other half.
 */
export function numberFlag(args, key) {
  const raw = args[key]
  if (raw === undefined) return undefined
  const value = Number(raw)
  if (raw === true || !Number.isFinite(value)) {
    throw new Error(`--${key} needs a number${raw === true ? ' — its value is missing' : `, got "${raw}"`}`)
  }
  return value
}

/** Spread a crawl option only when the flag was given, so defaults still apply. */
const maybe = (key, value) => (value === undefined ? {} : { [key]: value })

/** A flag that takes a string. A bare `--out` made a directory called "true". */
export function stringFlag(args, key) {
  const raw = args[key]
  if (raw === undefined) return undefined
  if (raw === true) throw new Error(`--${key} needs a value`)
  return String(raw)
}

/**
 * The branches `--only` names, or null for all of them.
 *
 * Ids are matched, not counted: comparing list lengths tripped on a repeated id
 * and then reported an empty set of unknown branches.
 */
export function resolveOnly(all, raw) {
  if (raw === undefined) return null
  if (raw === true) throw new Error('--only needs a value')
  const wanted = String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const missing = wanted.filter((id) => !all.some((e) => e.id === id))
  if (missing.length) throw new Error(`--only names unknown branch(es): ${missing.join(', ')}`)
  return all.filter((e) => wanted.includes(e.id))
}

/**
 * Curated prefixes that are not legal chess.
 *
 * `--check` exists so a manifest is validated before an hour of engine time is
 * spent on it, and it happily reported "manifest ok" for a line the crawler
 * cannot play — the run then failed twenty minutes in. Lives here rather than
 * in `validatePlan` because it needs a board, and repertoirePlan.ts stays
 * runtime-import-free.
 */
export function illegalLines(entries) {
  const problems = []
  for (const entry of entries) {
    const board = new Chess()
    const played = []
    for (const san of plies(entry.line)) {
      let move
      try {
        move = board.move(san)
      } catch {
        move = null
      }
      if (!move) {
        problems.push({
          entryId: entry.id,
          message: `illegal move "${san}" after ${played.join(' ') || 'the start'} — check the line`,
        })
        break
      }
      played.push(move.san)
    }
  }
  return problems
}

const HELP = `
Build the whole repertoire from a manifest (issue #88, ADR 0021)

  node scripts/repertoire/build.mjs --book out/band.json --canon-book out/otb.json

  --manifest <path>      branch list          (default: ${basename(DEFAULT_MANIFEST)})
  --out      <dir>       output directory     (default: out/repertoire)
  --book       <path>    OUR BAND: what opponents actually play. Decides theirs.
  --canon-book <path>    MASTERS: what is principled. Decides ours.
  --only     a,b,c       build these branch ids only
  --nodes    400000      engine budget per position
  --trap     0.05        trapValue threshold
  --mass     0.85        opponent coverage target
  --max-eval 20          opponent moves evaluated per node
  --min-node-games 50    stop expanding below this many games in the band book
  --max-replies    6     most opponent moves covered at one node
  --crawl-plies 6        plies each branch crawls past its curated prefix
  --resume               skip branches whose output already exists
  --check                validate the manifest and exit — no engine, no crawling
  --engine   <path>      Stockfish binary
`

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(HELP)
    return
  }

  const manifestPath = stringFlag(args, 'manifest') ?? DEFAULT_MANIFEST
  const all = parseManifest(await readFile(manifestPath, 'utf8'))

  // Validate the *whole* manifest even under --only: the boundaries a branch
  // stops at are a property of the manifest, not of what we chose to run today.
  // Both checks run — a structural one that needs no board, and a legality one
  // that does.
  const problems = [...validatePlan(all), ...illegalLines(all)]
  for (const p of problems) console.error(`error: [${p.entryId}] ${p.message}`)
  if (problems.length) {
    console.error(`\n${problems.length} problem(s) in ${manifestPath} — nothing was crawled.`)
    process.exit(1)
  }
  console.log(`manifest ok: ${all.length} branches, every line legal, no coverage gaps`)
  if (args.check) return

  const outDir = stringFlag(args, 'out') ?? join('out', 'repertoire')
  await mkdir(outDir, { recursive: true })

  let entries = resolveOnly(all, args.only) ?? all

  const deepNodes = numberFlag(args, 'nodes') ?? DEFAULTS.deepNodes
  const crawlDefaults = {
    deepNodes,
    ...maybe('trapThreshold', numberFlag(args, 'trap')),
    ...maybe('massTarget', numberFlag(args, 'mass')),
    ...maybe('maxEvalPerNode', numberFlag(args, 'max-eval')),
    ...maybe('minNodeGames', numberFlag(args, 'min-node-games')),
    ...maybe('maxOpponentMoves', numberFlag(args, 'max-replies')),
    ...maybe('crawlPlies', numberFlag(args, 'crawl-plies')),
  }

  // Branches an earlier run already built. Read back rather than skipped, so
  // the merged PGN and the summary still describe the whole repertoire.
  const reused = []
  if (args.resume) {
    const done = entries.filter((e) => isBuilt(outDir, e))
    for (const e of done) reused.push(await readBranch(outDir, e, crawlDefaults))
    if (done.length) console.log(`resuming: reusing ${done.length} branch(es) already built`)
    entries = entries.filter((e) => !done.includes(e))
  }

  const bookPath = stringFlag(args, 'book')
  const canonPath = stringFlag(args, 'canon-book')
  const enginePath = stringFlag(args, 'engine')
  const explorer = bookPath
    ? await createLocalBook({ path: bookPath })
    : createExplorer({ cacheDir: join(outDir, '.explorer-cache') })
  const canon = canonPath ? await createLocalBook({ path: canonPath }) : null
  const engine = createEngine({ path: enginePath })
  const date = new Date().toISOString().slice(0, 10)
  const started = Date.now()
  console.log(`building ${entries.length} branch(es) at ${deepNodes.toLocaleString()} nodes → ${outDir}\n`)

  try {
    const results = await buildAll({
      entries,
      // The full manifest decides the boundaries, so --only still produces
      // branches that agree with the ones it skipped.
      plan: all,
      engine,
      explorer,
      canon,
      defaults: crawlDefaults,
      date,
      provenance: {
        engine: basename(enginePath ?? DEFAULT_ENGINE_PATH),
        nodes: deepNodes,
        threads: 1,
      },
      // Written as each branch lands, not at the end. A run long enough to want
      // --resume is long enough to be interrupted, and output that only appears
      // after the last branch gives --resume nothing to resume from.
      onEntry: async (r) => {
        if (r.error) {
          console.log(`✗ ${r.entry.id.padEnd(20)} FAILED: ${r.error.message}`)
          return
        }
        const traps = r.crawled.report.traps.length
        console.log(
          `✓ ${r.entry.id.padEnd(20)} ${String(r.crawled.nodes.size).padStart(4)} positions · ` +
            `${String(r.load.ourDecisions).padStart(3)} to know · ${r.load.quietTargets} quiet · ` +
            `${traps} trap${traps === 1 ? '' : 's'} · ${r.seconds.toFixed(0)}s`,
        )
        await writeBranch(outDir, r)
      },
    })

    // In manifest order, so the file reads the same whether it was built in one
    // pass or resumed across several.
    const order = new Map(all.map((e, i) => [e.id, i]))
    const complete = [...reused, ...results].sort(
      (a, b) => (order.get(a.entry.id) ?? 0) - (order.get(b.entry.id) ?? 0),
    )
    // One file per side is what actually gets imported: En Croissant trains
    // from one colour's point of view, so a mixed file is usable as neither.
    // The combined file is written too, for reading the whole thing at once.
    const usable = complete.filter((r) => !r.error)
    const { white, black } = splitByColour(usable)
    await writeFile(join(outDir, 'repertoire-white.pgn'), white, 'utf8')
    await writeFile(join(outDir, 'repertoire-black.pgn'), black, 'utf8')
    await writeFile(join(outDir, 'repertoire.pgn'), mergePgn(usable.map((r) => r.pgn)), 'utf8')

    const summary = summarise(complete)
    await writeFile(
      join(outDir, 'summary.json'),
      JSON.stringify(
        {
          generated: new Date().toISOString(),
          manifest: manifestPath,
          nodes: deepNodes,
          trapThreshold: crawlDefaults.trapThreshold ?? DEFAULTS.trapThreshold,
          band: explorer.stats(),
          canon: canon?.stats() ?? null,
          ...summary,
        },
        null,
        2,
      ),
      'utf8',
    )

    console.log(`
── built in ${((Date.now() - started) / 1000).toFixed(0)}s ─────────────────────
positions       ${summary.positions}
to memorise     ${summary.load.ourDecisions} decisions of ours, answering ${summary.load.preparedReplies} of theirs
quiet targets   ${summary.load.quietTargets}
engine searches ${engine.searchCount()}`)

    if (summary.traps.length) {
      console.log('\ntop traps across the repertoire (frequency × swing × outperformance):')
      for (const t of summary.traps.slice(0, 15)) {
        console.log(
          `  ${t.trapValue.toFixed(4)}  ${t.line}` +
            `   [${(t.frequency * 100).toFixed(1)}% of games, −${t.swing} win%, ` +
            `scores ${(t.practical * 100).toFixed(0)}% vs ${(t.expected * 100).toFixed(0)}% deserved, n=${t.games}]`,
        )
      }
    }
    if (summary.unpunished.length) {
      console.log(`\n⚠ ${summary.unpunished.length} trap(s) we could not actually punish:`)
      for (const t of summary.unpunished) console.log(`  ${t.line}   [only ${t.afterReplyWinPercent}% after our reply]`)
    }
    if (summary.unverified.length) {
      console.log(`\n? ${summary.unverified.length} trap(s) whose punishment was not verified:`)
      for (const t of summary.unverified) console.log(`  ${t.line}   [${t.why}]`)
    }
    if (summary.emptyBranches.length) {
      console.log(`\n⚠ ${summary.emptyBranches.length} branch(es) covered nothing of their own:`)
      for (const b of summary.emptyBranches) {
        console.log(
          `  ${b.id}   [${b.positions} positions, ${b.delegated} handed to other branches — ` +
            `raise its massTarget or drop it]`,
        )
      }
    }
    if (summary.load.outOfBook) {
      console.log(`\n${summary.load.outOfBook} line(s) ran out of book before going quiet — the book is thin there, not the position unplayable.`)
    }
    if (summary.failed.length) {
      console.error(`\n✗ ${summary.failed.length} branch(es) failed:`)
      for (const f of summary.failed) console.error(`  ${f.id}: ${f.error}`)
    }

    const branchCount = (pgn) => (pgn ? pgn.split(/\n\s*\n(?=\[Event )/).filter((g) => g.trim()).length : 0)
    const whiteN = branchCount(white)
    const blackN = branchCount(black)
    console.log(
      `\nwrote ${resolve(outDir)}` +
        `${reused.length ? ` (${reused.length} branch(es) reused from an earlier run)` : ''}\n` +
        `  repertoire-white.pgn   ${whiteN} branches — import this as your White repertoire\n` +
        `  repertoire-black.pgn   ${blackN} branches — and this as your Black one\n` +
        `  repertoire.pgn         all ${whiteN + blackN}, for reading rather than importing`,
    )
    if (summary.failed.length || summary.unparseable.length || summary.unwritten.length) process.exitCode = 1
  } finally {
    await engine.quit()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
