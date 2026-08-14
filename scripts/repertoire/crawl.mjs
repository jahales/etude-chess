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
import { basename, dirname, join } from 'node:path'
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
  TRAP_MIN_GAMES,
  TRAP_MIN_SWING,
  SOUNDNESS_MAX_SWING,
  isPunished,
  outperformance,
} from '../../src/domain/repertoire.ts'
import { fenKey, toPgn } from '../../src/domain/repertoirePgn.ts'
import { createExplorer } from './explorer.mjs'
import { createLocalBook } from './localBook.mjs'
import { createEngine, DEFAULT_ENGINE_PATH } from './engine.mjs'
import { createEnginePool } from './enginePool.mjs'
import { createSoundnessGate, MIN_INDEX_DEPTH } from './soundness.mjs'
import { createEvalDb } from './evalDb.mjs'

export const DEFAULTS = {
  /**
   * Earliest ply a line may stop at. A line stops the moment it is *allowed*
   * to — almost every opening position is quiet by move 4 — so this, not
   * `maxPly`, is what decides how deep the output actually runs. At 6 the first
   * built repertoire bottomed out at move 5 across all 25 branches.
   *
   * Raised from 10 to 16 by ADR 0025. At 10 the repertoire stopped on the first
   * quiet position, which is before the middlegame structure exists: v1's
   * deepest line was ply 13, and a Carlsbad or a French chain does not form
   * until roughly ply 16-25. The quiet position is still the trainable item;
   * this says keep going until the *structural* one is reached. Curated
   * branches only — see ROLE_DEPTH_OFFSET in build.mjs.
   */
  minPly: 16,
  /**
   * Depth cap. Must stay **above** `minPly`: the cap is checked before the
   * quiet test, so a cap at the floor means no position is ever assessed for
   * quietness and every line ends on `depth-cap`. That configuration shipped
   * once — raising `minPly` without raising this — and produced a tree with
   * zero trainable positions while every test passed.
   */
  maxPly: 24,
  deepNodes: 400_000,
  /**
   * The shallow search of constitution §6's filter, as a fraction of the deep
   * one. A *fixed* shallow budget makes the tactic-gap test mean different
   * things at different --nodes: at 120k the ratio is 6:1, at 1M it is 50:1, so
   * the deep search diverges further from a frozen shallow reading and more
   * positions fail the quiet test purely because the budget moved.
   */
  shallowRatio: 1 / 6,
  /**
   * Whether to buy a second, shallower search and test it against the deep one
   * — constitution §6's tactic filter (ADR 0026).
   *
   * **Off, because at these budgets it decides nothing.** Measured over 412
   * positions the crawl actually assessed at 4M nodes, across the QGD Exchange
   * and QGA, the gap kept *zero* of them from going quiet; mean gap 0.45 win%
   * against a threshold of 5, maximum 1.34.
   *
   * It is not a bad test — it is a test of whether the deep search is deep
   * enough, and the answer changed when the budget did. v1 ran at 120,000
   * nodes against a 20,000-node shallow, where the two genuinely disagree. At
   * 4M against 667k both readings are past the horizon of ordinary opening
   * tactics. So this stays available rather than deleted: **turn it back on for
   * any run at a low node budget**, where it is doing real work again.
   */
  tacticGap: false,
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
async function assess(engine, fen, o, evalDb = null, report = null) {
  const deep = await engine.analyse(fen, { nodes: o.deepNodes, multipv: o.multipv })
  const multipvWp = deep.lines.map((l) => winPercent(l.score))
  const deepWp = multipvWp[0] ?? 50

  // The quiet test is the one genuinely *relative* measurement in the crawl: it
  // asks whether a shallow and a deep reading disagree. Deepening one side does
  // not improve it, it decalibrates it — an index reading at depth 34 against a
  // shallow search at depth 21 is a 13-ply gap where the design assumes about
  // five, so positions would look tactical for no reason but the swap. Both its
  // readings therefore stay on the engine, at the fixed ratio shallowRatio sets.
  //
  // It is also off by default now (ADR 0026) — at 4M nodes it decided nothing
  // across 412 assessed positions. When it *is* on, all three tests must pass,
  // so where breadth or balance has already failed the gap cannot change the
  // verdict: a second reading can only add a reason, never remove one. So the
  // shallow search is bought only where it can still matter.
  let quiet = quietness({ multipv: multipvWp, shallow: deepWp, deep: deepWp })
  if (o.tacticGap && quiet.quiet) {
    const shallow = await engine.analyse(fen, {
      nodes: Math.max(5_000, Math.round(o.deepNodes * o.shallowRatio)),
      multipv: 1,
    })
    const shallowWp = shallow.lines[0] ? winPercent(shallow.lines[0].score) : deepWp
    quiet = quietness({ multipv: multipvWp, shallow: shallowWp, deep: deepWp })
    // Kept recording whenever the test runs, so re-enabling it at a low budget
    // produces the evidence for its own worth rather than an assertion.
    if (report) {
      report.tacticGap.tested++
      report.tacticGap.total += quiet.tacticGap
      report.tacticGap.max = Math.max(report.tacticGap.max, quiet.tacticGap)
      if (!quiet.quiet) report.tacticGap.decided++
    }
  } else if (report) {
    report.tacticGap.skipped++
  }
  if (report) report.tacticGap.enabled = Boolean(o.tacticGap)

  // `quiet` above is left wholly engine-derived and self-consistent. Only
  // `bestWp` moves, and only because it is *subtracted* from candidate values
  // that now come from the index: a ~26-ply baseline against 34-ply candidates
  // manufactures swing out of the depth difference, and that swing feeds trap
  // detection. Both sides of the subtraction must come from one source.
  const indexed = evalDb?.query(fen)
  const useIndex = indexed?.lines?.length && indexed.depth >= MIN_INDEX_DEPTH
  if (report) report.bestSource[useIndex ? 'cloud' : 'local']++

  return {
    deep,
    bestWp: useIndex ? winPercent(indexed.lines[0].score) : deepWp,
    quiet,
  }
}

/**
 * Evaluate every candidate move at one node, in one batch.
 *
 * This is where nearly all of a crawl's engine time goes — up to
 * `maxEvalPerNode` searches per expanded node — and it is the one part that
 * parallelises. The tree walk cannot: it picks its next position from the last
 * result, which is the caveat enginePool.mjs documents. The candidates at a
 * *single* node have no such dependency on each other.
 *
 * Each search is still single-threaded whichever analyser runs it, so
 * engine.mjs's reproducibility rule holds: the same position at the same node
 * budget returns the same score, and only the wall clock changes.
 *
 * @param {{analyseAll: (fens: string[], o: object) => Promise<object[]>}} analyser
 * @returns {Promise<{stats: object, san: string, fen: string, moverWp: number,
 *                    score: object, depth: number}[]>} candidates that produced a line
 */
async function evalCandidates(analyser, fen, candidates, o, evalDb = null, report = null) {
  const applied = []
  for (const m of candidates) {
    const a = applyUci(fen, m.uci)
    if (a) applied.push({ stats: m, ...a })
  }
  if (!applied.length) return []

  // Take what the index already knows before starting an engine. Measured over
  // a partial v2 build: **96.7%** of these positions are in it, at median depth
  // 34 against the ~26 a 4M-node search reaches — so the engine was mostly
  // re-deriving a *worse* answer than the one on disk. Only the misses are
  // searched, which is where the budget belongs.
  const results = new Array(applied.length)
  const misses = []
  for (const [i, a] of applied.entries()) {
    const hit = evalDb ? evalDb.query(a.fen) : null
    if (hit?.lines?.length && hit.depth >= MIN_INDEX_DEPTH) {
      results[i] = hit
      if (report) report.candidateSource.cloud++
    } else {
      misses.push(i)
      if (report) report.candidateSource.local++
    }
  }
  if (misses.length) {
    const searched = await analyser.analyseAll(
      misses.map((i) => applied[i].fen),
      { nodes: o.deepNodes, multipv: 1 },
    )
    for (const [n, i] of misses.entries()) results[i] = searched[n]
  }

  const out = []
  for (const [i, a] of applied.entries()) {
    const line = results[i]?.lines?.[0]
    if (!line) continue
    // The child's score is from the *replier's* view; negate for the mover's.
    out.push({
      ...a,
      moverWp: winPercent(negate(line.score)),
      score: line.score,
      depth: results[i].depth ?? 0,
    })
  }
  return out
}

/**
 * One analyser interface whichever the caller supplied.
 *
 * With a pool the candidates go out together; without one they run in sequence
 * exactly as before, so a crawl with no pool is unchanged.
 */
function asAnalyser(engine, pool) {
  if (pool) return { analyseAll: (fens, o) => pool.analyseAll(fens, o) }
  return {
    async analyseAll(fens, o) {
      const out = []
      for (const fen of fens) out.push(await engine.analyse(fen, o))
      return out
    },
  }
}

export async function crawl(config) {
  const o = { ...DEFAULTS, ...config }
  const { engine, explorer, canon = null, evalDb = null, pool = null, ourColor, forcedLine = [] } = o

  // Candidate evaluations go out as a batch when a pool was supplied; without
  // one they run in sequence exactly as before.
  const analyser = asAnalyser(engine, pool)

  // Deep evaluations in front of this crawl's own search, for the soundness
  // gate only — see soundness.mjs for why trap scoring and the quiet test are
  // deliberately left alone.
  const gate = createSoundnessGate({ evalDb })

  // The cap is checked before the quiet test, so a floor at or above it makes
  // the quiet test unreachable: every line ends on the cap and the tree has no
  // trainable position in it, reported as a successful crawl.
  //
  // Only guarded when the cap was left to the default, which is the shape the
  // mistake actually takes — raising the floor and not noticing the cap it now
  // meets. A caller that sets both has said what it wants; the tests use
  // `minPly: 99, maxPly: 6` to mean "never stop early", and that is legitimate.
  if (config.maxPly === undefined && o.minPly >= o.maxPly) {
    throw new Error(
      `minPly (${o.minPly}) is at or above the default maxPly (${o.maxPly}) — ` +
        `no line could end quiet. Raise maxPly too, or pass it explicitly.`,
    )
  }

  /**
   * `SAN line → branch id` for subtrees another manifest entry owns. Empty for a
   * standalone crawl; see src/domain/repertoirePlan.ts for how a multi-branch
   * build derives it, and why a repertoire needs it at all.
   */
  const delegations = o.delegations instanceof Map ? o.delegations : new Map(Object.entries(o.delegations ?? {}))

  /**
   * `fenKey → branch id` for positions another branch has already decided.
   *
   * `delegations` is keyed on the SAN line and so cannot see a transposition:
   * `1.d4 e6 2.c4 d5` and `1.d4 d5 2.c4 e6` are the same board reached two
   * ways. The sweeper answered 3.Nc3 and the QGD Exchange branch 3.cxd5, and
   * En Croissant's trainer keeps whichever card it walked first — so it
   * demanded one move while showing the other as a legitimate line. One
   * position, two answers, which is the single thing a repertoire may not have.
   */
  const ownedPositions =
    o.ownedPositions instanceof Map ? o.ownedPositions : new Map(Object.entries(o.ownedPositions ?? {}))

  const nodes = new Map()
  const report = {
    expanded: 0,
    terminal: { quiet: 0, 'depth-cap': 0, 'out-of-book': 0, 'no-sound-move': 0, delegated: 0 },
    delegated: [],
    /** Positions handed over because another branch reached them first. */
    transposed: [],
    traps: [],
    truncatedNodes: [],
    outOfBook: [],
    engineFallbacks: [],
    tooRareToJudge: [],
    /** Which source decided each expanded node — canon (masters) vs band. */
    moveSource: { canon: 0, band: 0 },
    /**
     * Which source gated each of our decisions — the evaluation index vs this
     * search. Counted once per decision, on the move actually chosen: counting
     * every candidate would make a node with twenty candidates worth twenty,
     * and the number would no longer answer "how much of this repertoire rests
     * on a depth-50 search".
     */
    gateSource: { cloud: 0, local: 0 },
    /** Where each candidate's evaluation came from — the index vs an engine search. */
    candidateSource: { cloud: 0, local: 0 },
    /** Where the baseline each candidate is measured against came from. */
    bestSource: { cloud: 0, local: 0 },
    /**
     * Evidence on whether the shallow search still earns its place. `decided`
     * counts positions this filter alone kept from going quiet. If it stays at
     * zero across a full build, the test is buying a search per node for
     * nothing at these budgets — it fired 0 times in 96 sampled positions, but
     * that sample came from an already-quiet shipped repertoire, so this
     * records the distribution over positions the crawl genuinely rejects.
     */
    tacticGap: { enabled: false, tested: 0, skipped: 0, decided: 0, total: 0, max: 0 },
    unpunishedTraps: [],
    unverifiedTraps: [],
    minDepth: Infinity,
  }

  /**
   * Trap children awaiting confirmation that the punishment is real. A trap is
   * only worth drilling if our reply actually leaves us better; one that merely
   * equalises would be memorised as a win and reached as an equal game.
   */
  const awaitingPunishment = new Map()

  const root = new Chess()
  /** Follow the curated prefix verbatim before the crawler starts choosing. */
  const forcedSans = []
  for (const san of forcedLine) {
    // chess.js *throws* on an illegal SAN rather than returning falsy, so the
    // bare `if (!m)` this used to rely on never fired and the user got
    // "Invalid move: d4" with no hint that --line was at fault.
    let m
    try {
      m = root.move(san)
    } catch (err) {
      throw new Error(
        `illegal move in --line: "${san}" after ${forcedSans.join(' ') || 'the start'}`,
        { cause: err },
      )
    }
    if (!m) throw new Error(`illegal move in --line: ${san}`)
    forcedSans.push(m.san)
  }
  const rootFen = root.fen()
  const basePly = forcedSans.length

  const queue = [{ fen: rootFen, ply: basePly, line: [...forcedSans] }]

  /**
   * Queue a move's position, unless another branch of the manifest owns it.
   *
   * The boundary is handled here rather than when the position is dequeued so
   * that a delegated trap never enters `awaitingPunishment`: its refutation is
   * crawled and verified in the owning branch, and reporting it as "unverified"
   * here would be a warning about work that has in fact been done. Returns true
   * when it was delegated, and records the branch on the move so the PGN can
   * point at it.
   */
  const enqueue = (child, fen, ply, line) => {
    const owner = delegations.get(line.join(' '))
    if (!owner) {
      queue.push({ fen, ply, line })
      return false
    }
    if (child) child.delegatedTo = owner
    const key = fenKey(fen)
    if (!nodes.has(key)) {
      const sideToMove = new Chess(fen).turn()
      nodes.set(key, {
        fen,
        ply,
        sideToMove,
        ours: sideToMove === ourColor,
        line,
        children: [],
        terminal: true,
        terminalReason: 'delegated',
        delegatedTo: owner,
      })
      report.terminal.delegated++
      report.delegated.push({ line: line.join(' '), to: owner })
    }
    return true
  }

  /**
   * Settle a trap's punishment from a win% we already have. Must be reachable
   * from every path that leaves a node, not just the fully-expanded one: the
   * check used to sit after the transposition and depth-cap `continue`s, so a
   * trap landing on either left `punished` undefined — and undefined rendered
   * exactly like a verified trap.
   */
  const settlePunishment = (nodeKey, winPercent, line) => {
    const pending = awaitingPunishment.get(nodeKey)
    if (!pending) return
    awaitingPunishment.delete(nodeKey)
    if (winPercent === null) {
      report.unverifiedTraps.push({ line: pending.line, why: line })
      return
    }
    pending.child.afterReplyWinPercent = Number(winPercent.toFixed(1))
    pending.child.punished = isPunished(winPercent)
    if (!pending.child.punished) {
      report.unpunishedTraps.push({
        line: pending.line,
        afterReplyWinPercent: Number(winPercent.toFixed(1)),
      })
    }
  }

  while (queue.length) {
    const item = queue.shift()
    const key = fenKey(item.fen)
    if (nodes.has(key)) {
      // Transposition: the position was already assessed, so its win% answers
      // the pending question directly — no second engine call needed.
      const seen = nodes.get(key)
      settlePunishment(
        key,
        typeof seen.bestWinPercent === 'number' ? seen.bestWinPercent : null,
        'transposed into a position assessed before the trap was queued',
      )
      continue
    }

    // A position another branch already decided. Stopping beats answering it
    // again: two branches that disagree give the trainer two answers, and two
    // that agree just make you drill the same line twice.
    const ownedBy = item.ply > basePly ? ownedPositions.get(key) : undefined

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

    if (ownedBy) {
      node.terminal = true
      node.terminalReason = 'delegated'
      node.delegatedTo = ownedBy
      report.terminal.delegated++
      report.transposed.push({ line: item.line.join(' '), to: ownedBy })
      settlePunishment(key, null, `transposed into the "${ownedBy}" line, which covers it`)
      continue
    }

    if (item.ply >= o.maxPly) {
      node.terminal = true
      node.terminalReason = 'depth-cap'
      report.terminal['depth-cap']++
      settlePunishment(key, null, 'reached the depth cap before it could be assessed')
      continue
    }

    const { deep, bestWp, quiet } = await assess(engine, item.fen, o, evalDb, report)
    node.bestWinPercent = Number(bestWp.toFixed(2))
    node.quiet = quiet
    if (deep.depth) report.minDepth = Math.min(report.minDepth, deep.depth)

    // We are to move here, so bestWp is *our* standing after the opponent's
    // move. If that move was flagged a trap, this is where we find out whether
    // the punishment exists.
    settlePunishment(key, bestWp, null)

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
    for (const after of await evalCandidates(analyser, item.fen, candidates, o, evalDb, report)) {
      const m = after.stats
      scored.push({
        stats: m,
        san: after.san,
        fen: after.fen,
        swing: Math.max(0, bestWp - after.moverWp),
        depth: after.depth ?? 0,
        expected: after.moverWp / 100,
        frequency: frequency(m, total),
        practical: practicalScore(m, sideToMove),
        // `after.score` is from the replier's view; PGN [%eval] is White's.
        evalCp:
          after.score.type === 'cp'
            ? sideToMove === 'w'
              ? -after.score.value
              : after.score.value
            : undefined,
      })
      if (after.depth) report.minDepth = Math.min(report.minDepth, after.depth)
    }

    if (ours) {
      // One move. Branching cost needs a lookahead into each child's replies.
      const ranked = []
      for (const c of scored) {
        // The evaluation index decides this where it can, and this crawl's own
        // search where it cannot. `rankOurMoves` applies the same gate
        // internally — read from the domain so the two cannot drift apart when
        // the constant is retuned — so it must be handed the *gated* swing
        // rather than the local one, or the two would disagree about which
        // moves are even eligible.
        const gated = gate.swingFor(item.fen, c.stats.uci, { swing: c.swing, depth: c.depth })
        if (gated.swing > SOUNDNESS_MAX_SWING) continue
        const replies = await explorer.query(c.fen)
        const cover = coverByMass(replies.moves, {
          massTarget: o.massTarget,
          minGames: o.minGames,
          maxMoves: o.maxOpponentMoves,
        })
        ranked.push({
          move: c.stats,
          swing: gated.swing,
          gateSource: gated.source,
          gateDepth: gated.depth,
          replyBranching: cover.covered.length,
          // How much data that count rests on — a narrow-looking position that
          // nobody has played is not narrow.
          replyGames: totalGames(replies.moves),
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
        //
        // Prefer the index's answer over this crawl's own search. Rejecting
        // every human move on a depth-50 evaluation and then picking a
        // depth-20 replacement would put the shallowest evidence in the
        // repertoire exactly where the gate was strictest — and a deeper gate
        // reaches this branch *more* often, so the effect grows with the fix.
        const indexed = gate.bestMove(item.fen)
        const chosenUci = indexed?.uci ?? deep.lines[0]?.pv?.[0]
        const applied = chosenUci ? applyUci(item.fen, chosenUci) : null
        if (!applied) {
          node.terminal = true
          node.terminalReason = 'no-sound-move'
          report.terminal['no-sound-move']++
          continue
        }
        report.gateSource[indexed ? 'cloud' : 'local']++
        const fallback = {
          san: applied.san,
          uci: chosenUci,
          fen: applied.fen,
          reason: 'ours-engine',
          gatedBy: indexed ? 'cloud' : 'local',
          gateDepth: indexed?.depth ?? 0,
          swing: 0,
        }
        node.children.push(fallback)
        report.engineFallbacks.push({ line: [...item.line, applied.san].join(' '), san: applied.san })
        enqueue(fallback, applied.fen, item.ply + 1, [...item.line, applied.san])
        continue
      }
      const c = best._c
      const chosen = {
        san: c.san,
        uci: c.stats.uci,
        fen: c.fen,
        reason: 'ours',
        // Only meaningful when a canonical source was configured; then 'band'
        // means we have left master theory behind.
        ...(canon ? { source: bookSource } : {}),
        // The gated swing, not the local one — this is the number the move was
        // actually admitted on, and recording the other would misreport the
        // basis for the decision.
        swing: Number(best.swing.toFixed(2)),
        // Which evaluation admitted it, the way `source` records where the
        // candidates came from. A move gated locally rests on this crawl's node
        // budget; one gated by the index rests on a depth-50 search.
        gatedBy: best.gateSource,
        gateDepth: best.gateDepth,
        frequency: Number(c.frequency.toFixed(4)),
        replyBranching: best.replyBranching,
        score: Number(ourMoveScore(best).toFixed(3)),
      }
      report.gateSource[best.gateSource]++
      node.children.push(chosen)
      enqueue(chosen, c.fen, item.ply + 1, [...item.line, c.san])
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
          games: gamesFor(c.stats),
        }
        const tv = trapValue(t)
        const byMass = coveredUcis.has(c.stats.uci)
        const byTrap = isTrap(t, o.trapThreshold)

        // A move that looks like a trap but has too few games to judge is
        // reported rather than dropped: it might be the vicious rare line, and
        // silently discarding it would read as "there is nothing here".
        // Shrunk, not raw: this branch only fires below TRAP_MIN_GAMES, which is
        // exactly where a raw practical-vs-expected gap is least meaningful.
        if (
          !byTrap &&
          t.swing >= TRAP_MIN_SWING &&
          t.games < TRAP_MIN_GAMES &&
          outperformance(t) > 0
        ) {
          report.tooRareToJudge.push({
            line: [...item.line, c.san].join(' '),
            games: t.games,
            swing: Number(t.swing.toFixed(1)),
            practical: Number(t.practical.toFixed(3)),
          })
        }
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

        const child = {
          san: c.san,
          uci: c.stats.uci,
          fen: c.fen,
          reason: byTrap && !byMass ? 'trap' : byTrap ? 'mass+trap' : 'mass',
          swing: Number(c.swing.toFixed(2)),
          frequency: Number(c.frequency.toFixed(4)),
          trapValue: Number(tv.toFixed(4)),
          games: t.games,
          practical: Number(c.practical.toFixed(3)),
          expected: Number(c.expected.toFixed(3)),
          evalCp: c.evalCp,
        }
        node.children.push(child)
        const handedOff = enqueue(child, c.fen, item.ply + 1, [...item.line, c.san])
        // Verified when we reach the position after it — see awaitingPunishment.
        // Not when another branch owns it: that branch does the verifying.
        if (byTrap && !handedOff) {
          awaitingPunishment.set(fenKey(c.fen), {
            child,
            line: [...item.line, c.san].join(' '),
          })
        }
      }
    }
  }

  // Anything still pending never reached a node we could measure. Say so
  // rather than dropping it: silence here would read as "verified".
  for (const [, pending] of awaitingPunishment) {
    report.unverifiedTraps.push({ line: pending.line, why: 'its follow-up position was never reached' })
  }
  awaitingPunishment.clear()

  report.traps.sort((a, b) => b.trapValue - a.trapValue)

  // Candidates the index scored *above* its own first line. That is impossible
  // if the stored pvs are ordered best-first, which every swing here assumes,
  // so a non-zero count means the gate has been comparing against something
  // that is not the best move — and because the swing is clamped at zero, the
  // symptom is candidates passing rather than anything failing.
  report.gateMisordered = gate.stats().misordered
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
  --eval-index db/eval-index       gate our moves on the local Lichess
                                   evaluation index (median depth 50) instead
                                   of --nodes, falling back to the engine where
                                   a position is absent. See issue #106.
  --pool    10                     engines evaluating candidates in parallel.
                                   Each stays single-threaded, so results are
                                   identical to a serial run and only the wall
                                   clock changes. Defaults to a size derived
                                   from cores and RAM; 1 disables it.
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
  // Created after the pool below, so it can be told how many engines it shares
  // the machine with — see build.mjs for the failure that taught us.
  let engine

  // Optional, and absent means the old behaviour exactly: the gate falls back
  // to this crawl's own search for every decision.
  const evalDb = args['eval-index'] ? createEvalDb({ dir: String(args['eval-index']) }) : null

  // The candidate fan-out at each node is the only parallelisable part of a
  // crawl, and it is most of the engine time. `--pool 1` falls back to the
  // serial path for a like-for-like comparison.
  const poolSize = args.pool ? Number(args.pool) : undefined
  const pool =
    poolSize === 1
      ? null
      : createEnginePool({ size: poolSize, path: args.engine ? String(args.engine) : undefined })
  engine = createEngine({
    path: args.engine ? String(args.engine) : undefined,
    share: (pool?.size ?? 0) + 1,
  })

  const started = Date.now()
  console.log(`crawling ${ourColor === 'w' ? 'White' : 'Black'} from: ${forcedLine.join(' ') || '(start)'}`)

  try {
    const result = await crawl({
      engine,
      explorer,
      canon,
      evalDb,
      pool,
      ourColor,
      forcedLine,
      maxPly: args['max-ply'] ? Number(args['max-ply']) : undefined,
      minPly: args['min-ply'] ? Number(args['min-ply']) : undefined,
      deepNodes: args.nodes ? Number(args.nodes) : undefined,
      massTarget: args.mass ? Number(args.mass) : undefined,
      trapThreshold: args.trap ? Number(args.trap) : undefined,
      tacticGap: Boolean(args['tactic-gap']),
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
        options: { ...result.options, engine: undefined, explorer: undefined, evalDb: undefined, pool: undefined },
      },
      report: {
        ...result.report,
        // Infinity serialises as null, which reads as "depth 0" downstream.
        minDepth: Number.isFinite(result.report.minDepth) ? result.report.minDepth : null,
      },
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
        provenance: {
          // Basename only — the full path leaks a home directory into a file
          // that is meant to be shareable.
          engine: basename(args.engine ? String(args.engine) : DEFAULT_ENGINE_PATH),
          nodes: result.options.deepNodes,
          threads: 1,
          minDepth: Number.isFinite(result.report.minDepth) ? result.report.minDepth : undefined,
        },
      }),
      'utf8',
    )

    const r = result.report
    const secs = ((Date.now() - started) / 1000).toFixed(0)
    console.log(`
── done in ${secs}s ─────────────────────────────
positions       ${result.nodes.size}   (expanded ${r.expanded})
terminal        quiet ${r.terminal.quiet} · depth-cap ${r.terminal['depth-cap']} · out-of-book ${r.terminal['out-of-book']}${r.terminal.delegated ? ` · delegated ${r.terminal.delegated}` : ''}
decided by      ${canon ? `masters ${r.moveSource.canon} · band ${r.moveSource.band}` : `band only (no canonical source)`}
gated by        ${evalDb ? `index ${r.gateSource.cloud} · local search ${r.gateSource.local}` : `local search only (no --eval-index)`}
engine searches ${engine.searchCount() + (pool?.searchCount() ?? 0)}${pool ? ` (${pool.size} engines in parallel)` : ''}
explorer        ${JSON.stringify(explorer.stats())}
traps found     ${r.traps.length}${r.gateMisordered ? `\n⚠ ordering      ${r.gateMisordered} candidate(s) scored above the index's own best line — the gate's baseline is suspect` : ''}`)

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
    if (r.unverifiedTraps.length) {
      console.log(`
? ${r.unverifiedTraps.length} trap(s) whose punishment could not be verified:`)
      for (const t of r.unverifiedTraps) console.log(`  ${t.line}   [${t.why}]`)
    }
    if (r.unpunishedTraps.length) {
      console.log(`
⚠ ${r.unpunishedTraps.length} trap(s) we could not actually punish:`)
      for (const t of r.unpunishedTraps) {
        console.log(`  ${t.line}   [only ${t.afterReplyWinPercent}% after our reply]`)
      }
    }
    if (r.tooRareToJudge.length) {
      console.log(
        `
${r.tooRareToJudge.length} line(s) look like traps but have under ${TRAP_MIN_GAMES} games — too few to judge:`,
      )
      for (const t of r.tooRareToJudge.slice(0, 8)) {
        console.log(`  ${t.line}   [n=${t.games}, -${t.swing} win%, scored ${(t.practical * 100).toFixed(0)}%]`)
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
    await pool?.quit()
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
