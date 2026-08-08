// Review one finished game of your own, move by move.
//
//   npm run review -- --me quiet_etude --last
//   npm run review -- --me quiet_etude https://www.chess.com/game/live/172720428582
//   npm run review -- --me quiet_etude --pgn some-game.pgn
//
// The grading rule is the trainer's, not a second one invented here: win% swing
// with Tier A for engine-equal (src/domain/gameReview.ts, ADR 0010). This file
// is the I/O shell — fetch a game, drive Stockfish, print — and holds no
// judgment of its own.
//
// Stockfish comes from scripts/repertoire/engine.mjs, so STOCKFISH_PATH applies
// here too; without it the En Croissant install is used.

import { readFileSync } from 'node:fs'
import { Chess } from 'chess.js'
import { createEngine } from '../repertoire/engine.mjs'
import {
  chancesGiven,
  parseTimeControl,
  reviewGame,
  secondsPerMove,
  summariseByPhase,
} from '../../src/domain/gameReview.ts'
import { comparePieceValues } from '../../src/engine/evalTable.ts'
import { judgeTablebase, pieceCount, tablebaseEligible } from '../../src/domain/tablebase.ts'
import { winPercent, negate } from '../../src/domain/winPercent.ts'

const USER_AGENT = 'etude-chess game review (https://github.com/jahales/etude-chess)'

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}
const flag = (name) => process.argv.includes(`--${name}`)

const ME = (arg('me') ?? process.env.CHESSCOM_USER ?? '').toLowerCase()
const NODES = Number(arg('nodes', 800_000))
const PGN_FILE = arg('pgn')

/** The bare game id out of a chess.com URL, or the argument if it is already one. */
function gameId(value) {
  const m = /(\d{6,})/.exec(value ?? '')
  return m ? m[1] : null
}

async function json(url) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`)
  return res.json()
}

/**
 * Find a game in the player's public archives, newest month first. There is no
 * public endpoint that takes a game id, so this is a scan — it stops at the
 * first hit, which for a game you just played is the first request.
 */
async function fetchGame({ user, id, last }) {
  const { archives } = await json(`https://api.chess.com/pub/player/${user}/games/archives`)
  for (const month of [...archives].reverse()) {
    const { games } = await json(month)
    if (last) {
      if (games.length) return games[games.length - 1]
      continue
    }
    const hit = games.find((g) => gameId(g.url) === id)
    if (hit) return hit
  }
  return null
}

function usage(message) {
  console.error(`${message}

  npm run review -- --me <chess.com user> --last
  npm run review -- --me <chess.com user> <game url or id>
  npm run review -- --me <name> --pgn <file.pgn>

  --nodes <n>       engine budget per position (default 800000)
  --deep            re-examine each imperfect move: alternatives with
                    win/draw/loss, which piece changed, and — under eight
                    pieces — the tablebase's exact verdict
  --deep-nodes <n>  budget for that pass (default 6000000)

  --me defaults to $CHESSCOM_USER.`)
  process.exit(2)
}

// --- load the game ----------------------------------------------------------
if (!ME) usage('Which player is being reviewed? Pass --me or set CHESSCOM_USER.')

// A flag's *value* is not a positional. Without this, `--nodes 800000` reads as
// a game id — it is six digits — and the archive scan hunts for a game that
// does not exist.
const VALUED = new Set(['--me', '--nodes', '--pgn', '--deep-nodes'])
const positionals = []
for (let i = 0, argv = process.argv.slice(2); i < argv.length; i++) {
  if (VALUED.has(argv[i])) i++
  else if (!argv[i].startsWith('--')) positionals.push(argv[i])
}
const positional = positionals.find((a) => gameId(a))
let pgn
let meta = {}

if (PGN_FILE) {
  pgn = readFileSync(PGN_FILE, 'utf8')
} else {
  const id = gameId(positional)
  if (!id && !flag('last')) usage('Give a chess.com game URL or id, or --last, or --pgn <file>.')
  const game = await fetchGame({ user: ME, id, last: flag('last') })
  if (!game) usage(`No game ${id ?? ''} found in ${ME}'s public archives.`)
  pgn = game.pgn
  meta = game
}

const tag = (name) => new RegExp(`\\[${name} "([^"]*)"\\]`).exec(pgn)?.[1] ?? null
const white = tag('White')
const black = tag('Black')
if (![white, black].some((n) => n?.toLowerCase() === ME)) {
  usage(`"${ME}" did not play this game (${white} vs ${black}). Check --me.`)
}
const myColor = white?.toLowerCase() === ME ? 'w' : 'b'

const loader = new Chess()
loader.loadPgn(pgn)
const sans = loader.history()
if (!sans.length) usage('That PGN has no moves in it.')

// --- clocks -----------------------------------------------------------------
// One reading per ply, in play order, from the [%clk] comments chess.com writes.
const clockText = [...pgn.matchAll(/\[%clk (\d+):(\d+):([\d.]+)\]/g)].map(
  (m) => Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]),
)
const tc = parseTimeControl(tag('TimeControl') ?? '')
const seconds =
  tc && clockText.length === sans.length
    ? secondsPerMove(clockText, tc)
    : sans.map(() => null)

// --- evaluate every position exactly once -----------------------------------
const board = new Chess()
const fens = [board.fen()]
for (const san of sans) {
  board.move(san)
  fens.push(board.fen())
}

const engine = createEngine()
const positions = []
const best = []
for (let i = 0; i < fens.length; i++) {
  const at = new Chess(fens[i])
  if (at.isGameOver()) {
    positions.push({ kind: 'over', result: at.isCheckmate() ? 'checkmate' : 'draw' })
    best.push(null)
    continue
  }
  const { lines, bestMove } = await engine.analyse(fens[i], { nodes: NODES, multipv: 1 })
  if (!lines[0]) throw new Error(`engine returned nothing for ${fens[i]}`)
  positions.push({ kind: 'eval', score: lines[0].score })
  const uci = bestMove ?? lines[0].pv?.[0] ?? null
  let san = null
  if (uci) {
    try {
      san = new Chess(fens[i]).move({
        from: uci.slice(0, 2),
        to: uci.slice(2, 4),
        promotion: uci[4],
      }).san
    } catch {
      san = uci
    }
  }
  best.push(san)
  process.stderr.write(`\r  ${i + 1}/${fens.length} positions at ${NODES} nodes`)
}
process.stderr.write('\n')

const rows = reviewGame({ sans, positions, myColor, best, seconds })
const mine = rows.filter((r) => r.mine)
const theirs = rows.filter((r) => !r.mine)

// --- report -----------------------------------------------------------------
const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(0)}%` : '-')
const num = (v, places = 1) => (v == null ? '—' : v.toFixed(places))
const moveLabel = (r) => `${r.moveNumber}${r.color === 'w' ? '.' : '…'} ${r.san}`

console.log(`\n${white} (${tag('WhiteElo') ?? '?'}) vs ${black} (${tag('BlackElo') ?? '?'})`)
console.log(
  `${meta.time_class ?? ''} ${tag('TimeControl') ?? ''} · ` +
    `${tag('ECOUrl')?.split('/').pop() ?? tag('ECO') ?? ''} · you are ${myColor === 'w' ? 'White' : 'Black'}`,
)
console.log(tag('Termination') ?? tag('Result') ?? '')
if (!tc) console.log('(no usable clock data — time columns omitted)')

console.log(`\n=== move quality, ${NODES} nodes/position ===`)
console.log('               A (best)     B (concession)   C (mistake)')
for (const [who, set] of [
  ['you     ', mine],
  ['opponent', theirs],
]) {
  const [a, b, c] = ['A', 'B', 'C'].map((t) => set.filter((r) => r.tier === t).length)
  console.log(
    `  ${who}  ${String(a).padStart(3)} ${pct(a, set.length).padStart(5)}     ` +
      `${String(b).padStart(3)} ${pct(b, set.length).padStart(5)}       ` +
      `${String(c).padStart(3)} ${pct(c, set.length).padStart(5)}`,
  )
}
console.log(
  `\n  win% given away — you ${num(mine.reduce((t, r) => t + r.swing, 0), 0)}, ` +
    `opponent ${num(theirs.reduce((t, r) => t + r.swing, 0), 0)}`,
)

console.log('\n=== where it leaked, against where the time went ===')
console.log('  phase        moves   win% lost   per move   sec/move')
for (const p of summariseByPhase(mine)) {
  if (!p.moves) continue
  console.log(
    `  ${p.name.padEnd(12)} ${String(p.moves).padStart(4)}   ` +
      `${num(p.swing).padStart(8)}   ${num(p.swingPerMove, 2).padStart(8)}   ` +
      `${num(p.secondsPerMove, 0).padStart(8)}`,
  )
}

console.log('\n=== the eval curve, from your side ===')
for (const r of mine) {
  const mark = r.tier === 'C' ? ` <<< ${r.best ? `best ${r.best}` : ''}` : r.tier === 'B' ? ' <--' : ''
  console.log(
    `  ${String(r.moveNumber).padStart(3)}${r.color === 'w' ? '.' : '…'} ${r.san.padEnd(7)} ` +
      `${'·'.repeat(Math.round(r.beforeMine / 2.5)).padEnd(40)}| ` +
      `${r.beforeMine.toFixed(0).padStart(3)}%  ${(r.seconds == null ? '' : `${Math.round(r.seconds)}s`).padStart(5)}${mark}`,
  )
}

const slips = mine.filter((r) => r.tier !== 'A').sort((a, b) => b.swing - a.swing)
console.log(`\n=== your ${slips.length} imperfect move(s), biggest first ===`)
for (const r of slips) {
  console.log(
    `\n  −${num(r.swing, 0)}%  ${moveLabel(r)}  ` +
      `(${r.before.toFixed(0)}% → ${r.after.toFixed(0)}%)` +
      `${r.seconds == null ? '' : `  ${Math.round(r.seconds)}s`}`,
  )
  if (r.best && r.best !== r.san) console.log(`        the engine wanted ${r.best}`)
  // Just enough run-up to recognise the position. The whole game to here is
  // what the move number is for, and at move 40 it is a wall of text.
  const RUN_UP = 8
  const lead = sans.slice(Math.max(0, r.ply - RUN_UP), r.ply)
  console.log(`        ${r.ply > RUN_UP ? '… ' : ''}${lead.join(' ') || '(start)'}`)
}

const chances = chancesGiven(rows)
console.log(`\n=== chances they handed you (${chances.length}) ===`)
for (const { blunder, reply } of chances) {
  const punished = !reply ? 'game ended there' : reply.tier === 'A' ? 'punished ✓' : `−${num(reply.swing, 0)}%, best ${reply.best ?? '?'}`
  console.log(
    `  ${moveLabel(blunder)} (−${num(blunder.swing, 0)}%)` +
      `  → you played ${reply?.san ?? '—'}  [${punished}]`,
  )
}
if (!chances.length) console.log('  none — they made no Tier C mistake.')

// --- the deep pass ----------------------------------------------------------
/**
 * Ask Lichess's public tablebase for the exact result. Below eight pieces this
 * is not an evaluation — it is the answer. Returns null when the position is too
 * big or the service is unreachable, because a review that dies on a network
 * blip is worse than one that says nothing here.
 */
async function probeTablebase(fen) {
  if (!tablebaseEligible(fen)) return null
  try {
    const res = await fetch(
      `https://tablebase.lichess.ovh/standard?fen=${encodeURIComponent(fen)}`,
      { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } },
    )
    if (!res.ok) return null
    const body = await res.json()
    return {
      category: body.category ?? 'unknown',
      dtz: body.dtz ?? null,
      dtm: body.dtm ?? null,
      moves: (body.moves ?? []).map((m) => ({
        uci: m.uci,
        san: m.san,
        category: m.category ?? 'unknown',
        dtz: m.dtz ?? null,
        dtm: m.dtm ?? null,
      })),
    }
  } catch {
    return null
  }
}

if (flag('deep') && slips.length) {
  const DEEP_NODES = Number(arg('deep-nodes', 6_000_000))
  const pvSan = (fen, pv, max = 10) => {
    const c = new Chess(fen)
    const out = []
    for (const uci of pv.slice(0, max)) {
      try {
        out.push(c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }).san)
      } catch {
        break
      }
    }
    return out.join(' ')
  }
  const wdlText = (w) => (w ? `${(w.win / 10).toFixed(0)}/${(w.draw / 10).toFixed(0)}/${(w.loss / 10).toFixed(0)}` : '  —  ')
  /** WDL is reported from the side to move; after your move that is the opponent. */
  const flipWdl = (w) => (w ? { win: w.loss, draw: w.draw, loss: w.win } : null)

  console.log(`\n\n${'='.repeat(72)}\n  DEEP PASS — ${slips.length} moment(s) at ${DEEP_NODES} nodes\n${'='.repeat(72)}`)

  for (const r of slips) {
    console.log(`\n\n### ${moveLabel(r)}   −${num(r.swing, 0)}%${r.seconds == null ? '' : `, ${Math.round(r.seconds)}s`}`)
    console.log(`  ${fens[r.ply]}`)

    const { lines, depth } = await engine.analyse(fens[r.ply], { nodes: DEEP_NODES, multipv: 4 })
    console.log(`\n  alternatives at depth ${depth}   (win% · W/D/L%)`)
    for (const l of lines) {
      const first = l.pv?.[0]
      const san = first ? pvSan(fens[r.ply], [first]) : '?'
      console.log(
        `   ${String(l.multipv).padStart(2)}. ${san.padEnd(7)} ${winPercent(l.score).toFixed(0).padStart(3)}%  ` +
          `${wdlText(l.wdl).padStart(11)}   ${pvSan(fens[r.ply], l.pv)}${san === r.san ? '   ← you' : ''}`,
      )
    }
    if (!lines.some((l) => pvSan(fens[r.ply], [l.pv?.[0]]) === r.san)) {
      const after = new Chess(fens[r.ply + 1])
      if (!after.isGameOver()) {
        const played = await engine.analyse(fens[r.ply + 1], { nodes: DEEP_NODES, multipv: 1 })
        console.log(
          `\n   your ${r.san}: ${winPercent(negate(played.lines[0].score)).toFixed(0)}%  ` +
            `${wdlText(flipWdl(played.lines[0].wdl))}  ` +
            `→ ${pvSan(fens[r.ply + 1], played.lines[0].pv)}`,
        )
      }
    }

    // Which piece actually changed. Read as evidence, not verdict: the number is
    // "how much worse without this piece", so it moves for reasons elsewhere too.
    const [pvBefore, pvAfter] = [
      await engine.pieceValues(fens[r.ply]),
      await engine.pieceValues(fens[r.ply + 1]),
    ]
    const changes = comparePieceValues(pvBefore, pvAfter).filter((c) => Math.abs(c.delta) >= 0.15)
    if (changes.length) {
      console.log('\n  what each piece became worth')
      for (const c of changes.slice(0, 5)) {
        console.log(
          `   ${c.piece} ${(c.from ?? '--')}→${(c.to ?? 'captured').padEnd(8)} ` +
            `${num(c.before, 2).padStart(5)} → ${num(c.after, 2).padStart(5)}  ` +
            `${c.delta >= 0 ? '+' : ''}${c.delta.toFixed(2)}`,
        )
      }
    }

    const tb = await probeTablebase(fens[r.ply])
    if (!tb) {
      console.log(`\n  tablebase: ${pieceCount(fens[r.ply])} pieces — solved only at 7 or fewer`)
    } else {
      const v = judgeTablebase(tb, r.san)
      console.log(`\n  tablebase: this position is a ${v.category.toUpperCase()}${tb.dtz == null ? '' : ` (DTZ ${tb.dtz})`}`)
      if (v.best.length) console.log(`    keeps it: ${v.best.slice(0, 4).map((m) => m.san).join(', ')}`)
      if (v.playedHolds === true) console.log(`    your ${r.san} holds the ${v.category}`)
      if (v.playedHolds === false) console.log(`    *** your ${r.san} throws it to a ${v.threwAwayTo} ***`)
    }
  }
}

await engine.quit()
