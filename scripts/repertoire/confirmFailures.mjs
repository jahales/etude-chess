// Re-check the audit's failures with the local engine, in one search each.
//
//   node scripts/repertoire/confirmFailures.mjs --audit out/audit-106.json --nodes 50000000
//
// Why this exists. `auditRepertoire` scores most moves by looking up the
// position *after* them and negating, because the dump's stored multi-PV list
// is only five moves wide. That pair of numbers comes from two different
// searches at two different depths, so a small swing near the 5 win% gate can
// be depth disagreement rather than a real concession — and the failures land
// exactly there, at depths 26-37 against a median of 50.
//
// A single MultiPV search settles it: our move and the best move are then
// scored by one engine, at one depth, in one search, and subtract cleanly.
// Single-threaded, fixed nodes, per engine.mjs's reproducibility rules.

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { SOUNDNESS_MAX_SWING } from '../../src/domain/repertoire.ts'
import { tierForSwing } from '../../src/domain/grade.ts'
import { winPercent } from '../../src/domain/winPercent.ts'
import { createEngine } from './engine.mjs'
import { parseArgs, numberFlag, stringFlag } from './build.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..')

/**
 * Score one decision against the engine's own best, from a single search.
 * @returns {{swing: number, tier: string, sound: boolean, bestUci: string, depth: number}|{error: string}}
 */
export async function confirmOne(engine, decision, { nodes, multipv }) {
  const r = await engine.analyse(decision.fen, { nodes, multipv })
  if (!r.lines.length) return { error: 'engine returned no lines' }

  const best = r.lines[0]
  const mine = r.lines.find((l) => l.pv[0] === decision.uci)
  if (!mine) {
    // Outside the engine's own top-N at this budget. That is itself evidence
    // against the move, but it is not a measurement, so say so rather than
    // inventing a swing.
    return { error: `our move is outside the engine's top ${multipv}`, bestUci: best.pv[0], depth: r.depth }
  }

  const swing = Math.max(0, winPercent(best.score) - winPercent(mine.score))
  return {
    swing,
    tier: tierForSwing(swing),
    sound: swing <= SOUNDNESS_MAX_SWING,
    bestUci: best.pv[0],
    ourScore: mine.score,
    bestScore: best.score,
    depth: r.depth,
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2), ['audit', 'nodes', 'multipv', 'engine', 'out'])
  const auditPath = stringFlag(args, 'audit') ?? join(repoRoot, 'out', 'audit-106.json')
  const nodes = numberFlag(args, 'nodes') ?? 50_000_000
  const multipv = numberFlag(args, 'multipv') ?? 12
  const outPath = stringFlag(args, 'out') ?? join(repoRoot, 'out', 'audit-106-confirmed.json')

  const audit = JSON.parse(readFileSync(auditPath, 'utf8'))
  const failures = audit.decks.flatMap((d) => d.failures.map((f) => ({ ...f, deck: d.deck })))

  process.stdout.write(
    `confirming ${failures.length} failure(s) at ${(nodes / 1e6).toFixed(0)}M nodes, multipv ${multipv}\n` +
      `single-threaded and fixed-node, so the numbers are reproducible\n\n`,
  )

  const engine = createEngine({ path: stringFlag(args, 'engine') })
  const results = []
  for (const f of failures) {
    const started = Date.now()
    const c = await confirmOne(engine, f, { nodes, multipv })
    const secs = ((Date.now() - started) / 1000).toFixed(0)

    if (c.error) {
      process.stdout.write(`  ?  ${f.line}\n     ${c.error} (d${c.depth ?? '?'}, ${secs}s)\n`)
    } else {
      const verdict = c.sound ? 'CLEARED' : 'CONFIRMED'
      process.stdout.write(
        `  ${c.sound ? '✓' : '✗'} ${verdict.padEnd(9)} dump said ${f.swing.toFixed(1)} (d${f.depth}) · ` +
          `engine says ${c.swing.toFixed(1)} win% (d${c.depth}, ${secs}s)\n     ${f.line}` +
          `${c.bestUci === f.uci ? '' : `   engine prefers ${c.bestUci}`}\n`,
      )
    }
    results.push({ ...f, confirmed: c })
  }
  await engine.quit?.()

  const measured = results.filter((r) => !r.confirmed.error)
  const stillBad = measured.filter((r) => !r.confirmed.sound)
  process.stdout.write(
    `\nof ${failures.length} flagged: ${stillBad.length} confirmed, ` +
      `${measured.length - stillBad.length} cleared as depth noise, ` +
      `${failures.length - measured.length} unmeasured\n`,
  )

  writeFileSync(
    outPath,
    JSON.stringify({ generated: new Date().toISOString(), nodes, multipv, results }, null, 2),
  )
  process.stdout.write(`\nfull detail: ${outPath}\n`)
}

// Windows gives `file:///C:/…` from import.meta.url but argv[1] is a plain path,
// so compare through pathToFileURL — as build.mjs, crawl.mjs and buildBook.mjs do.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
