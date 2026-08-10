// Assert that the evaluation index is actually right.
//
//   node scripts/repertoire/verifyEvalDb.mjs [--index db/eval-index] [--deep]
//
// The sibling of verifyBook.mjs, and it exists for the same reason: of the
// defects found building that pipeline, none were caught by unit tests and
// every one produced a plausible-looking artifact rather than an error. An
// index built from a truncated download, or keyed with the wrong FEN
// convention, answers "not in the database" for everything and looks exactly
// like a database that happens not to cover your positions.
//
// So the checks here are against the data, not the logic. Exits non-zero on a
// failure so it can gate a pipeline.

import { readFileSync, statSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Chess } from 'chess.js'
import { BUCKETS, RECORD_BYTES, bucketPath, compareKeys } from './evalKey.mjs'
import { createEvalDb } from './evalDb.mjs'
import { ourDecisions } from './readRepertoirePgn.mjs'
import { winPercent } from '../../src/domain/winPercent.ts'
import { parseArgs, stringFlag } from './build.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..')

const fenAfter = (sans) => {
  const c = new Chess()
  for (const s of sans) c.move(s)
  return c.fen()
}

/**
 * Positions every real evaluation database contains, with what a correct index
 * must say about them. Scores are checked from the mover's point of view, which
 * is what `query` returns.
 */
const KNOWN = [
  { name: 'starting position', sans: [], min: -20, max: 80 },
  { name: 'after 1.e4', sans: ['e4'], min: -80, max: 20 },
  { name: 'after 1.d4', sans: ['d4'], min: -80, max: 20 },
  { name: 'Ruy Lopez, 3.Bb5', sans: ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5'], min: -90, max: 20 },
  { name: 'Italian, 3.Bc4', sans: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4'], min: -90, max: 20 },
  { name: 'Sicilian, 2.Nf3', sans: ['e4', 'c5', 'Nf3'], min: -90, max: 20 },
  { name: 'QGD, 3.Nc3', sans: ['d4', 'd5', 'c4', 'e6', 'Nc3'], min: -90, max: 20 },
  { name: 'French, 2.d4', sans: ['e4', 'e6', 'd4'], min: -90, max: 20 },
  { name: 'Caro-Kann, 2.d4', sans: ['e4', 'c6', 'd4'], min: -90, max: 20 },
  { name: 'Scandinavian, 2.exd5', sans: ['e4', 'd5', 'exd5'], min: -110, max: 10 },
]

/**
 * Positions whose evaluation is not a matter of taste, with the direction
 * stated per position rather than assumed.
 *
 * Both directions are represented deliberately. An earlier version of this
 * check asserted "the mover is worse" across the board and failed on three
 * correct answers, because in each of them the side to move was the side
 * *winning* — the check was wrong, not the index. Testing only one direction
 * would also pass a build that clamped every score to the same sign.
 */
const DECIDED = [
  {
    name: "Scholar's mate, White mates next",
    sans: ['e4', 'e5', 'Bc4', 'Nc6', 'Qh5', 'Nf6'],
    min: 90,
  },
  {
    name: 'Damiano, Black to move and lost',
    sans: ['e4', 'e5', 'Nf3', 'f6', 'Nxe5', 'fxe5', 'Qh5+'],
    max: 30,
  },
  {
    name: 'Fried Liver accepted, White to move and better',
    sans: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Nf6', 'Ng5', 'd5', 'exd5', 'Nxd5', 'Nxf7', 'Kxf7'],
    min: 55,
  },
  {
    name: 'Englund Gambit, Black to move and worse',
    sans: ['d4', 'e5', 'dxe5'],
    max: 45,
  },
  {
    // Six plies, so it is *White* to move — a queen down for a pawn. Mind the
    // parity: naming the wrong side is how the first two versions of this list
    // "failed" against a perfectly correct index.
    name: 'Queen thrown away, White to move and lost',
    sans: ['e4', 'e5', 'Qh5', 'Nc6', 'Qxf7+', 'Kxf7'],
    max: 15,
  },
]

const fail = []
const warn = []
const note = (ok, message) => {
  process.stdout.write(`  ${ok ? '✓' : '✗'} ${message}\n`)
  if (!ok) fail.push(message)
}

function checkStructure(dir, deep) {
  process.stdout.write('\nstructure\n')
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))

  note(manifest.records > 0, `manifest records ${Number(manifest.records).toLocaleString()}`)
  note(
    !manifest.limited,
    manifest.limited
      ? `built with --limit ${manifest.limited} — this is a PARTIAL index, not the whole dump`
      : 'built without --limit (whole dump)',
  )
  note(
    manifest.records === manifest.scattered,
    `every scattered record survived the sort (${manifest.scattered} -> ${manifest.records})`,
  )
  note(manifest.unparseable === 0, `unparseable lines ${manifest.unparseable}`)

  // The dump documents 394,669,566 positions. A materially smaller index means
  // a truncated download, which zstd will not report as an error.
  const DOCUMENTED = 394_669_566
  const ratio = manifest.records / DOCUMENTED
  note(
    ratio > 0.97,
    `holds ${(100 * ratio).toFixed(1)}% of the ${DOCUMENTED.toLocaleString()} positions the dump documents`,
  )

  let bytes = 0
  let missing = 0
  let ragged = 0
  for (let i = 0; i < BUCKETS; i++) {
    const p = bucketPath(dir, i, 'bin')
    if (!existsSync(p)) {
      missing++
      continue
    }
    const size = statSync(p).size
    bytes += size
    if (size % RECORD_BYTES !== 0) ragged++
  }
  note(missing === 0, `all ${BUCKETS} buckets present${missing ? ` (${missing} missing)` : ''}`)
  note(ragged === 0, `every bucket is a whole number of ${RECORD_BYTES}-byte records`)
  note(
    bytes / RECORD_BYTES === manifest.records,
    `bucket bytes agree with the manifest (${(bytes / 1e9).toFixed(1)} GB)`,
  )

  // Sorted order and bucket assignment. Full pass reads the whole index; the
  // sampled default reads 16 buckets, which is enough to catch a systematic
  // fault and takes seconds.
  const toCheck = deep
    ? [...Array(BUCKETS).keys()]
    : [...Array(16).keys()].map((k) => k * 16 + 7)
  let unsorted = 0
  let misfiled = 0
  for (const i of toCheck) {
    const buf = readFileSync(bucketPath(dir, i, 'bin'))
    for (let k = 0; k * RECORD_BYTES < buf.length; k++) {
      if (buf[k * RECORD_BYTES] !== i) misfiled++
      if (k > 0 && compareKeys(buf, (k - 1) * RECORD_BYTES, buf, k * RECORD_BYTES) >= 0) unsorted++
    }
  }
  note(unsorted === 0, `${toCheck.length} bucket(s) in ascending key order`)
  note(misfiled === 0, 'every key sits in the bucket its first byte names')

  return manifest
}

function checkKnownPositions(db) {
  process.stdout.write('\nknown positions\n')
  let found = 0
  for (const k of KNOWN) {
    const fen = fenAfter(k.sans)
    const r = db.query(fen)
    if (!r) {
      note(false, `${k.name} — not in the index`)
      continue
    }
    found++
    const cp = r.lines[0].score.type === 'cp' ? r.lines[0].score.value : null
    const ok = cp !== null && cp >= k.min && cp <= k.max
    note(
      ok,
      `${k.name.padEnd(24)} d${String(r.depth).padStart(3)}  ` +
        `${cp === null ? r.lines[0].score.type : `${cp > 0 ? '+' : ''}${cp}cp`} (mover)` +
        `${ok ? '' : ` — outside the plausible ${k.min}..${k.max}`}`,
    )
  }
  note(found === KNOWN.length, `${found}/${KNOWN.length} textbook positions present`)
}

function checkSignConvention(db) {
  process.stdout.write('\nsign convention (a flip here inverts every audit verdict)\n')
  for (const p of DECIDED) {
    const fen = fenAfter(p.sans)
    const r = db.query(fen)
    if (!r) {
      warn.push(`${p.name} not in the index — sign not checked here`)
      process.stdout.write(`  · ${p.name} — not in the index, skipped\n`)
      continue
    }
    const wp = winPercent(r.lines[0].score)
    const ok = wp >= (p.min ?? 0) && wp <= (p.max ?? 100)
    note(
      ok,
      `${p.name.padEnd(52)} mover at ${wp.toFixed(1)} win%` +
        (ok ? '' : ` — expected ${p.min ?? 0}..${p.max ?? 100}`),
    )
  }
}

function checkRepertoireCoverage(db) {
  process.stdout.write('\ncoverage of our own repertoire\n')
  const files = [
    'repertoire/etude-repertoire-v1-white.pgn',
    'repertoire/etude-repertoire-v1-white-e4.pgn',
    'repertoire/etude-repertoire-v1-black.pgn',
  ]

  let total = 0
  let hit = 0
  for (const f of files) {
    const { decisions } = ourDecisions(readFileSync(join(repoRoot, f), 'utf8'))
    const found = decisions.filter((d) => db.query(d.fen)).length
    total += decisions.length
    hit += found
    process.stdout.write(
      `  ${f.split('/').pop().padEnd(34)} ${String(found).padStart(3)}/${String(decisions.length).padEnd(3)}` +
        ` (${((100 * found) / decisions.length).toFixed(1)}%)\n`,
    )
  }

  // #106 measured 100% on a 40-position sample. Anything far below that is a
  // key-normalisation bug, not a gap in the dump — the repertoire stops at ply
  // 13 and openings are the best-covered region of any evaluation database.
  const rate = hit / total
  note(
    rate > 0.95,
    `${hit}/${total} prescribed positions found (${(100 * rate).toFixed(1)}%)` +
      (rate > 0.95 ? '' : ' — suspect FEN normalisation before believing this is a coverage gap'),
  )
}

export async function main() {
  const args = parseArgs(process.argv.slice(2), ['index', 'deep'])
  const dir = stringFlag(args, 'index') ?? join(repoRoot, 'db', 'eval-index')
  const deep = args.deep === true

  process.stdout.write(`verifying ${dir}${deep ? ' (deep)' : ''}\n`)
  const db = createEvalDb({ dir })

  checkStructure(dir, deep)
  checkKnownPositions(db)
  checkSignConvention(db)
  checkRepertoireCoverage(db)
  db.close()

  process.stdout.write('\n')
  for (const w of warn) process.stdout.write(`warning: ${w}\n`)
  if (fail.length) {
    process.stdout.write(`\nFAILED ${fail.length} check(s):\n`)
    for (const f of fail) process.stdout.write(`  - ${f}\n`)
    process.exitCode = 1
  } else {
    process.stdout.write('all checks passed\n')
  }
}

// Windows gives `file:///C:/…` from import.meta.url but argv[1] is a plain path,
// so compare through pathToFileURL — as build.mjs, crawl.mjs and buildBook.mjs do.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
