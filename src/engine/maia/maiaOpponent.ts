// MaiaOnnxOpponent — the adapter for the MaiaOpponent port. Owns the inference
// Worker and serializes request/response over postMessage with a pending-promise map
// (the same shape as StockfishAnalyser). App/domain code sees only the port.

import type { MaiaMove, MaiaOpponent } from './opponent'

/** Served from public/ (fetch scripts/setup-maia.mjs to populate it). */
export const DEFAULT_MAIA_MODEL_URL = '/models/maia-1900.onnx'

type Pending = { resolve: (m: MaiaMove[]) => void; reject: (e: Error) => void }

export class MaiaOnnxOpponent implements MaiaOpponent {
  private worker: Worker
  private readyPromise: Promise<void>
  private pending = new Map<number, Pending>()
  private seq = 0

  constructor(private modelUrl: string = DEFAULT_MAIA_MODEL_URL) {
    this.worker = new Worker(new URL('./maiaWorker.ts', import.meta.url), { type: 'module' })
    this.worker.addEventListener('message', (e) => this.onMessage(e))
    this.readyPromise = new Promise((resolve, reject) => {
      const onReady = (e: MessageEvent) => {
        if (e.data?.type === 'ready') {
          this.worker.removeEventListener('message', onReady)
          resolve()
        } else if (e.data?.type === 'error' && e.data.id === undefined) {
          this.worker.removeEventListener('message', onReady)
          reject(new Error(e.data.message))
        }
      }
      this.worker.addEventListener('message', onReady)
    })
    this.worker.postMessage({ type: 'init', modelUrl: this.modelUrl })
  }

  private onMessage(e: MessageEvent): void {
    const m = e.data
    if (m?.id === undefined) return
    const p = this.pending.get(m.id)
    if (!p) return
    this.pending.delete(m.id)
    if (m.type === 'policy') p.resolve(m.moves as MaiaMove[])
    else if (m.type === 'error') p.reject(new Error(m.message))
  }

  ready(): Promise<void> {
    return this.readyPromise
  }

  policy(fen: string, temperature = 1): Promise<MaiaMove[]> {
    const id = ++this.seq
    return new Promise<MaiaMove[]>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.worker.postMessage({ type: 'policy', id, fen, modelUrl: this.modelUrl, temperature })
    })
  }

  async move(fen: string, opts: { temperature?: number } = {}): Promise<MaiaMove> {
    const t = opts.temperature ?? 0
    const moves = await this.policy(fen, t === 0 ? 0.01 : t)
    const [first] = moves
    if (!first) throw new Error('no legal moves')
    if (t === 0) return first // argmax: the strongest human move
    // temperature > 0: sample from the policy for natural variety
    let r = Math.random()
    for (const m of moves) {
      r -= m.prob
      if (r <= 0) return m
    }
    return first
  }

  dispose(): void {
    this.worker.terminate()
  }
}
