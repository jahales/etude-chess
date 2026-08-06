// Cross-month replication for the trap list (issue #88).
//
// The single most important check we can run on a trap. `trapValue` is a
// statistic over noisy human data, and a sample-size floor only bounds how
// badly one month can fool us — it cannot tell us whether a finding is *real*.
// Replication can: run the same crawl against a book built from a different
// month and keep what survives both.
//
// This is constitution §9's held-out set applied to the generator itself. The
// alternative — validating the output against a list somebody wrote by hand —
// mostly measures how good the list was.
//
//   node scripts/repertoire/replicate.mjs out/qg-jun.json out/qg-may.json
//
// Takes the crawl JSON from two runs, not two books, so the two runs can differ
// in whatever way you like as long as the lines are comparable.

import { readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

/** Retained when a trap's value holds within this factor across both runs. */
export const AGREEMENT_FACTOR = 4

/**
 * Compare two trap lists by line.
 *
 * A trap is `replicated` when both months found it; `contradicted` when one
 * found it and the other looked at the same line and did not; and `unseen`
 * when the other run never evaluated that line at all — which is a coverage
 * gap, not evidence either way, and is reported separately so it cannot be
 * mistaken for a refutation.
 */
export function compareTraps(runA, runB) {
  const trapsA = new Map((runA.report?.traps ?? []).map((t) => [t.line, t]))
  const trapsB = new Map((runB.report?.traps ?? []).map((t) => [t.line, t]))

  // A trap's line ends with the trap move, so its *parent* is what run B had to
  // have expanded in order to have an opinion. Matching on the trap line itself
  // would be wrong: B only stores nodes for moves it selected, so a move B
  // evaluated and rejected has no node — and would be misread as "never looked
  // at" when it is in fact a refutation, which is the opposite conclusion.
  const expandedB = new Set(
    Object.values(runB.nodes ?? {})
      .filter((n) => (n.children ?? []).length > 0)
      .map((n) => (n.line ?? []).join(' ')),
  )
  const parentOf = (line) => line.split(' ').slice(0, -1).join(' ')

  const replicated = []
  const contradicted = []
  const unseen = []

  for (const [line, a] of trapsA) {
    const b = trapsB.get(line)
    if (b) {
      const ratio = a.trapValue === 0 || b.trapValue === 0 ? 0 : a.trapValue / b.trapValue
      replicated.push({
        line,
        a: a.trapValue,
        b: b.trapValue,
        games: a.games + b.games,
        // Agreement in *magnitude*, not just presence — a trap worth 0.3 in one
        // month and 0.004 in the other is not the same finding twice.
        stable: ratio >= 1 / AGREEMENT_FACTOR && ratio <= AGREEMENT_FACTOR,
      })
    } else if (expandedB.has(parentOf(line))) {
      contradicted.push({ line, a: a.trapValue, games: a.games })
    } else {
      unseen.push({ line, a: a.trapValue, games: a.games })
    }
  }

  replicated.sort((x, y) => Math.min(y.a, y.b) - Math.min(x.a, x.b))
  return { replicated, contradicted, unseen }
}

async function main() {
  const [pathA, pathB, out] = process.argv.slice(2)
  if (!pathA || !pathB) {
    console.log(
      'usage: node scripts/repertoire/replicate.mjs <runA.json> <runB.json> [merged.json]\n' +
        '\nRuns the same comparison both ways and keeps only what both months agree on.',
    )
    process.exit(1)
  }

  const [runA, runB] = await Promise.all([
    readFile(pathA, 'utf8').then(JSON.parse),
    readFile(pathB, 'utf8').then(JSON.parse),
  ])

  const forward = compareTraps(runA, runB)
  const reverse = compareTraps(runB, runA)

  const confirmed = forward.replicated.filter((r) => r.stable)
  const shaky = forward.replicated.filter((r) => !r.stable)

  console.log(`\nA: ${pathA}  (${(runA.report?.traps ?? []).length} traps)`)
  console.log(`B: ${pathB}  (${(runB.report?.traps ?? []).length} traps)\n`)

  console.log(`✓ replicated in both, consistent magnitude — ${confirmed.length}`)
  for (const r of confirmed) {
    console.log(`    ${r.line}   [${r.a.toFixed(4)} vs ${r.b.toFixed(4)}, n=${r.games} combined]`)
  }

  if (shaky.length) {
    console.log(`\n~ found in both but the value moved by more than ${AGREEMENT_FACTOR}× — ${shaky.length}`)
    for (const r of shaky) console.log(`    ${r.line}   [${r.a.toFixed(4)} vs ${r.b.toFixed(4)}]`)
  }

  if (forward.contradicted.length || reverse.contradicted.length) {
    const all = [...forward.contradicted, ...reverse.contradicted]
    console.log(`\n✖ found by one month, examined and rejected by the other — ${all.length}`)
    for (const r of all.slice(0, 10)) console.log(`    ${r.line}   [${r.a.toFixed(4)}, n=${r.games}]`)
  }

  if (forward.unseen.length || reverse.unseen.length) {
    const all = [...forward.unseen, ...reverse.unseen]
    console.log(`\n? never reached by the other run — ${all.length} (coverage gap, not a refutation)`)
    for (const r of all.slice(0, 10)) console.log(`    ${r.line}   [${r.a.toFixed(4)}, n=${r.games}]`)
  }

  const total = (runA.report?.traps ?? []).length
  console.log(
    `\n${confirmed.length} of ${total} traps from A survive replication` +
      (total ? ` (${((100 * confirmed.length) / total).toFixed(0)}%)` : ''),
  )

  if (out) {
    await writeFile(out, JSON.stringify({ confirmed, shaky, ...forward }, null, 2), 'utf8')
    console.log(`wrote ${out}`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
