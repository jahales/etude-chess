// What to learn first.
//
//   node scripts/repertoire/studyOrder.mjs --pgn repertoire/etude-repertoire-v1-white.pgn
//
// A repertoire is a list of decisions in manifest order, which is an accident of
// how it was crawled. It is not a study plan: the QGD Exchange main line and a
// reply you will meet twice a year sit next to each other, and the only signal
// about which to learn first is how far down the file it is.
//
// This ranks them by what knowing the move is *worth*:
//
//   reach  — how often you actually arrive at the position, from the band book,
//            which is the same source the crawl used to decide the opponent's
//            moves. Optionally scaled by the owner's own games, so an opening
//            they face weekly outranks one the band plays and they do not.
//   cost   — what not knowing costs. Not "how good is our move" — every move
//            here already passed the soundness gate, so by the project's own
//            definition they are all as good as best (ADR 0021, constitution
//            §3). The cost is the gap to what you would play *instead*: the
//            move the band plays most often from that position, which is the
//            instinctive one, scored from the evaluation index.
//
// A decision where the natural move is also the right move is worth nothing to
// study, however common — you will find it at the board. A rare position where
// the natural move loses half a pawn is worth more than its frequency suggests.
// The product is the ranking.

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Chess } from 'chess.js'
import { gamesFor, totalGames } from '../../src/domain/repertoire.ts'
import { winPercent } from '../../src/domain/winPercent.ts'
import { createEvalDb } from './evalDb.mjs'
import { createLocalBook } from './localBook.mjs'
import { MIN_INDEX_DEPTH } from './soundness.mjs'
import { ourDecisions } from './readRepertoirePgn.mjs'
import { parseArgs, numberFlag, stringFlag } from './build.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..')

const negate = (s) => ({ type: s.type, value: -s.value })

/** Win% of a move from the mover's side, or null when the index cannot say. */
function moveValue(db, fen, uci, minDepth) {
  const before = db.query(fen)
  if (!before?.lines?.length || before.depth < minDepth) return null

  const listed = before.lines.find((l) => l.pv[0] === uci)
  if (listed) return winPercent(listed.score)

  // Outside the stored pvs, so score the position it leads to and negate —
  // the same fallback the gate and the audit use.
  let after
  try {
    const c = new Chess(fen)
    if (!c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] })) return null
    after = db.query(c.fen())
  } catch {
    return null
  }
  if (!after?.lines?.length || after.depth < minDepth) return null
  return winPercent(negate(after.lines[0].score))
}

/**
 * Score one decision.
 * @returns {{reach: number, cost: number, value: number, instinct: string}|{skipped: string}}
 */
export function scoreDecision(decision, { db, band, bandTotal, minDepth, ownWeight = 1 }) {
  const book = band
  const moves = book?.moves ?? []
  const games = totalGames(moves)
  if (!games) return { skipped: 'position not in the band book' }

  const ours = moveValue(db, decision.fen, decision.uci, minDepth)
  if (ours === null) return { skipped: 'our move is not scorable from the index' }

  // What you would play without preparation: the band's most popular move here
  // that is not ours. If ours *is* the most popular, the next one down is the
  // mistake you are being saved from.
  const alternative = [...moves]
    .filter((m) => m.uci !== decision.uci)
    .sort((a, b) => gamesFor(b) - gamesFor(a))[0]
  if (!alternative) return { skipped: 'no alternative in the band book' }

  const instinctValue = moveValue(db, decision.fen, alternative.uci, minDepth)
  if (instinctValue === null) return { skipped: 'the instinctive move is not scorable' }

  const reach = (games / bandTotal) * ownWeight
  const cost = Math.max(0, ours - instinctValue)
  return {
    reach,
    games,
    cost,
    instinct: alternative.san,
    instinctShare: gamesFor(alternative) / games,
    ourValue: ours,
    value: reach * cost,
  }
}

export async function studyOrder({ pgnPaths, db, band, minDepth = MIN_INDEX_DEPTH, ownWeights = {} }) {
  const root = await band.query(new Chess().fen())
  const bandTotal = totalGames(root?.moves ?? []) || 1

  const rows = []
  for (const path of pgnPaths) {
    const { decisions } = ourDecisions(readFileSync(path, 'utf8'))
    for (const d of decisions) {
      const bandHere = await band.query(d.fen)
      const scored = scoreDecision(d, {
        db,
        band: bandHere,
        bandTotal,
        minDepth,
        // A branch the owner meets more often than the band does is worth more
        // than its band share says. Defaults to 1, i.e. band frequency alone.
        // `line` is the SAN path as an array; its first move names the opening
        // family the weight is keyed on.
        ownWeight: ownWeights[d.line[0]] ?? 1,
      })
      rows.push({
        file: path.split(/[\\/]/).pop(),
        branch: d.branch,
        line: d.line.join(' '),
        ply: d.ply,
        san: d.san,
        ...scored,
      })
    }
  }
  return rows.sort((a, b) => (b.value ?? -1) - (a.value ?? -1))
}

async function main() {
  const args = parseArgs(process.argv.slice(2), ['pgn', 'index', 'book', 'top', 'out'])
  const db = createEvalDb({ dir: stringFlag(args, 'index') ?? join(repoRoot, 'db', 'eval-index') })
  const band = await createLocalBook({
    path: stringFlag(args, 'book') ?? join(repoRoot, 'db', 'book-band.json'),
  })
  const pgnPaths = (
    stringFlag(args, 'pgn') ??
    [
      'repertoire/etude-repertoire-v1-white.pgn',
      'repertoire/etude-repertoire-v1-white-e4.pgn',
      'repertoire/etude-repertoire-v1-black.pgn',
    ].join(',')
  )
    .split(',')
    .map((p) => join(repoRoot, p.trim()))

  const rows = await studyOrder({ pgnPaths, db, band })
  const scored = rows.filter((r) => !r.skipped)
  const top = numberFlag(args, 'top') ?? 30

  process.stdout.write(
    `\n${scored.length} of ${rows.length} decisions scored ` +
      `(${rows.length - scored.length} not scorable: thin book or absent from the index)\n\n` +
      `value = how often you reach it × what playing the natural move instead would cost\n\n`,
  )
  process.stdout.write('  value   reach  cost  instead of        line\n')
  for (const r of scored.slice(0, top)) {
    process.stdout.write(
      `  ${r.value.toFixed(3).padStart(6)} ${(100 * r.reach).toFixed(2).padStart(6)}% ` +
        `${r.cost.toFixed(1).padStart(5)} ${`${r.san} not ${r.instinct}`.padEnd(17)} ${r.line}\n`,
    )
  }

  const outPath = stringFlag(args, 'out') ?? join(repoRoot, 'out', 'study-order.json')
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, JSON.stringify({ generated: new Date().toISOString(), rows }, null, 2))
  process.stdout.write(`\nfull ranking: ${outPath}\n`)
  db.close()
}

// Windows gives `file:///C:/…` from import.meta.url but argv[1] is a plain path,
// so compare through pathToFileURL — as build.mjs, crawl.mjs and buildBook.mjs do.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
