// Grade every move you have played across your public chess.com archive.
//
//   node scripts/coach/archive.mjs --me <handle> --limit 3
//   node scripts/coach/archive.mjs --me <handle>            # the full archive
//
// Set CHESSCOM_USER instead and --me can be dropped. The handle is deliberately
// not written down here: this repo is public, and it is the owner's to publish
// or not.
//
// This is the I/O shell — fetch, drive Stockfish, append rows. Every judgment
// over the rows lives in src/domain/coachReport.ts, and the *grading* is the
// trainer's own: `gradeMove` on two evaluations expressed from the mover's
// perspective, exactly as src/engine/grading.ts does it. A second scale here
// would produce numbers that cannot be compared to `npm run review`, which is
// worse than producing none.
//
// A FULL RUN IS HOURS. It is resumable per game — a crash costs the game in
// flight and nothing else — so it is meant to be left going and re-run, not
// babysat. Use --limit to try it.
//
// Stockfish comes from scripts/repertoire/engine.mjs, so STOCKFISH_PATH applies.

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { Chess } from 'chess.js'
import { eachGame } from '../chesscom.mjs'
import { createEnginePool } from '../repertoire/enginePool.mjs'
import { gradeMove } from '../../src/domain/grade.ts'
import { negate } from '../../src/domain/winPercent.ts'
import { parseTimeControl, secondsPerMove } from '../../src/domain/gameReview.ts'
import { phaseOf } from '../../src/domain/accuracy.ts'

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}

const ME = (arg('me') ?? process.env.CHESSCOM_USER ?? '').toLowerCase()
// The same budget scripts/review/game.mjs uses, and for the same measured
// reason: at 800k a real Tier B mistake read as clean and the total win% given
// away was understated by 10%. A cheap pass errs by MISSING mistakes, which is
// the worse direction for coaching. Do not lower this to make a full run fit an
// evening — run fewer games instead, so the ones you have are comparable to the
// per-game reviews.
const NODES = Number(arg('nodes', 4_000_000))
const OUT = arg('out', 'out/coach/archive.jsonl')
const LIMIT = Number(arg('limit', Infinity))
const SINCE = arg('since') // YYYY/MM
// Rapid and daily are the owner's current chess. Blitz is in the archive 5:1 and
// two rating bands below, so it is opt-in: `--time-class blitz` analyses it as
// its own sample, never as part of another. Nothing downstream will pool them —
// coachReport.bucketsBy throws — but the cheapest place to not mix them is here.
const TIME_CLASSES = String(arg('time-class', 'rapid,daily'))
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

function usage(message) {
  console.error(`${message}

  node scripts/coach/archive.mjs --me <chess.com user> [options]

  --time-class <list>  comma-separated; default "rapid,daily". NEVER analysed
                       as a pool — one sample per class (coach skill, rule 1)
  --limit <n>          stop after n games; how you try this without an
                       hours-long run
  --since <YYYY/MM>    ignore archive months older than this
  --nodes <n>          engine budget per position (default 4000000, across a
                       pool of single-threaded engines)
  --out <file>         JSON-lines output (default out/coach/archive.jsonl),
                       appended to and resumed from

  --me defaults to $CHESSCOM_USER.`)
  process.exit(2)
}

if (!ME) usage('Whose archive is this? Pass --me or set CHESSCOM_USER.')
if (!TIME_CLASSES.length) usage('--time-class needs at least one class.')

/**
 * Game ids already in the output file.
 *
 * One JSON object per LINE per GAME, not per move. A game is appended in a
 * single write, so a kill mid-append can only ever tear the last line — which
 * fails to parse and is dropped here, costing that one game on the next run. Per
 * move it would be a torn record indistinguishable from a complete one.
 */
function alreadyDone(path) {
  const done = new Set()
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return done // no file yet: nothing done
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const row = JSON.parse(line)
      if (row.gameId) done.add(row.gameId)
    } catch {
      // A torn tail from an interrupted run. Skipping it re-analyses that game.
    }
  }
  return done
}

const plural = (n, one) => `${n} ${one}${n === 1 ? '' : 's'}`

/** Pieces on the board, both sides, kings included. */
function pieceCount(fen) {
  return (fen.split(' ')[0].match(/[a-zA-Z]/g) ?? []).length
}

/** A capture or a check — the two things that make a move forcing. */
function isForcing(move) {
  return Boolean(move.captured) || move.san.includes('+') || move.san.includes('#')
}

/**
 * Everything about the *position* the base-rate check needs, computed once here
 * so `coachReport.pieceMatchBaseline` can compare against chance on the same
 * positions rather than on an invented denominator.
 *
 * `bestPieceMoves` is the count of legal moves belonging to the engine's best
 * move's from-square. That is the right denominator and the obvious alternative
 * — one over the number of movable pieces — is wrong: a queen with nine legal
 * moves is nine chances to agree with the engine by accident.
 */
function positionShape(fen, bestSan) {
  const chess = new Chess(fen)
  const legal = chess.moves({ verbose: true })
  const froms = new Set(legal.map((m) => m.from))
  let bestFrom = null
  if (bestSan) {
    try {
      bestFrom = new Chess(fen).move(bestSan).from
    } catch {
      bestFrom = null // engine gave something we could not replay; treated as "no best"
    }
  }
  return {
    legalMoves: legal.length,
    movablePieces: froms.size,
    bestFrom,
    bestPieceMoves: bestFrom ? legal.filter((m) => m.from === bestFrom).length : null,
  }
}

const tagFrom = (pgn, name) => new RegExp(`\\[${name} "([^"]*)"\\]`).exec(pgn)?.[1] ?? null

/**
 * chess.com reports a per-player result naming *how* it ended, not just what it
 * was: `win`, or one of a dozen loss reasons, or one of six draw reasons. The
 * draws have to be listed — a default of "loss" for anything that is not "win"
 * would file every agreed draw as a defeat, and the result slice would then be
 * describing something that never happened.
 */
const DRAWS = new Set(['agreed', 'repetition', 'stalemate', 'insufficient', 'timevsinsufficient', '50move'])
const ownResult = (raw) => (raw === 'win' ? 'win' : DRAWS.has(raw) ? 'draw' : 'loss')

/**
 * Grade one game, or return null with a reason when it cannot be graded.
 * Analysing a whole game's positions in one pooled batch is what makes 4M nodes
 * affordable (see enginePool.mjs) — and every position is needed anyway, since
 * the evaluation before your move N+1 is the evaluation after your move N.
 */
async function gradeGame(pool, game, onProgress) {
  const pgn = game.pgn ?? ''
  const white = tagFrom(pgn, 'White')
  const black = tagFrom(pgn, 'Black')
  if (![white, black].some((n) => n?.toLowerCase() === ME)) return null
  const myColor = white?.toLowerCase() === ME ? 'w' : 'b'

  const loader = new Chess()
  try {
    loader.loadPgn(pgn)
  } catch {
    return null
  }
  const sans = loader.history()
  if (!sans.length) return null

  // Clocks, exactly as the single-game review reads them. chess.com's
  // correspondence TimeControl ("1/259200") is a per-move allowance rather than
  // a game budget, so parseTimeControl returns null and every daily move is
  // recorded unclocked instead of with invented seconds.
  const clocks = [...pgn.matchAll(/\[%clk (\d+):(\d+):([\d.]+)\]/g)].map(
    (m) => Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]),
  )
  const tc = parseTimeControl(tagFrom(pgn, 'TimeControl') ?? '')
  const seconds = tc && clocks.length === sans.length ? secondsPerMove(clocks, tc) : sans.map(() => null)

  const board = new Chess()
  const fens = [board.fen()]
  for (const san of sans) {
    board.move(san)
    fens.push(board.fen())
  }

  // Which positions actually need the engine. A position the game has already
  // ended in has no evaluation to have.
  const needed = []
  const source = []
  for (let i = 0; i < fens.length; i++) {
    if (new Chess(fens[i]).isGameOver()) continue
    needed.push(fens[i])
    source.push(i)
  }
  const analysed = await pool.analyseAll(needed, { nodes: NODES, multipv: 1 }, onProgress)

  const evals = new Array(fens.length).fill(null)
  const bestSans = new Array(fens.length).fill(null)
  for (let k = 0; k < analysed.length; k++) {
    const i = source[k]
    const line = analysed[k].lines[0]
    if (!line) throw new Error(`engine returned nothing for ${fens[i]}`)
    evals[i] = line.score
    const uci = analysed[k].bestMove ?? line.pv?.[0] ?? null
    if (uci) {
      try {
        bestSans[i] = new Chess(fens[i]).move({
          from: uci.slice(0, 2),
          to: uci.slice(2, 4),
          promotion: uci[4],
        }).san
      } catch {
        bestSans[i] = null
      }
    }
  }

  const eco = tagFrom(pgn, 'ECOUrl')?.split('/').pop() ?? tagFrom(pgn, 'ECO')
  const mine = myColor === 'w' ? game.white : game.black
  const result = ownResult(mine?.result)

  const moves = []
  for (let ply = 0; ply < sans.length; ply++) {
    if (ply % 2 !== (myColor === 'w' ? 0 : 1)) continue
    const before = evals[ply]
    if (!before) continue // the game had already ended here

    // Exactly engine/grading.ts's rule. The played evaluation is the engine's
    // reading of the position AFTER the move, negated back to the mover; a
    // terminal position is scored without the engine, because a move that
    // delivers mate must be graded on the mate.
    const after = new Chess(fens[ply + 1])
    let played
    if (after.isCheckmate()) played = { type: 'mate', value: 1 }
    else if (after.isGameOver()) played = { type: 'cp', value: 0 }
    else if (evals[ply + 1]) played = negate(evals[ply + 1])
    else continue
    const { swing, tier } = gradeMove(before, played)

    const applied = new Chess(fens[ply]).move(sans[ply])
    const bestSan = bestSans[ply]
    let bestMove = null
    if (bestSan) {
      try {
        bestMove = new Chess(fens[ply]).move(bestSan)
      } catch {
        bestMove = null
      }
    }
    const shape = positionShape(fens[ply], bestSan)

    moves.push({
      ply,
      moveNumber: Math.floor(ply / 2) + 1,
      phase: phaseOf(fens[ply]),
      san: applied.san,
      best: bestSan,
      swing,
      tier,
      forcingPlayed: isForcing(applied),
      forcingBest: bestMove ? isForcing(bestMove) : false,
      piece: applied.piece,
      samePiece: shape.bestFrom ? applied.from === shape.bestFrom : null,
      legalMoves: shape.legalMoves,
      movablePieces: shape.movablePieces,
      bestPieceMoves: shape.bestPieceMoves,
      pieces: pieceCount(fens[ply]),
      seconds: seconds[ply] ?? null,
    })
  }

  return {
    gameId: String(game.url ?? '').split('/').pop() ?? game.url,
    url: game.url,
    endTime: game.end_time ?? null,
    timeClass: game.time_class,
    timeControl: tagFrom(pgn, 'TimeControl'),
    color: myColor,
    result,
    myRating: mine?.rating ?? null,
    opponentRating: (myColor === 'w' ? game.black : game.white)?.rating ?? null,
    eco,
    nodes: NODES,
    moves,
  }
}

// --- run --------------------------------------------------------------------
mkdirSync(dirname(OUT), { recursive: true })
const done = alreadyDone(OUT)
console.error(
  `${ME}'s archive · ${TIME_CLASSES.join(', ')} · ${NODES} nodes/position\n` +
    `  ${plural(done.size, 'game')} already in ${OUT}` +
    `${Number.isFinite(LIMIT) ? ` · stopping after ${LIMIT} new` : ''}`,
)

const pool = createEnginePool()
let graded = 0
let skipped = 0
try {
  for await (const game of eachGame({ user: ME, timeClasses: TIME_CLASSES, since: SINCE })) {
    if (graded >= LIMIT) break
    const id = String(game.url ?? '').split('/').pop()
    if (done.has(id)) {
      skipped += 1
      continue
    }
    const started = Date.now()
    // A game is minutes of engine at 4M nodes; a run with no output for that
    // long looks hung, and this run is meant to be left going for hours.
    const row = await gradeGame(pool, game, (n, total) =>
      process.stderr.write(`\r  ${id} · ${n}/${total} positions · ${pool.size} engines   `),
    )
    process.stderr.write('\r')
    if (!row) {
      console.error(`  ${id}: not gradable (not ${ME}'s game, or no moves) — skipped`)
      continue
    }
    // One line, one write, one game: see alreadyDone().
    appendFileSync(OUT, `${JSON.stringify(row)}\n`)
    graded += 1
    console.error(
      `  ${graded}. ${id} ${row.timeClass} ${row.color === 'w' ? 'W' : 'B'} ${row.result}` +
        ` · ${plural(row.moves.length, 'move')} of yours · ${Math.round((Date.now() - started) / 1000)}s`,
    )
  }
} finally {
  await pool.quit()
}

console.error(
  `\ndone — ${plural(graded, 'game')} graded, ${skipped} already had. Report with:\n  npm run coach`,
)
