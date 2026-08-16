import type { EngineEvaluation, Score, Wdl } from '../domain/types'
import { parseScore, parseBestMove, parseInfoLine } from './uci'
import {
  type Analyser,
  type AnalyseOptions,
  type AnalysisLine,
  DEFAULT_ENGINE_URL,
  limitString,
} from './analyser'

/**
 * Stockfish running as a WASM Web Worker (the lite single-threaded build in
 * public/engine — arm's-length from our code for GPL compliance, see
 * docs/decisions/0009-tech-stack.md). Evaluate calls are serialized so the
 * single UCI stream is never interleaved.
 */
export class StockfishAnalyser implements Analyser {
  private worker: Worker
  private listener: ((line: string) => void) | null = null
  private readyPromise: Promise<void>
  private queue: Promise<unknown> = Promise.resolve()

  constructor(scriptUrl: string = DEFAULT_ENGINE_URL) {
    this.worker = new Worker(scriptUrl)
    this.worker.onmessage = (e: MessageEvent) => {
      const data = e.data as unknown
      const line = typeof data === 'string' ? data : (data as { data?: string })?.data ?? ''
      if (line) this.listener?.(line)
    }
    this.readyPromise = this.handshake()
  }

  private waitFor(token: string, trigger: () => void): Promise<void> {
    return new Promise((resolve) => {
      this.listener = (line: string) => {
        if (line.includes(token)) {
          this.listener = null
          resolve()
        }
      }
      trigger()
    })
  }

  private async handshake(): Promise<void> {
    await this.waitFor('uciok', () => this.worker.postMessage('uci'))
    // Ask for win/draw/loss on every `info` line, the same thing the offline
    // driver asks for (`scripts/repertoire/engine.mjs`). The property that makes
    // this safe is the one recorded there: `UCI_ShowWDL` is **display-only and
    // changes no search**, so it adds a field to the output and moves no score,
    // no bestmove and therefore no grade. That was *measured* against this exact
    // WASM build rather than taken on trust — nine positions graded twice at the
    // app's node budget, identical tier, swing and bestmove every time. The run
    // is described in `stockfish.test.ts`.
    //
    // Sent before `isready` so the option is set while the engine is idle, which
    // is the only time UCI permits it.
    this.worker.postMessage('setoption name UCI_ShowWDL value true')
    await this.waitFor('readyok', () => this.worker.postMessage('isready'))
  }

  /** Resolves once the engine has completed its UCI handshake. */
  ready(): Promise<void> {
    return this.readyPromise
  }

  evaluate(fen: string, opts: AnalyseOptions = {}): Promise<EngineEvaluation> {
    const run = async (): Promise<EngineEvaluation> => {
      await this.readyPromise
      return new Promise<EngineEvaluation>((resolve) => {
        let lastScore: Score | null = null
        let lastPv: string[] | null = null
        let lastWdl: Wdl | null = null
        this.listener = (line: string) => {
          // The pv is only ever kept alongside the score it was reported with:
          // an `info` line carrying a score but no pv replaces both, so the
          // continuation can never be one iteration's line captioned by another
          // iteration's number (#151). Score handling is otherwise unchanged —
          // the last complete (non-bound) score before `bestmove` wins.
          //
          // The WDL rides with the score on exactly the same terms (#161), and
          // for a sharper version of the same reason: a stale `1000/0/0` left
          // over from a previous iteration would read as "the result was never
          // in doubt", which is a claim about the position rather than a
          // mismatched decoration. So it is cleared wherever the pv is cleared.
          const info = parseInfoLine(line)
          if (info) {
            lastScore = info.score
            lastPv = info.pv
            lastWdl = info.wdl
          } else {
            const s = parseScore(line)
            if (s) {
              lastScore = s
              lastPv = null
              lastWdl = null
            }
          }
          const bm = parseBestMove(line)
          if (bm) {
            this.listener = null
            resolve({
              score: lastScore ?? { type: 'cp', value: 0 },
              bestMove: bm.move,
              ...(lastPv ? { pv: lastPv } : {}),
              ...(lastWdl ? { wdl: lastWdl } : {}),
            })
          }
        }
        this.worker.postMessage('setoption name MultiPV value 1')
        this.worker.postMessage(`position fen ${fen}`)
        this.worker.postMessage(`go ${limitString(opts)}`)
      })
    }
    return this.enqueue(run)
  }

  analyseLines(
    fen: string,
    opts: AnalyseOptions & { multipv?: number } = {},
  ): Promise<AnalysisLine[]> {
    const multipv = Math.max(1, opts.multipv ?? 3)
    const run = async (): Promise<AnalysisLine[]> => {
      await this.readyPromise
      return new Promise<AnalysisLine[]>((resolve) => {
        const byRank = new Map<number, AnalysisLine>()
        this.listener = (line: string) => {
          const info = parseInfoLine(line)
          // Mapped field by field rather than stored as-is: the parser reports
          // "not asked for" as `null` and the port's contract is an absent
          // optional, so the two vocabularies are converted here rather than
          // leaking `wdl: null` to every consumer.
          if (info)
            byRank.set(info.multipv, {
              multipv: info.multipv,
              score: info.score,
              pv: info.pv,
              ...(info.wdl ? { wdl: info.wdl } : {}),
            })
          const bm = parseBestMove(line)
          if (bm) {
            this.listener = null
            resolve([...byRank.values()].sort((a, b) => a.multipv - b.multipv))
          }
        }
        this.worker.postMessage(`setoption name MultiPV value ${multipv}`)
        this.worker.postMessage(`position fen ${fen}`)
        this.worker.postMessage(`go ${limitString(opts)}`)
      })
    }
    return this.enqueue(run)
  }

  /** Serialise engine runs so the single UCI stream is never interleaved. */
  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const result = this.queue.then(run, run)
    this.queue = result.catch(() => undefined)
    return result
  }

  dispose(): void {
    try {
      this.worker.postMessage('quit')
    } catch {
      /* worker may already be gone */
    }
    this.worker.terminate()
    this.listener = null
  }
}
