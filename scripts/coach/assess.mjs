// Rank your weaknesses across the archive scripts/coach/archive.mjs graded.
//
//   npm run coach
//   npm run coach -- --in out/coach/archive.jsonl --time-class rapid
//
// An I/O shell with no opinions: read the JSON-lines, hand them to
// src/domain/coachReport.ts, print what comes back. Every threshold, bucket
// boundary and refusal is in that module, where it is unit-tested — including
// the one that matters most, `pieceMatchBaseline`, which is the difference
// between a finding and a coincidence.
//
// Read the output with .claude/skills/coach/SKILL.md open. The report is
// deliberately not self-interpreting: several of these tables have an obvious
// reading that is wrong, and the skill is where that is written down.

import { readFileSync } from 'node:fs'
import {
  byColor,
  byPhase,
  byPieceMoved,
  byPieces,
  byBestForcing,
  byTimeClass,
  bucketsBy,
  describeSample,
  pieceMatchBaseline,
  thinkTime,
  MIN_GAMES_FOR_PATTERN,
  MIN_MOVES_FOR_RATE,
} from '../../src/domain/coachReport.ts'

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}

const IN = arg('in', 'out/coach/archive.jsonl')
const ONLY = arg('time-class')
const PHASE = arg('phase') // restrict the base-rate check, e.g. --phase middlegame

let text
try {
  text = readFileSync(IN, 'utf8')
} catch {
  console.error(`No archive at ${IN}. Build one first:\n  node scripts/coach/archive.mjs --me <user> --limit 5`)
  process.exit(2)
}

/**
 * Flatten game rows to move rows, folding the game-level facts onto each move.
 * A torn last line from an interrupted archive run is dropped, same as the
 * archive script's own resume does.
 */
const games = []
for (const line of text.split('\n')) {
  if (!line.trim()) continue
  try {
    games.push(JSON.parse(line))
  } catch {
    console.error('  (skipping one unparseable line — an interrupted archive run)')
  }
}

const all = games.flatMap((g) =>
  g.moves.map((m) => ({
    ...m,
    gameId: g.gameId,
    timeClass: g.timeClass,
    color: g.color,
    result: g.result,
    eco: g.eco ?? null,
  })),
)
if (!all.length) {
  console.error(`${IN} has no graded moves in it.`)
  process.exit(2)
}

// --- printing ---------------------------------------------------------------
const pct = (v, places = 0) => (v == null ? '   —' : `${(100 * v).toFixed(places)}%`)
const num = (v, places = 1) => (v == null ? '—' : v.toFixed(places))
const plural = (n, one, more = `${one}s`) => `${n} ${n === 1 ? one : more}`

function table(title, ranking, note) {
  console.log(`\n  ${title}`)
  if (note) console.log(`    ${note}`)
  console.log(
    `    ${'bucket'.padEnd(16)} ${'moves'.padStart(6)} ${'errors'.padStart(7)} ${'rate'.padStart(6)} ` +
      `${'win% lost'.padStart(10)} ${'share'.padStart(6)} ${'of moves'.padStart(9)} ${'per move'.padStart(9)}`,
  )
  for (const b of ranking.buckets) {
    console.log(
      `    ${b.label.padEnd(16)} ${String(b.moves).padStart(6)} ${String(b.errors).padStart(7)} ` +
        `${pct(b.errorRate).padStart(6)} ${num(b.winPercentLost, 0).padStart(10)} ${pct(b.share).padStart(6)} ` +
        `${pct(b.moveShare).padStart(9)} ${num(b.perMove, 2).padStart(9)}` +
        `${b.thin ? '   thin' : ''}`,
    )
  }
}

const classes = byTimeClass(all).filter((c) => !ONLY || c.timeClass === ONLY)
if (!classes.length) {
  console.error(`No ${ONLY} games in ${IN}. It holds: ${byTimeClass(all).map((c) => c.timeClass).join(', ')}`)
  process.exit(2)
}

console.log(`\ncoach report over ${IN}`)
console.log(
  `${plural(classes.length, 'time class', 'time classes')} to report. Classes are reported SEPARATELY\n` +
    'and never pooled: a blitz-weighted ranking describes the player you were, not\n' +
    'the one you are (coach skill, rule 1).',
)

for (const { timeClass, moves } of classes) {
  const sample = describeSample(moves)
  console.log(
    `\n\n${'='.repeat(78)}\n  ${timeClass.toUpperCase()} — ${plural(sample.games, 'game')}, ` +
      `${plural(sample.moves, 'move')} of yours\n${'='.repeat(78)}`,
  )
  console.log(
    `  ${num(sample.winPercentLost, 0)} win% given away in total · ` +
      `${plural(sample.unclocked, 'move')} with no clock reading`,
  )
  if (sample.thin) {
    console.log(
      `  *** ${plural(sample.games, 'game')} is under ${MIN_GAMES_FOR_PATTERN}. Read this as a description\n` +
        '      of these games, not as a pattern to train against — see the skill, rule 5.',
    )
  }
  console.log(
    `  Buckets under ${MIN_MOVES_FOR_RATE} moves are marked "thin": their rate is noise wearing a percent sign.`,
  )

  table('by phase', bucketsBy(moves, byPhase))
  table(
    "by whether the ENGINE's move was forcing",
    bucketsBy(moves, byBestForcing),
    'a capture or a check, in the position you faced — not what you played',
  )
  table('by piece you moved', bucketsBy(moves, byPieceMoved), 'p b n r q k')
  table('by pieces on the board', bucketsBy(moves, byPieces))
  table('by colour', bucketsBy(moves, byColor))

  // Clock order, not ranked. The shape is the whole content of this one, and
  // sorting it by cost would destroy it.
  const clock = thinkTime(moves)
  console.log('\n  by seconds spent   (clock order, NOT ranked)')
  console.log(
    `    ${'band'.padEnd(16)} ${'moves'.padStart(6)} ${'errors'.padStart(7)} ${'rate'.padStart(6)} ` +
      `${'win% lost'.padStart(10)} ${'per move'.padStart(9)}`,
  )
  for (const b of clock.bands) {
    console.log(
      `    ${b.label.padEnd(16)} ${String(b.moves).padStart(6)} ${String(b.errors).padStart(7)} ` +
        `${pct(b.errorRate).padStart(6)} ${num(b.winPercentLost, 0).padStart(10)} ${num(b.perMove, 2).padStart(9)}` +
        `${b.thin ? '   thin' : ''}`,
    )
  }
  if (clock.risesWithTime) console.log('\n    error rate rises with every band.')
  console.log(`\n    ${clock.caveat.replace(/(.{72}) /g, '$1\n    ')}`)

  // --- the base-rate check --------------------------------------------------
  const errors = moves.filter((m) => m.tier !== 'A' && (!PHASE || m.phase === PHASE))
  const base = pieceMatchBaseline(errors)
  console.log(`\n\n  did you move the engine's piece?   ${PHASE ? `${PHASE} ` : ''}errors only, n=${base.n}`)
  console.log(`    you did on          ${pct(base.observedRate, 1)}  (${base.observed} of ${base.n})`)
  console.log(
    `    blind guessing does ${pct(base.expectedRate, 1)}  ` +
      `(${num(base.meanLegalMoves)} legal moves across ${num(base.meanMovablePieces)} movable pieces)`,
  )
  console.log(`    ${base.z == null ? '' : `${base.z >= 0 ? '+' : ''}${num(base.z, 1)} SD · `}${base.verdict.toUpperCase()}`)
  console.log(
    '\n    This is the check that killed the finding this whole script exists for.\n' +
      '    "82% of his errors moved the wrong piece" was drafted as a coaching\n' +
      '    conclusion before anyone computed what chance alone would do. Read the\n' +
      '    skill before quoting this line either way — and note that\n' +
      '    "indistinguishable" means this sample cannot tell, not that nothing is there.',
  )
}

console.log(
  '\n\nWhat this cannot tell you: whether a move was missed or considered-and-misjudged.\n' +
    'A swing table cannot separate them; that needs the reason you stated before the\n' +
    'reveal (#49), not more engine depth. Say which of the two you cannot rule out.\n',
)
