import type { EngineEvaluation, Score } from '../domain/types'
import { parseScore, parseBestMove } from './uci'
import {
  type Analyser,
  type AnalyseOptions,
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
        this.worker.postMessage(`position fen ${fen}`)
        this.worker.postMessage(`go ${limitString(opts)}`)
      })
    }
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
