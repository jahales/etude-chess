// Re-grade every move the shipped repertoire prescribes, against the local
// evaluation index instead of the search that chose it — issue #106.
//
//   node scripts/repertoire/auditRepertoire.mjs --index db/eval-index
//
// ## What is being tested
//
// `crawl.mjs` rejects a candidate whose win% is more than SOUNDNESS_MAX_SWING
// (5) below the engine's best. v1 ran that gate at **120,000 nodes** — not the
// 400k default #106 argues against, and roughly depth 15. The dump's median
// depth is 50. So the question is simply: how many of the moves that passed at
// 120k still pass at 50?
//
// ## How our move is scored, and why two ways
//
// `multipv` — our move appears in the position's own multi-PV list. Both numbers
//   then come from one search at one depth and subtract cleanly. Preferred.
// `after`   — it does not, so we look up the position *after* our move and
//   negate. This is the payoff of holding the database locally: #106's proposed
//   API method compares against `multiPv=5` and silently loses any prescribed
//   move outside the top five, which is exactly where the bad ones would be.
//   The caveat is that the two numbers come from different searches at
//   different depths, so a small difference is noise — which is why the tier
//   boundaries, not the raw swing, are what the report leans on.
//
// Every decision records which method scored it, the way `bookSource` already
// records where its candidates came from.

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { SOUNDNESS_MAX_SWING } from '../../src/domain/repertoire.ts'
import { tierForSwing } from '../../src/domain/grade.ts'
import { winPercent } from '../../src/domain/winPercent.ts'
import { createEvalDb } from './evalDb.mjs'
import { MIN_INDEX_DEPTH } from './soundness.mjs'
import { ourDecisions } from './readRepertoirePgn.mjs'
import { parseArgs, stringFlag } from './args.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..')

/**
 * The three decks are separate repertoires, not one.
 *
 * 1.d4 and 1.e4 are alternatives — deduplicating across them would report the
 * start position as a contradiction 12 times over. Each file is audited in its
 * own namespace.
 */
export const DECKS = [
  { id: 'white', file: 'repertoire/v2/etude-white-complete.pgn' },
  { id: 'black', file: 'repertoire/v2/etude-black-complete.pgn' },
]

const negate = (s) => ({ type: s.type, value: -s.value })

/**
 * Grade one decision against the index.
 *
 * @param {{fen: string, fenAfter: string, uci: string}} decision
 * @param {{query: (fen: string) => object|null}} db
 */
export function gradeDecision(decision, db, minDepth = MIN_INDEX_DEPTH) {
  const usable = (r) =>
    r?.lines?.length ? (r.depth >= minDepth ? r : { tooShallow: r.depth }) : null

  const before = usable(db.query(decision.fen))
  if (!before) return { covered: false, reason: 'position not in index' }
  if (before.tooShallow) {
    // The same floor the crawl gate applies. Without it a depth-8 entry — and
    // the dump is full of them, since every casual cloud-eval request is
    // recorded — is graded as authoritative against a median of 50, and
    // reported with a depth nothing rejects.
    return { covered: false, reason: `indexed only to depth ${before.tooShallow}` }
  }

  const best = before.lines[0]
  const bestWp = winPercent(best.score)

  // chess.js gives `lan` as e2e4 / a7a8q, the same shape the index stores.
  const mine = before.lines.find((l) => l.pv[0] === decision.uci)
  if (mine) {
    const swing = Math.max(0, bestWp - winPercent(mine.score))
    return {
      covered: true,
      method: 'multipv',
      depth: before.depth,
      knodes: before.knodes,
      bestUci: best.pv[0],
      bestScore: best.score,
      ourScore: mine.score,
      swing,
      tier: tierForSwing(swing),
      sound: swing <= SOUNDNESS_MAX_SWING,
    }
  }

  const after = usable(db.query(decision.fenAfter))
  if (!after || after.tooShallow) {
    return {
      covered: false,
      reason: after?.tooShallow
        ? `our move is outside the stored pvs and the position after it is indexed only to depth ${after.tooShallow}`
        : 'our move is outside the stored pvs and the position after it is not in the index',
      depth: before.depth,
      bestUci: best.pv[0],
    }
  }

  // `after` is scored from the replier's side; ours is the negation.
  const ourScore = negate(after.lines[0].score)
  const swing = Math.max(0, bestWp - winPercent(ourScore))
  return {
    covered: true,
    method: 'after',
    depth: Math.min(before.depth, after.depth),
    knodes: Math.min(before.knodes, after.knodes),
    bestUci: best.pv[0],
    bestScore: best.score,
    ourScore,
    swing,
    tier: tierForSwing(swing),
    sound: swing <= SOUNDNESS_MAX_SWING,
  }
}

/** Audit one deck. */
export function auditDeck(deck, db, root = repoRoot) {
  const text = readFileSync(join(root, deck.file), 'utf8')
  const { decisions, conflicts } = ourDecisions(text)

  const graded = decisions.map((d) => ({
    branch: d.branch,
    line: d.line.join(' '),
    ply: d.ply,
    san: d.san,
    uci: d.uci,
    fen: d.fen,
    ...gradeDecision(d, db),
  }))

  const covered = graded.filter((g) => g.covered)
  const failures = covered.filter((g) => !g.sound).sort((a, b) => b.swing - a.swing)
  const depths = covered.map((g) => g.depth).sort((a, b) => a - b)

  return {
    deck: deck.id,
    file: deck.file,
    decisions: graded.length,
    covered: covered.length,
    gaps: graded.filter((g) => !g.covered),
    conflicts: conflicts.map((c) => ({
      line: c.a.line.join(' '),
      a: c.a.san,
      b: c.b.san,
      // Carried through, not dropped — the report filters on it (issue #114).
      root: c.root,
    })),
    byMethod: {
      multipv: covered.filter((g) => g.method === 'multipv').length,
      after: covered.filter((g) => g.method === 'after').length,
    },
    tiers: {
      A: covered.filter((g) => g.tier === 'A').length,
      B: covered.filter((g) => g.tier === 'B').length,
      C: covered.filter((g) => g.tier === 'C').length,
    },
    depth: {
      min: depths[0] ?? 0,
      median: depths[Math.floor(depths.length / 2)] ?? 0,
      max: depths[depths.length - 1] ?? 0,
    },
    failures,
    graded,
  }
}

const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(1)}%` : '—')

function report(results) {
  const out = []
  const total = (k) => results.reduce((s, r) => s + (typeof k === 'function' ? k(r) : r[k]), 0)

  out.push('')
  out.push(`gate: a move is unsound if it gives up more than ${SOUNDNESS_MAX_SWING} win% vs the best`)
  out.push('')
  out.push(
    'deck        decisions  covered   depth(med)   sound   concession(B)   mistake(C)',
  )
  for (const r of results) {
    const bad = r.tiers.B + r.tiers.C
    out.push(
      `${r.deck.padEnd(12)}${String(r.decisions).padStart(8)}` +
        `${String(r.covered).padStart(9)}${String(r.depth.median).padStart(12)}` +
        `${String(r.tiers.A).padStart(9)}${String(r.tiers.B).padStart(15)}` +
        `${String(r.tiers.C).padStart(13)}   ${pct(bad, r.covered)} fail`,
    )
  }

  const decisions = total('decisions')
  const covered = total('covered')
  const failures = total((r) => r.failures.length)
  out.push('')
  out.push(
    `TOTAL       ${String(decisions).padStart(8)}${String(covered).padStart(9)} ` +
      `(${pct(covered, decisions)} of prescribed moves found in the dump)`,
  )
  out.push(
    `scored by multi-pv ${total((r) => r.byMethod.multipv)} · ` +
      `by the position after our move ${total((r) => r.byMethod.after)}`,
  )
  out.push('')
  out.push(`FAIL the 5 win% gate: ${failures} of ${covered} (${pct(failures, covered)})`)

  for (const r of results) {
    if (!r.failures.length) continue
    out.push('')
    out.push(`── ${r.deck} — worst first ${'─'.repeat(40)}`)
    for (const f of r.failures.slice(0, 25)) {
      const best = f.bestUci === f.uci ? '' : `  engine prefers ${f.bestUci}`
      out.push(
        `  ${f.swing.toFixed(1).padStart(5)} win%  tier ${f.tier}  d${String(f.depth).padStart(2)}  ` +
          `[${f.branch.replace(/^Repertoire — /, '')}]`,
      )
      out.push(`         ${f.line}${best}   (${f.method})`)
    }
    if (r.failures.length > 25) out.push(`  … and ${r.failures.length - 25} more`)
  }

  const gaps = results.flatMap((r) => r.gaps)
  if (gaps.length) {
    out.push('')
    out.push(`not in the dump: ${gaps.length}`)
    for (const g of gaps.slice(0, 15)) out.push(`  ${g.line}   — ${g.reason}`)
    if (gaps.length > 15) out.push(`  … and ${gaps.length - 15} more`)
  }

  // Root alternatives are excluded, not counted: 1.d4 and 1.e4 are two
  // repertoires you pick between at the board, so a White deck holding both is
  // the design working. This guard used to be "one namespace per file", which
  // was right until #109 merged both first moves into one White file — after
  // which every audit ended on a warning that always meant nothing, which is
  // how a reader learns to skip the line that would matter (issue #114).
  const all = results.flatMap((r) => r.conflicts)
  const conflicts = all.filter((c) => !c.root)
  const roots = all.length - conflicts.length
  out.push('')
  out.push(
    conflicts.length
      ? `⚠ ${conflicts.length} position(s) answered two different ways within one deck`
      : 'no position is answered two different ways within a deck — branch ownership holds',
  )
  if (roots) out.push(`  (${roots} first-move alternative(s) not counted — a deck may offer both)`)

  return out.join('\n')
}

async function main() {
  const args = parseArgs(process.argv.slice(2), ['index', 'out'])
  const indexDir = stringFlag(args, 'index') ?? join(repoRoot, 'db', 'eval-index')
  const outPath = stringFlag(args, 'out') ?? join(repoRoot, 'out', 'audit-106.json')

  const db = createEvalDb({ dir: indexDir })
  process.stdout.write(
    `auditing against ${indexDir}\n` +
      `index holds ${Number(db.manifest.records).toLocaleString()} positions` +
      `${db.manifest.limited ? ' (PARTIAL — built with --limit)' : ''}\n`,
  )

  const results = DECKS.map((d) => auditDeck(d, db))
  process.stdout.write(report(results) + '\n')

  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        generated: new Date().toISOString(),
        index: { dir: indexDir, records: db.manifest.records, built: db.manifest.built },
        gate: SOUNDNESS_MAX_SWING,
        decks: results,
      },
      null,
      2,
    ),
  )
  process.stdout.write(`\nfull detail: ${outPath}\n`)
  db.close()
}

// Windows gives `file:///C:/…` from import.meta.url but argv[1] is a plain path,
// so compare through pathToFileURL — as build.mjs, crawl.mjs and buildBook.mjs do.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
