// What did the shallow gate wrongly *reject*? — the half of #106 the audit cannot see.
//
//   node scripts/repertoire/gateGaps.mjs --index db/eval-index \
//        --canon-book db/book-otb.json --book db/book-band.json
//
// `auditRepertoire` re-grades the moves the repertoire prescribes and asks
// whether any is unsound. That is only one of the two ways a shallow gate can
// hurt, and the quieter one. The gate's job is to decide which candidates are
// *eligible*; `rankOurMoves` then chooses among survivors by branching cost and
// popularity, with **no evaluation term at all** (ADR 0021 defends that trade).
//
// So a gate at the wrong depth does not merely let a bad move through. It can
// wrongly reject a *good* one — and because ranking ignores evaluation, the
// move promoted in its place is not "the next best" by any engine measure. It is
// whatever happened to be cheapest to learn among the survivors. That is
// invisible to an audit of what shipped.
//
// This replays the choice at each of the repertoire's own decision positions,
// using the same candidate source, the same branching cost and the same
// ranking, but gating at median depth 50 instead of 120,000 nodes. It runs no
// engine: every number comes from the index or the books, so it is minutes
// rather than hours, and it reports where the two would disagree.

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  MIN_GAMES_TO_TRUST_BRANCHING,
  SOUNDNESS_MAX_SWING,
  coverByMass,
  gamesFor,
  rankOurMoves,
  totalGames,
} from '../../src/domain/repertoire.ts'
import { DEFAULTS } from './crawl.mjs'

/**
 * How much better a candidate's swing must be before a ranking change counts
 * as substantive rather than a tie-break.
 *
 * Every candidate here has already passed the soundness gate, which is the
 * project's own definition of "as good as best" (ADR 0021), so a fraction of a
 * win% between two survivors is not a finding — it is the popularity term
 * breaking a tie on a bigger book. Kept well under SOUNDNESS_MAX_SWING so it
 * can never reclassify a move the gate itself would separate.
 */
export const TIE_BREAK_WIN_PERCENT = 0.5
import { createEvalDb } from './evalDb.mjs'
import { createLocalBook } from './localBook.mjs'
import { createSoundnessGate } from './soundness.mjs'
import { ourDecisions } from './readRepertoirePgn.mjs'
import { DECKS } from './auditRepertoire.mjs'
import { parseArgs, numberFlag, stringFlag } from './build.mjs'
import { Chess } from 'chess.js'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..')

const applyUci = (fen, uci) => {
  try {
    const c = new Chess(fen)
    return c.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion: uci.length > 4 ? uci[4] : undefined,
    })
      ? c.fen()
      : null
  } catch {
    return null
  }
}

/**
 * Replay one decision with the deep gate.
 *
 * `fallback` is deliberately `Infinity`: this asks what the *index* admits, so
 * a candidate it cannot score is left out rather than waved through on a number
 * from a different source. Those are counted and reported, not hidden.
 */
export async function replayDecision(decision, { gate, canon, band, opts }) {
  const book = await canon.query(decision.fen)
  const moves = book?.moves ?? []
  const canonGames = totalGames(moves)
  // The crawler stops expanding below this; re-ranking on less is re-ranking on
  // noise, and would report a "change" that no amount of depth caused.
  if (canonGames < opts.minCanonGames) {
    return { skipped: 'canon book too thin here', canonGames }
  }

  const candidates = []
  let unscored = 0
  let untrusted = 0
  for (const m of moves.slice(0, opts.maxEval)) {
    const g = gate.swingFor(decision.fen, m.uci, { swing: Infinity, depth: 0 })
    if (!Number.isFinite(g.swing)) {
      unscored++
      continue
    }
    const childFen = applyUci(decision.fen, m.uci)
    if (!childFen) continue
    const replies = await band.query(childFen)
    const replyGames = totalGames(replies?.moves ?? [])

    // Without this the ranking rewards obscurity: a move nobody plays reaches a
    // position the band book has never seen, `coverByMass` finds nothing there,
    // and it scores as beautifully narrow. `MIN_GAMES_TO_TRUST_BRANCHING`
    // documents the same trap; here we drop the candidate outright rather than
    // rank it on a branching number that means nothing.
    if (replyGames < MIN_GAMES_TO_TRUST_BRANCHING) {
      untrusted++
      continue
    }

    candidates.push({
      move: m,
      swing: g.swing,
      replyBranching: coverByMass(replies.moves, {
        massTarget: opts.massTarget,
        maxMoves: opts.maxReplies,
      }).covered.length,
      replyGames,
      frequency: canonGames ? gamesFor(m) / canonGames : 0,
      gateDepth: g.depth,
    })
  }

  const oursNow = candidates.find((c) => c.move.uci === decision.uci) ?? null
  // Our move absent from the candidate set is a *coverage* fact about the canon
  // book, not a verdict on the move. Counting it as a change would blame the
  // gate for a gap in the data.
  if (!candidates.length) {
    return { skipped: 'no candidate the index could score', canonGames, unscored, untrusted }
  }
  if (!oursNow) {
    return { skipped: 'our move is not a canon candidate here', canonGames, unscored, untrusted }
  }
  if (candidates.length < 2) {
    return { skipped: 'only one rankable candidate', canonGames, unscored, untrusted }
  }

  const best = rankOurMoves(candidates)[0] ?? null
  const changes = best ? best.move.uci !== decision.uci : false

  return {
    considered: candidates.length,
    unscored,
    untrusted,
    sound: candidates.filter((c) => c.swing <= SOUNDNESS_MAX_SWING).length,
    ourSwing: oursNow.swing,
    ourStillSound: oursNow.swing <= SOUNDNESS_MAX_SWING,
    ourBranching: oursNow.replyBranching,
    wouldChoose: best?.move.uci ?? null,
    wouldChooseSan: best?.move.san ?? null,
    wouldChooseSwing: best?.swing ?? null,
    wouldChooseBranching: best?.replyBranching ?? null,
    // A change that improves neither swing nor branching is the popularity term
    // breaking a tie differently on a bigger book — not something depth caused.
    tieBreak:
      changes &&
      best.swing >= oursNow.swing - TIE_BREAK_WIN_PERCENT &&
      best.replyBranching >= oursNow.replyBranching,
    changes,
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2), [
    'index',
    'canon-book',
    'book',
    'max-eval',
    'mass',
    'max-replies',
    'min-canon-games',
    'out',
  ])
  const opts = {
    maxEval: numberFlag(args, 'max-eval') ?? 20,
    massTarget: numberFlag(args, 'mass') ?? 0.85,
    maxReplies: numberFlag(args, 'max-replies') ?? 6,
    // The crawler's own floor for expanding a node, so the replay declares a
    // position unreplayable on exactly the evidence the crawl would have.
    minCanonGames: numberFlag(args, 'min-canon-games') ?? DEFAULTS.minNodeGames,
  }

  const db = createEvalDb({ dir: stringFlag(args, 'index') ?? join(repoRoot, 'db', 'eval-index') })
  const canon = await createLocalBook({
    path: stringFlag(args, 'canon-book') ?? join(repoRoot, 'db', 'book-otb.json'),
  })
  const band = await createLocalBook({
    path: stringFlag(args, 'book') ?? join(repoRoot, 'db', 'book-band.json'),
  })
  const gate = createSoundnessGate({ evalDb: db })

  const all = []
  for (const deck of DECKS) {
    const { decisions } = ourDecisions(readFileSync(join(repoRoot, deck.file), 'utf8'))
    process.stdout.write(`\n${deck.id}: replaying ${decisions.length} decisions\n`)

    const rows = []
    for (const d of decisions) {
      const r = await replayDecision(d, { gate, canon, band, opts })
      rows.push({ deck: deck.id, branch: d.branch, line: d.line.join(' '), san: d.san, uci: d.uci, ...r })
    }

    const replayed = rows.filter((r) => !r.skipped)
    const changed = replayed.filter((r) => r.changes)
    const skips = {}
    for (const r of rows) if (r.skipped) skips[r.skipped] = (skips[r.skipped] ?? 0) + 1
    process.stdout.write(
      `  replayed ${replayed.length}  ·  not replayable ${rows.length - replayed.length}\n` +
        Object.entries(skips)
          .map(([k, v]) => `      ${v} — ${k}\n`)
          .join('') +
        `  our move now unsound: ${replayed.filter((r) => r.ourStillSound === false).length}\n` +
        `  ranking would pick a different move: ${changed.length}` +
        ` (${changed.filter((r) => r.tieBreak).length} of them a tie-break)\n`,
    )
    all.push(...rows)
  }

  const replayed = all.filter((r) => !r.skipped)
  const changed = replayed.filter((r) => r.changes)
  process.stdout.write(
    `\nTOTAL replayed ${replayed.length} of ${all.length}\n` +
      `would change ${changed.length} (${((100 * changed.length) / (replayed.length || 1)).toFixed(1)}%)\n`,
  )

  const rejected = changed.filter((r) => !r.ourStillSound)
  const ties = changed.filter((r) => r.tieBreak)
  const substantive = changed.filter((r) => r.ourStillSound && !r.tieBreak)
  process.stdout.write(
    `  ${rejected.length} because our move no longer passes the gate\n` +
      `  ${ties.length} a tie-break — the alternative is no better on either axis\n` +
      `  ${substantive.length} where a sound move is genuinely preferred on branching\n\n`,
  )

  process.stdout.write('the substantive ones:\n')
  for (const r of substantive.slice(0, 25)) {
    process.stdout.write(
      `  ${r.line}\n` +
        `     we play ${r.san} (swing ${r.ourSwing.toFixed(1)}, ${r.ourBranching} replies) · ` +
        `prefers ${r.wouldChooseSan} ` +
        `(swing ${r.wouldChooseSwing.toFixed(1)}, ${r.wouldChooseBranching} replies)\n`,
    )
  }
  if (substantive.length > 25) process.stdout.write(`  … and ${substantive.length - 25} more\n`)

  const outPath = stringFlag(args, 'out') ?? join(repoRoot, 'out', 'gate-gaps.json')
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(
    outPath,
    JSON.stringify({ generated: new Date().toISOString(), opts, gate: gate.stats(), rows: all }, null, 2),
  )
  process.stdout.write(`\nfull detail: ${outPath}\n`)
  db.close()
}

// Windows gives `file:///C:/…` from import.meta.url but argv[1] is a plain path,
// so compare through pathToFileURL — as build.mjs, crawl.mjs and buildBook.mjs do.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
