// Native Stockfish driver for the offline crawl.
//
// The app talks to Stockfish WASM in a Worker; this talks to the real binary
// over stdio, because a batch crawl wants the 10–50× and does not need to run
// in a browser. The *parsers* are shared with the app (src/engine/uci.ts) —
// Node's type stripping loads that module directly since it has no runtime
// imports. Grading rules stay in src/domain; nothing here makes a judgment.
//
// Reproducibility per docs/architecture.md: fixed `go nodes`, never movetime,
// and `ucinewgame` before each search so a warm hash can't change an answer.

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { parseBestMove, parseInfoLine } from '../../src/engine/uci.ts'
import { parsePieceValues } from '../../src/engine/evalTable.ts'

/** Nodes/sec assumed of a lone engine — ~30× slower than this machine manages. */
const SLOWEST_ASSUMED_NPS = 50_000
/** Floor for commands that carry no node budget at all, such as `isready`. */
const MIN_TIMEOUT_MS = 120_000

/**
 * How long to wait for a search of `nodes` nodes, with `share` engines running.
 *
 * A fixed ceiling does not survive a raised budget: at 4M nodes a search takes
 * a few seconds on an idle machine and minutes when something else is using the
 * cores, and a flat 120s once killed a whole review over one position that was
 * merely queued behind a test run.
 *
 * `share` is the second half of that lesson. The pessimism above was calibrated
 * for one engine having the machine to itself; ten in a pool each achieve a
 * fraction of it, so a budget ignoring its own parallelism kills searches for
 * being exactly as slow as the design intends. It took out two branches of a
 * 4M-node build — one of them on `isready`, which has no node budget and so
 * rested entirely on the floor.
 */
export function searchTimeoutMs(nodes = 0, share = 1) {
  const engines = Math.max(1, share)
  return Math.max(MIN_TIMEOUT_MS * engines, (nodes / (SLOWEST_ASSUMED_NPS / engines)) * 1000)
}

/** Where En Croissant installs Stockfish on Windows. */
export const DEFAULT_ENGINE_PATH = `${process.env.APPDATA}\\org.encroissant.app\\engines\\stockfish\\stockfish-windows-x86-64-avx2.exe`

/**
 * @param {object} [opts]
 * @param {string} [opts.path]    engine binary
 * @param {string[]} [opts.args]  argv for it — lets a test point `path` at
 *                                node and run a scripted fake engine
 * @param {number} [opts.threads]
 * @param {number} [opts.hashMb]
 */
export function createEngine(opts = {}) {
  const {
    path = process.env.STOCKFISH_PATH || DEFAULT_ENGINE_PATH,
    args = [],
    // ONE thread, deliberately. Fixed `go nodes` is not sufficient for
    // reproducibility — multithreaded search splits work by thread scheduling,
    // so the same position at the same budget returns different scores run to
    // run. Measured: three 8-thread searches of one position gave top-move
    // scores of -31, -35 and -31 with different move orders, and one returned
    // the same move twice in its MultiPV list. Scores wobble ~10cp, which at a
    // 5 win% trap gate silently flips findings in and out — it is what made a
    // cross-month replication look like month-to-month variation when the
    // underlying data was stable to within one percentage point.
    //
    // Single-threaded is slower per search and worth it: without it nothing
    // downstream is reproducible, and architecture.md's claim that engine calls
    // are reproducible is simply untrue.
    threads = 1,
    hashMb = 256,
    /** Engines competing for this machine; scales the search timeout budget. */
    share = 1,
  } = opts

  const proc = spawn(path, args, { stdio: ['pipe', 'pipe', 'ignore'] })
  proc.on('error', (e) => {
    throw new Error(`could not start Stockfish at ${path}: ${e.message}`)
  })

  const rl = createInterface({ input: proc.stdout })
  /** @type {((line: string) => void) | null} */
  let onLine = null
  rl.on('line', (line) => onLine?.(line))

  const send = (cmd) => proc.stdin.write(`${cmd}\n`)

  /**
   * How long to wait for a search of `nodes` nodes.
   *
   * A fixed ceiling does not survive a raised budget: at 4M nodes a search takes
   * a few seconds on an idle machine and minutes when something else is using
   * the cores, and the old flat 120s killed a whole review over one position
   * that was merely queued behind a test run. Budgeted at a deliberately
   * pessimistic 50k nodes/sec — roughly 30× slower than this machine manages —
   * with a floor for the handshake commands, which carry no budget at all.
   *
   * `share` is how many engines are competing for this machine. That pessimism
   * was calibrated for one engine having it to itself; running ten in a pool
   * divides the rate each achieves, so a budget ignoring it kills searches for
   * being exactly as slow as the design intends. It took out two branches of a
   * 4M-node build before it was accounted for — including one on `isready`,
   * which carries no node budget and so rested entirely on the floor.
   */
  const timeoutFor = (nodes = 0) => searchTimeoutMs(nodes, share)

  /** Run `cmd` and resolve when `done(line)` returns truthy, feeding each line to `sink`. */
  function until(cmd, done, sink, timeoutMs = MIN_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        onLine = null
        reject(new Error(`engine timed out after ${(timeoutMs / 1000).toFixed(0)}s on: ${cmd}`))
      }, timeoutMs)
      onLine = (line) => {
        sink?.(line)
        if (done(line)) {
          clearTimeout(timer)
          onLine = null
          resolve()
        }
      }
      send(cmd)
    })
  }

  let searches = 0
  let currentMultipv = 1
  const ready = (async () => {
    await until('uci', (l) => l === 'uciok')
    send(`setoption name Threads value ${threads}`)
    send(`setoption name Hash value ${hashMb}`)
    // Display-only: it adds `wdl W D L` to the info lines and changes no search
    // result. Worth having always on — in a decided position win/draw/loss says
    // what a centipawn score cannot, and callers that ignore it pay nothing.
    send('setoption name UCI_ShowWDL value true')
    await until('isready', (l) => l === 'readyok')
  })()

  /** One search at a time — the engine has a single state. */
  let chain = ready

  return {
    /**
     * Analyse a position at a fixed node budget.
     * @param {string} fen
     * @param {{nodes?: number, multipv?: number}} [o]
     * @returns {Promise<{lines: {multipv:number, score: import('../../src/domain/types.ts').Score, pv: string[]}[], bestMove: string|null}>}
     *   `lines` are ordered best-first and expressed from the side to move.
     */
    analyse(fen, o = {}) {
      const { nodes = 400_000, multipv = 1 } = o
      const run = chain.then(async () => {
        if (multipv !== currentMultipv) {
          send(`setoption name MultiPV value ${multipv}`)
          currentMultipv = multipv
          await until('isready', (l) => l === 'readyok')
        }
        send('ucinewgame')
        await until('isready', (l) => l === 'readyok')
        send(`position fen ${fen}`)

        // Group by iteration depth. Stockfish re-emits every MultiPV rank each
        // iteration, and a node limit routinely cuts the final one off partway.
        // Merging ranks across depths yields inconsistent — sometimes duplicate
        // — moves, which would inflate `breadth` in the quiet test and make
        // sharp positions look calm. So we keep whole iterations and use the
        // deepest *complete* one.
        /** @type {Map<number, Map<number, any>>} */
        const byDepth = new Map()
        let bestMove = null
        await until(
          `go nodes ${nodes}`,
          (l) => {
            const bm = parseBestMove(l)
            if (bm) {
              bestMove = bm.move
              return true
            }
            return false
          },
          (l) => {
            const info = parseInfoLine(l)
            if (!info) return
            const d = l.match(/\bdepth (\d+)/)
            if (!d) return
            const depth = parseInt(d[1], 10)
            let ranks = byDepth.get(depth)
            if (!ranks) byDepth.set(depth, (ranks = new Map()))
            ranks.set(info.multipv, { ...info, depth })
          },
          timeoutFor(nodes),
        )
        searches++

        const depths = [...byDepth.keys()].sort((a, b) => b - a)
        const wanted = Math.min(multipv, Math.max(1, ...[...byDepth.values()].map((r) => r.size)))
        const chosen =
          depths.find((d) => byDepth.get(d).size >= wanted) ?? depths[0]
        const ranks = chosen === undefined ? new Map() : byDepth.get(chosen)

        return {
          lines: [...ranks.values()].sort((a, b) => a.multipv - b.multipv),
          bestMove,
          depth: chosen ?? 0,
        }
      })
      chain = run.catch(() => {})
      return run
    },

    /**
     * What each piece is worth in this position, from Stockfish's `eval`.
     *
     * Not a search — it is the static evaluation, so it is nearly free, and it
     * answers the question a score cannot: *which piece* changed. Empty for a
     * position in check, where Stockfish declines to print the grid.
     * @param {string} fen
     * @returns {Promise<import('../../src/engine/evalTable.ts').PieceValue[]>}
     */
    pieceValues(fen) {
      const run = chain.then(async () => {
        send('ucinewgame')
        await until('isready', (l) => l === 'readyok')
        send(`position fen ${fen}`)
        const out = []
        await until('eval', (l) => l.startsWith('Final evaluation'), (l) => out.push(l))
        return parsePieceValues(out.join('\n'))
      })
      chain = run.catch(() => {})
      return run
    },

    searchCount: () => searches,

    async quit() {
      await chain.catch(() => {})
      send('quit')
      rl.close()
      proc.stdin.end()
    },
  }
}
