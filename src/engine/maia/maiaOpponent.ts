// MaiaOnnxOpponent — the adapter for the MaiaOpponent port. Owns the inference
// Worker and serializes request/response over postMessage with a pending-promise map
// (the same shape as StockfishAnalyser). App/domain code sees only the port.

import type { MaiaLevel, MaiaMove, MaiaMoveOpts, MaiaOpponent } from './opponent'

/** Model URL for a rating level, served from public/ (see scripts/setup-maia.mjs). */
export const maiaModelUrl = (level: MaiaLevel): string => `/models/maia-${level}.onnx`

/** Served from public/ (fetch scripts/setup-maia.mjs to populate it). */
export const DEFAULT_MAIA_MODEL_URL = maiaModelUrl(1900)

type Pending = { resolve: (m: MaiaMove[]) => void; reject: (e: Error) => void }

export class MaiaOnnxOpponent implements MaiaOpponent {
  private worker: Worker
  private readyPromise: Promise<void>
  private readyResolve!: () => void
  private readyReject!: (e: Error) => void
  private readySettled = false
  private pending = new Map<number, Pending>()
  private seq = 0

  constructor(private modelUrl: string = DEFAULT_MAIA_MODEL_URL) {
    this.readyPromise = new Promise((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject = reject
    })
    this.worker = new Worker(new URL('./maiaWorker.ts', import.meta.url), { type: 'module' })
    this.worker.addEventListener('message', (e) => this.onMessage(e))
    // A worker *load* failure (bad bundle, blocked wasm) fires 'error', not a message —
    // without this, ready() and in-flight requests would hang forever.
    this.worker.addEventListener('error', (e) => this.failAll(new Error(e.message || 'Maia worker error')))
    this.worker.postMessage({ type: 'init', modelUrl: this.modelUrl })
  }

  private onMessage(e: MessageEvent): void {
    const m = e.data
    if (m?.type === 'ready') {
      if (!this.readySettled) {
        this.readySettled = true
        this.readyResolve()
      }
      return
    }
    if (m?.id === undefined) {
      if (m?.type === 'error') this.failAll(new Error(m.message)) // init failure
      return
    }
    const p = this.pending.get(m.id)
    if (!p) return
    this.pending.delete(m.id)
    if (m.type === 'policy') p.resolve(m.moves as MaiaMove[])
    else if (m.type === 'error') p.reject(new Error(m.message))
  }

  /** Reject ready() (if unsettled) and every in-flight request — used on any fatal worker failure. */
  private failAll(err: Error): void {
    if (!this.readySettled) {
      this.readySettled = true
      this.readyReject(err)
    }
    for (const p of this.pending.values()) p.reject(err)
    this.pending.clear()
  }

  ready(): Promise<void> {
    return this.readyPromise
  }

  policy(fen: string, opts: MaiaMoveOpts = {}): Promise<MaiaMove[]> {
    const id = ++this.seq
    return new Promise<MaiaMove[]>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.worker.postMessage({
        type: 'policy',
        id,
        fen,
        modelUrl: this.modelUrl,
        temperature: opts.temperature ?? 1,
        history: opts.history ?? [],
      })
    })
  }

  async move(fen: string, opts: MaiaMoveOpts = {}): Promise<MaiaMove> {
    const t = opts.temperature ?? 0
    const moves = await this.policy(fen, { temperature: t === 0 ? 0.01 : t, history: opts.history })
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
