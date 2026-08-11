import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createEngine , searchTimeoutMs } from './engine.mjs'

// Driven against a scripted fake engine rather than Stockfish, so these run in
// milliseconds and can pose situations a real search rarely produces on demand.
//
// Two defects came out of this file and neither was catchable any other way:
// MultiPV ranks merged across search iterations (which inflated `breadth` in
// the quiet test and made sharp positions look calm), and multithreaded search
// silently making every number unreproducible.

const here = dirname(fileURLToPath(import.meta.url))
const FAKE = join(here, '__fixtures__', 'fakeEngine.mjs')
const FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'

let dir
let logPath
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'engine-'))
  logPath = join(dir, 'log.txt')
})

let scripts = 0

/** An engine whose `go` replies come from `script`. */
function engineWith(script) {
  const scriptPath = join(dir, `script-${scripts++}.json`)
  writeFileSync(scriptPath, JSON.stringify(script))
  // The fixture reads these from its environment, which spawn inherits.
  process.env.FAKE_ENGINE_SCRIPT = scriptPath
  process.env.FAKE_ENGINE_LOG = logPath
  return createEngine({ path: process.execPath, args: [FAKE] })
}

const commands = () => (existsSync(logPath) ? readFileSync(logPath, 'utf8').split('\n') : [])

const info = (depth, multipv, cp, move) =>
  `info depth ${depth} seldepth ${depth} multipv ${multipv} score cp ${cp} nodes 1000 pv ${move}`

describe('engine — MultiPV assembly', () => {
  it('returns every rank of the deepest complete iteration', async () => {
    const e = engineWith({
      default: [
        info(19, 1, 30, 'e2e4'),
        info(19, 2, 25, 'd2d4'),
        info(19, 3, 20, 'g1f3'),
        info(20, 1, 35, 'e2e4'),
        info(20, 2, 28, 'd2d4'),
        info(20, 3, 22, 'c2c4'),
        'bestmove e2e4',
      ],
    })
    const r = await e.analyse(FEN, { multipv: 3 })
    expect(r.depth).toBe(20)
    expect(r.lines.map((l) => l.pv[0])).toEqual(['e2e4', 'd2d4', 'c2c4'])
    expect(r.lines.map((l) => l.score.value)).toEqual([35, 28, 22])
    await e.quit()
  })

  it('ignores an iteration the node limit cut off part-way', async () => {
    // THE bug. A node limit routinely truncates the final iteration, and taking
    // the newest line per rank mixed depth 21's rank 1 with depth 20's ranks 2
    // and 3 — sometimes yielding the same move twice, which inflated `breadth`
    // and made a sharp position read as quiet.
    const e = engineWith({
      default: [
        info(20, 1, 35, 'e2e4'),
        info(20, 2, 28, 'd2d4'),
        info(20, 3, 22, 'c2c4'),
        info(21, 1, 40, 'd2d4'), // rank 1 only; ranks 2-3 never arrived
        'bestmove d2d4',
      ],
    })
    const r = await e.analyse(FEN, { multipv: 3 })
    expect(r.depth).toBe(20)
    expect(r.lines).toHaveLength(3)
    await e.quit()
  })

  it('never returns the same move under two ranks', async () => {
    const e = engineWith({
      default: [
        info(18, 1, 30, 'e2e4'),
        info(18, 2, 25, 'd2d4'),
        info(19, 1, 33, 'd2d4'),
        'bestmove d2d4',
      ],
    })
    const r = await e.analyse(FEN, { multipv: 2 })
    const moves = r.lines.map((l) => l.pv[0])
    expect(new Set(moves).size).toBe(moves.length)
    await e.quit()
  })

  it('reports the best move even when no info line carries a pv', async () => {
    const e = engineWith({ default: ['bestmove e2e4'] })
    const r = await e.analyse(FEN, { multipv: 3 })
    expect(r.bestMove).toBe('e2e4')
    expect(r.lines).toEqual([])
    expect(r.depth).toBe(0)
    await e.quit()
  })

  it('handles a terminal position reporting no move at all', async () => {
    const e = engineWith({ default: ['bestmove (none)'] })
    const r = await e.analyse(FEN)
    expect(r.bestMove).toBeNull()
    await e.quit()
  })

  it('ignores bound scores, which are not final readings', async () => {
    const e = engineWith({
      default: [
        'info depth 20 multipv 1 score cp 900 lowerbound nodes 10 pv e2e4',
        info(20, 1, 35, 'e2e4'),
        'bestmove e2e4',
      ],
    })
    const r = await e.analyse(FEN)
    expect(r.lines[0].score.value).toBe(35)
    await e.quit()
  })

  it('reads a mate score', async () => {
    const e = engineWith({
      default: ['info depth 20 multipv 1 score mate 3 nodes 10 pv e2e4', 'bestmove e2e4'],
    })
    const r = await e.analyse(FEN)
    expect(r.lines[0].score).toEqual({ type: 'mate', value: 3 })
    await e.quit()
  })
})

describe('engine — reproducibility contract', () => {
  it('pins Threads to 1', async () => {
    // Not cosmetic. Multithreaded search splits work by thread scheduling, so
    // the same position at the same node budget returns different scores run to
    // run — which made a cross-month replication look like real month-to-month
    // variation when the data was stable to within a point.
    const e = engineWith({ default: ['bestmove e2e4'] })
    await e.analyse(FEN)
    expect(commands()).toContain('setoption name Threads value 1')
    await e.quit()
  })

  it('searches by fixed node count, never by time', async () => {
    const e = engineWith({ default: ['bestmove e2e4'] })
    await e.analyse(FEN, { nodes: 120_000 })
    const cmds = commands()
    expect(cmds).toContain('go nodes 120000')
    expect(cmds.some((c) => c.includes('movetime'))).toBe(false)
    await e.quit()
  })

  it('clears the hash before every search', async () => {
    // A warm transposition table makes the answer depend on what was analysed
    // before it — reproducible only if nothing else ran first.
    const e = engineWith({ default: ['bestmove e2e4'] })
    await e.analyse(FEN)
    await e.analyse(FEN)
    expect(commands().filter((c) => c === 'ucinewgame')).toHaveLength(2)
    await e.quit()
  })

  it('gives the same answer twice for the same position', async () => {
    const e = engineWith({ default: [info(20, 1, 35, 'e2e4'), 'bestmove e2e4'] })
    const a = await e.analyse(FEN, { multipv: 1 })
    const b = await e.analyse(FEN, { multipv: 1 })
    expect(JSON.stringify(a.lines)).toBe(JSON.stringify(b.lines))
    await e.quit()
  })
})

describe('engine — protocol handling', () => {
  it('sets MultiPV only when it actually changes', async () => {
    const e = engineWith({ default: ['bestmove e2e4'] })
    await e.analyse(FEN, { multipv: 5 })
    await e.analyse(FEN, { multipv: 5 })
    await e.analyse(FEN, { multipv: 1 })
    const sets = commands().filter((c) => c.startsWith('setoption name MultiPV'))
    expect(sets).toEqual(['setoption name MultiPV value 5', 'setoption name MultiPV value 1'])
    await e.quit()
  })

  it('sends the position it was asked about', async () => {
    const e = engineWith({ default: ['bestmove e2e4'] })
    await e.analyse(FEN)
    expect(commands()).toContain(`position fen ${FEN}`)
    await e.quit()
  })

  it('serialises concurrent requests — the engine has one state', async () => {
    const e = engineWith({
      searches: [
        [info(20, 1, 11, 'e2e4'), 'bestmove e2e4'],
        [info(20, 1, 22, 'd2d4'), 'bestmove d2d4'],
      ],
      default: [info(20, 1, 33, 'g1f3'), 'bestmove g1f3'],
    })
    const [a, b] = await Promise.all([e.analyse(FEN), e.analyse(FEN)])
    // Interleaved commands would cross-wire the two replies; each must get its own.
    expect(a.lines[0].score.value).toBe(11)
    expect(b.lines[0].score.value).toBe(22)
    expect(e.searchCount()).toBe(2)
    await e.quit()
  })

  it('counts the searches it ran', async () => {
    const e = engineWith({ default: ['bestmove e2e4'] })
    await e.analyse(FEN)
    await e.analyse(FEN)
    expect(e.searchCount()).toBe(2)
    await e.quit()
  })

  it('shuts down cleanly', async () => {
    const e = engineWith({ default: ['bestmove e2e4'] })
    await e.analyse(FEN)
    await expect(e.quit()).resolves.toBeUndefined()
  })
})

describe('searchTimeoutMs', () => {
  it('scales with the node budget', () => {
    expect(searchTimeoutMs(100_000_000)).toBeGreaterThan(searchTimeoutMs(4_000_000))
  })

  it('never drops below the floor, for commands that carry no budget', () => {
    // `isready` has no nodes at all, so it rests entirely on the floor — and
    // that is one of the two searches a 4M-node build lost.
    expect(searchTimeoutMs(0)).toBeGreaterThanOrEqual(120_000)
    expect(searchTimeoutMs(1)).toBeGreaterThanOrEqual(120_000)
  })

  it('gives a pooled engine more time than a lone one, budget and floor alike', () => {
    // The bug: a 4M-node search budgeted at 80s, floored to 120s, run ten to a
    // machine. Ten engines do not each get the whole machine.
    expect(searchTimeoutMs(4_000_000, 10)).toBeGreaterThan(searchTimeoutMs(4_000_000, 1))
    expect(searchTimeoutMs(0, 10)).toBeGreaterThan(searchTimeoutMs(0, 1))
  })

  it('grows in proportion to the number of engines sharing', () => {
    expect(searchTimeoutMs(4_000_000, 10)).toBeCloseTo(10 * searchTimeoutMs(4_000_000, 1) / 1, -3)
  })

  it('treats a missing or nonsense share as one engine', () => {
    const lone = searchTimeoutMs(1_000_000, 1)
    for (const share of [undefined, 0, -5]) {
      expect(searchTimeoutMs(1_000_000, share)).toBe(lone)
    }
  })
})
