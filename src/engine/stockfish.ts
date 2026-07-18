import type { EngineEvaluation, Score } from '../domain/types'
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
        this.listener = (line: string) => {
          const s = parseScore(line)
          if (s) lastScore = s
          const bm = parseBestMove(line)
          if (bm) {
            this.listener = null
            resolve({ score: lastScore ?? { type: 'cp', value: 0 }, bestMove: bm.move })
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
          if (info) byRank.set(info.multipv, info)
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
