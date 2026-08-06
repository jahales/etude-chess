// Repertoire crawler — best-first expansion of an opening tree (ADR 0021, #88).
//
// Two node types with genuinely different logic:
//
//   our nodes       pick exactly ONE move (that is what makes it a repertoire),
//                   ranked by soundness, branching cost and popularity.
//   opponent nodes  cover MANY moves: everything up to a share of the games
//                   actually played at our band, PLUS anything `trapValue`
//                   flags as bad-but-overperforming.
//
// A line stops when the position goes quiet — no hidden tactic, several
// playable moves, roughly balanced — and that terminal position is the item we
// actually train. Depth is therefore variable, not fixed.
//
// All the judgment lives in src/domain/repertoire.ts, unit-tested. This file is
// IO, orchestration and reporting.

import { writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Chess } from 'chess.js'
import { negate, winPercent } from '../../src/domain/winPercent.ts'
import {
  coverByMass,
  frequency,
  gamesFor,
  isTrap,
  ourMoveScore,
  practicalScore,
  quietness,
  rankOurMoves,
  totalGames,
  trapValue,
} from '../../src/domain/repertoire.ts'
import { fenKey, toPgn } from '../../src/domain/repertoirePgn.ts'
import { createExplorer } from './explorer.mjs'
import { createLocalBook } from './localBook.mjs'
import { createEngine, DEFAULT_ENGINE_PATH } from './engine.mjs'

export const DEFAULTS = {
  minPly: 6,
  maxPly: 10,
  deepNodes: 400_000,
  shallowNodes: 20_000,
  multipv: 5,
  massTarget: 0.85,
  minGames: 20,
  maxOpponentMoves: 6,
  /** trapValue above which a rare move earns coverage on its own merit. */
  trapThreshold: 0.05,
  /** Stop expanding once the band has played this position fewer times. */
  minNodeGames: 50,
  /**
   * Master games are far scarcer than online ones, so the canonical source
   * needs a lower bar before we fall back to band data for our own move.
   */
  minCanonGames: 20,
  /**
   * Cap on per-child engine evaluations at one opponent node. Candidates are
   * taken in frequency order, so this cap chops the *tail* — which is where
   * traps live by definition. Set high enough that a normal opening node is
   * covered whole; the run reports any node it truncates.
   */
  maxEvalPerNode: 20,
}

function applyUci(fen, uci) {
  const c = new Chess(fen)
  const move = c.move({
    from: uci.slice(0, 2),
    to: uci.slice(2, 4),
    promotion: uci.length > 4 ? uci[4] : undefined,
  })
  return move ? { fen: c.fen(), san: move.san } : null
}

/**
 * Deep + shallow evaluation and the quiet test for one position.
 * Win percentages are from the side to move.
 */
async function assess(engine, fen, o) {
  const deep = await engine.analyse(fen, { nodes: o.deepNodes, multipv: o.multipv })
  const shallow = await engine.analyse(fen, { nodes: o.shallowNodes, multipv: 1 })
  const multipvWp = deep.lines.map((l) => winPercent(l.score))
  const deepWp = multipvWp[0] ?? 50
  const shallowWp = shallow.lines[0] ? winPercent(shallow.lines[0].score) : deepWp
  return {
    deep,
    bestWp: deepWp,
    quiet: quietness({ multipv: multipvWp, shallow: shallowWp, deep: deepWp }),
  }
}

/** Win% of a move, from the perspective of whoever plays it. */
async function evalAfter(engine, fen, uci, o) {
  const applied = applyUci(fen, uci)
  if (!applied) return null
  const r = await engine.analyse(applied.fen, { nodes: o.deepNodes, multipv: 1 })
  const line = r.lines[0]
  if (!line) return null
  // The child's score is from the *replier's* view; negate for the mover's.
  return { ...applied, moverWp: winPercent(negate(line.score)), score: line.score }
}

export async function crawl(config) {
  const o = { ...DEFAULTS, ...config }
  const { engine, explorer, canon = null, ourColor, forcedLine = [] } = o

  const nodes = new Map()
  const report = {
    expanded: 0,
    terminal: { quiet: 0, 'depth-cap': 0, 'out-of-book': 0, 'no-sound-move': 0 },
    traps: [],
    truncatedNodes: [],
    outOfBook: [],
    engineFallbacks: [],
    /** Which source decided each expanded node — canon (masters) vs band. */
    moveSource: { canon: 0, band: 0 },
  }

  const root = new Chess()
  /** Follow the curated prefix verbatim before the crawler starts choosing. */
  const forcedSans = []
  for (const san of forcedLine) {
    const m = root.move(san)
    if (!m) throw new Error(`illegal move in --line: ${san}`)
    forcedSans.push(m.san)
  }
  const rootFen = root.fen()
  const basePly = forcedSans.length

  const queue = [{ fen: rootFen, ply: basePly, line: [...forcedSans] }]

  while (queue.length) {
    const item = queue.shift()
    const key = fenKey(item.fen)
    if (nodes.has(key)) continue // transposition — already covered

    const chess = new Chess(item.fen)
    const sideToMove = chess.turn()
    const ours = sideToMove === ourColor

    const node = {
      fen: item.fen,
      ply: item.ply,
      sideToMove,
      ours,
      line: item.line,
      children: [],
      terminal: false,
    }
    nodes.set(key, node)

    if (item.ply >= o.maxPly) {
      node.terminal = true
      node.terminalReason = 'depth-cap'
      report.terminal['depth-cap']++
      continue
    }

    const { deep, bestWp, quiet } = await assess(engine, item.fen, o)
    node.bestWinPercent = Number(bestWp.toFixed(2))
    node.quiet = quiet

    if (item.ply >= o.minPly && quiet.quiet) {
      node.terminal = true
      node.terminalReason = 'quiet'
      report.terminal.quiet++
      process.stdout.write(`  ✓ quiet @ply ${item.ply}: ${item.line.join(' ')}\n`)
      continue
    }

    // The two sources answer two different questions, and which one applies is
    // decided by whose move it is.
    //
    //   our nodes       the CANONICAL source (master games) — what is
    //                   principled here, the ideal we are trying to learn.
    //   opponent nodes  our own RATING BAND — what we will actually be shown
    //                   across the board, including the junk.
    //
    // Using band data to choose our own moves would have us learning what 1400s
    // happen to play; using master data to predict theirs would prepare us for
    // opponents who do not exist. Note the deliberate asymmetry below: our
    // move's *branching cost* is still measured against BAND replies, because
    // the replies we have to prepare are the ones we will face, not the ones a
    // 2600 would choose. A line that is narrow at master level can be wide open
    // at 1400.
    let book = null
    let bookSource = 'band'
    if (ours && canon) {
      const canonical = await canon.query(item.fen)
      if (totalGames(canonical.moves) >= o.minCanonGames) {
        book = canonical
        bookSource = 'canon'
      }
    }
    if (!book) book = await explorer.query(item.fen)
    node.bookSource = bookSource
    report.moveSource[bookSource]++

    node.opening = book.opening
    const total = totalGames(book.moves)
    if (total < o.minNodeGames) {
      node.terminal = true
      node.terminalReason = 'out-of-book'
      report.terminal['out-of-book']++
      report.outOfBook.push({ line: item.line.join(' '), games: total })
      continue
    }
    node.games = total
    report.expanded++

    // Evaluate candidate moves. Capped, and the cap is reported rather than
    // silently applied — a truncated node reads as "fully covered" otherwise.
    const candidates = book.moves.slice(0, o.maxEvalPerNode)
    if (book.moves.length > candidates.length) {
      report.truncatedNodes.push({
        line: item.line.join(' '),
        evaluated: candidates.length,
        available: book.moves.length,
      })
    }

    const scored = []
    for (const m of candidates) {
      const after = await evalAfter(engine, item.fen, m.uci, o)
      if (!after) continue
      scored.push({
        stats: m,
        san: after.san,
        fen: after.fen,
        swing: Math.max(0, bestWp - after.moverWp),
        expected: after.moverWp / 100,
        frequency: frequency(m, total),
        practical: practicalScore(m, sideToMove),
      })
    }

    if (ours) {
      // One move. Branching cost needs a lookahead into each child's replies.
      const ranked = []
      for (const c of scored) {
        if (c.swing > 5) continue // outside the soundness gate; skip the lookup
        const replies = await explorer.query(c.fen)
        const cover = coverByMass(replies.moves, {
          massTarget: o.massTarget,
          minGames: o.minGames,
          maxMoves: o.maxOpponentMoves,
        })
        ranked.push({
          move: c.stats,
          swing: c.swing,
          replyBranching: cover.covered.length,
          frequency: c.frequency,
          _c: c,
        })
      }
      const best = rankOurMoves(ranked)[0]
      if (!best) {
        // No move humans actually play here is sound. That is the *normal* case
        // right after the opponent falls into a trap: the refutation is often
        // too rare to appear in the explorer at all. A repertoire that gave up
        // here would omit exactly the punishments it exists to teach, so fall
        // back to the engine's choice.
        //
        // Constitution §4 is untouched: it governs where *distractors* come
        // from (human frequency, never engine top-N). This is our own move.
        const engineBest = deep.lines[0]?.pv?.[0]
        const applied = engineBest ? applyUci(item.fen, engineBest) : null
        if (!applied) {
          node.terminal = true
          node.terminalReason = 'no-sound-move'
          report.terminal['no-sound-move']++
          continue
        }
        node.children.push({
          san: applied.san,
          uci: engineBest,
          fen: applied.fen,
          reason: 'ours-engine',
          swing: 0,
        })
        report.engineFallbacks.push({ line: [...item.line, applied.san].join(' '), san: applied.san })
        queue.push({ fen: applied.fen, ply: item.ply + 1, line: [...item.line, applied.san] })
        continue
      }
      const c = best._c
      node.children.push({
        san: c.san,
        uci: c.stats.uci,
        fen: c.fen,
        reason: 'ours',
        // Only meaningful when a canonical source was configured; then 'band'
        // means we have left master theory behind.
        ...(canon ? { source: bookSource } : {}),
        swing: Number(c.swing.toFixed(2)),
        frequency: Number(c.frequency.toFixed(4)),
        replyBranching: best.replyBranching,
        score: Number(ourMoveScore(best).toFixed(3)),
      })
      queue.push({ fen: c.fen, ply: item.ply + 1, line: [...item.line, c.san] })
    } else {
      // Many moves: frequency mass, plus anything that overperforms its eval.
      const cover = coverByMass(
        scored.map((s) => s.stats),
        { massTarget: o.massTarget, minGames: o.minGames, maxMoves: o.maxOpponentMoves },
      )
      node.coverage = { mass: Number(cover.mass.toFixed(3)), truncated: cover.truncated }
      const coveredUcis = new Set(cover.covered.map((m) => m.uci))

      for (const c of scored) {
        const t = {
          frequency: c.frequency,
          swing: c.swing,
          practical: c.practical,
          expected: c.expected,
        }
        const tv = trapValue(t)
        const byMass = coveredUcis.has(c.stats.uci)
        const byTrap = isTrap(t, o.trapThreshold)
        if (!byMass && !byTrap) continue

        if (byTrap) {
          report.traps.push({
            line: [...item.line, c.san].join(' '),
            san: c.san,
            trapValue: Number(tv.toFixed(4)),
            frequency: Number(c.frequency.toFixed(4)),
            swing: Number(c.swing.toFixed(1)),
            practical: Number(c.practical.toFixed(3)),
            expected: Number(c.expected.toFixed(3)),
            games: gamesFor(c.stats),
          })
        }

        node.children.push({
          san: c.san,
          uci: c.stats.uci,
          fen: c.fen,
          reason: byTrap && !byMass ? 'trap' : byTrap ? 'mass+trap' : 'mass',
          swing: Number(c.swing.toFixed(2)),
          frequency: Number(c.frequency.toFixed(4)),
          trapValue: Number(tv.toFixed(4)),
          games: gamesFor(c.stats),
        })
        queue.push({ fen: c.fen, ply: item.ply + 1, line: [...item.line, c.san] })
      }
    }
  }

  report.traps.sort((a, b) => b.trapValue - a.trapValue)
  return { nodes, rootFen, forcedSans, report, options: o }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) out[key] = true
    else {
      out[key] = next
      i++
    }
  }
  return out
}

const HELP = `
Repertoire crawler (issue #88, ADR 0021)

  node scripts/repertoire/crawl.mjs --color white --line "d4 d5 c4 dxc4" --out out/qga

  --color   white | black          which side the repertoire is for   (required)
  --line    "d4 d5 c4"             curated prefix followed verbatim   (default: none)
  --out     out/qga                output basename (.json and .pgn)   (required)
  --book       out/band.json       OUR BAND: what opponents actually play.
                                   Decides their moves. Local book from
                                   buildBook.mjs, instead of the API.
  --canon-book out/otb.json        MASTERS: what is principled. Decides OUR
                                   moves. Optional; without it the band book
                                   decides both.
  --canon                          use the masters explorer API as the
                                   canonical source instead of --canon-book
  --source  amateur | masters      explorer endpoint          (default: amateur)
  --ratings 1600,1800              rating buckets, amateur only
  --max-ply 10                     depth cap in plies         (default: ${DEFAULTS.maxPly})
  --min-ply 6                      earliest a line may stop   (default: ${DEFAULTS.minPly})
  --nodes   400000                 engine budget per position
  --mass    0.85                   opponent coverage target
  --trap    0.05                   trapValue threshold
  --max-eval       20              opponent moves evaluated per node. Candidates
                                   come in frequency order, so this cap chops the
                                   tail — where traps live. Raise it to hunt.
  --min-node-games 50              stop expanding below this many games
  --max-replies    6               most opponent moves covered at one node
  --engine  <path>                 Stockfish binary
                                   (default: ${DEFAULT_ENGINE_PATH})
`

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || !args.color || !args.out) {
    console.log(HELP)
    process.exit(args.help ? 0 : 1)
  }

  const ourColor = String(args.color).startsWith('b') ? 'b' : 'w'
  const forcedLine = args.line ? String(args.line).trim().split(/\s+/).filter(Boolean) : []
  const outBase = String(args.out)

  // A local book built by buildBook.mjs is a drop-in replacement for the API:
  // reproducible, rate-limit-free and offline. See that script's header.
  const explorer = args.book
    ? await createLocalBook({ path: String(args.book) })
    : createExplorer({
        cacheDir: join(dirname(outBase), '.explorer-cache'),
        source: args.source === 'masters' ? 'masters' : 'amateur',
        ratings: args.ratings ? String(args.ratings).split(',').map(Number) : undefined,
      })

  // The canonical source is optional: without it the band book decides both
  // halves, which is the old behaviour.
  const canon = args['canon-book']
    ? await createLocalBook({ path: String(args['canon-book']) })
    : args.canon
      ? createExplorer({ cacheDir: join(dirname(outBase), '.masters-cache'), source: 'masters' })
      : null
  const engine = createEngine({ path: args.engine ? String(args.engine) : undefined })

  const started = Date.now()
  console.log(`crawling ${ourColor === 'w' ? 'White' : 'Black'} from: ${forcedLine.join(' ') || '(start)'}`)

  try {
    const result = await crawl({
      engine,
      explorer,
      canon,
      ourColor,
      forcedLine,
      maxPly: args['max-ply'] ? Number(args['max-ply']) : undefined,
      minPly: args['min-ply'] ? Number(args['min-ply']) : undefined,
      deepNodes: args.nodes ? Number(args.nodes) : undefined,
      massTarget: args.mass ? Number(args.mass) : undefined,
      trapThreshold: args.trap ? Number(args.trap) : undefined,
      maxEvalPerNode: args['max-eval'] ? Number(args['max-eval']) : undefined,
      minNodeGames: args['min-node-games'] ? Number(args['min-node-games']) : undefined,
      maxOpponentMoves: args['max-replies'] ? Number(args['max-replies']) : undefined,
    })

    await mkdir(dirname(outBase), { recursive: true })
    const serialisable = {
      meta: {
        color: ourColor,
        line: forcedLine.join(' '),
        generated: new Date().toISOString(),
        options: { ...result.options, engine: undefined, explorer: undefined },
      },
      report: result.report,
      rootFen: result.rootFen,
      nodes: Object.fromEntries(result.nodes),
    }
    await writeFile(`${outBase}.json`, JSON.stringify(serialisable, null, 2), 'utf8')
    await writeFile(
      `${outBase}.pgn`,
      toPgn({
        nodes: result.nodes,
        rootFen: result.rootFen,
        forcedSans: result.forcedSans,
        ourColor,
        date: new Date().toISOString().slice(0, 10),
      }),
      'utf8',
    )

    const r = result.report
    const secs = ((Date.now() - started) / 1000).toFixed(0)
    console.log(`
── done in ${secs}s ─────────────────────────────
positions       ${result.nodes.size}   (expanded ${r.expanded})
terminal        quiet ${r.terminal.quiet} · depth-cap ${r.terminal['depth-cap']} · out-of-book ${r.terminal['out-of-book']}
decided by      ${canon ? `masters ${r.moveSource.canon} · band ${r.moveSource.band}` : `band only (no canonical source)`}
engine searches ${engine.searchCount()}
explorer        ${JSON.stringify(explorer.stats())}
traps found     ${r.traps.length}`)

    if (r.traps.length) {
      console.log('\ntop traps (frequency × swing × outperformance):')
      for (const t of r.traps.slice(0, 10)) {
        console.log(
          `  ${t.trapValue.toFixed(4)}  ${t.line}` +
            `   [${(t.frequency * 100).toFixed(1)}% of games, −${t.swing} win%, ` +
            `scores ${(t.practical * 100).toFixed(0)}% vs ${(t.expected * 100).toFixed(0)}% deserved, n=${t.games}]`,
        )
      }
    }
    if (r.truncatedNodes.length) {
      console.log(`\n⚠ ${r.truncatedNodes.length} node(s) hit the evaluation cap — not fully covered:`)
      for (const t of r.truncatedNodes.slice(0, 5)) {
        console.log(`  ${t.line || '(root)'}: evaluated ${t.evaluated} of ${t.available}`)
      }
    }
    console.log(`\nwrote ${outBase}.json and ${outBase}.pgn`)
  } finally {
    await engine.quit()
  }
}

// Windows gives `file:///C:/…` from import.meta.url but argv[1] is a plain path,
// so this must go through pathToFileURL rather than string-patching slashes.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
