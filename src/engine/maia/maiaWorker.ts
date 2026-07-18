// Maia inference Web Worker — the arm's-length home of onnxruntime-web + the GPL
// Maia net, mirroring how Stockfish runs in its own Worker. Loads the model (with a
// best-effort IndexedDB cache), then answers policy requests: encode → run → decode.
//
// Protocol (postMessage):
//   in  { type:'init', modelUrl }              → out { type:'ready' }
//   in  { type:'policy', id, fen, modelUrl, temperature } → out { type:'policy', id, moves }
//   any failure                                → out { type:'error', id?, message }

import * as ort from 'onnxruntime-web/wasm'
// Hand ORT the wasm glue + binary as Vite `?url` assets. ORT then imports these
// runtime URL strings directly, which Vite can't rewrite — sidestepping the
// `?import` mangling that breaks a plain wasmPaths prefix in a Vite worker (the
// wasm build's Vite gotcha; see docs/spikes/maia-onnx.md). Vite bundles the wasm
// itself, so nothing needs to be hand-copied into public/.
import ortWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url'
import ortMjsUrl from 'onnxruntime-web/ort-wasm-simd-threaded.mjs?url'
import { encodeFen, INPUT_SHAPE } from './encoding'
import { decodePolicy } from './decoding'

ort.env.wasm.wasmPaths = { wasm: ortWasmUrl, mjs: ortMjsUrl }
ort.env.wasm.numThreads = 1 // single-threaded → no SharedArrayBuffer / COOP-COEP needed

let sessionPromise: Promise<ort.InferenceSession> | null = null

function getSession(modelUrl: string): Promise<ort.InferenceSession> {
  if (!sessionPromise) {
    sessionPromise = loadModelBytes(modelUrl).then((buf) =>
      ort.InferenceSession.create(buf, { executionProviders: ['wasm'] }),
    )
  }
  return sessionPromise
}

async function loadModelBytes(url: string): Promise<ArrayBuffer> {
  const cached = await idbGet(url).catch(() => undefined)
  if (cached) return cached
  const res = await fetch(url)
  if (!res.ok) throw new Error(`model fetch failed: ${res.status}`)
  const buf = await res.arrayBuffer()
  void idbPut(url, buf).catch(() => {}) // best-effort; never block on the cache
  return buf
}

const post = (m: unknown) => (self as unknown as Worker).postMessage(m)

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data as {
    type: string
    id?: number
    fen?: string
    modelUrl: string
    temperature?: number
    history?: string[]
  }
  try {
    if (msg.type === 'init') {
      await getSession(msg.modelUrl)
      post({ type: 'ready' })
    } else if (msg.type === 'policy') {
      const session = await getSession(msg.modelUrl)
      const planes = encodeFen(msg.fen!, msg.history ?? [])
      const input = new ort.Tensor('float32', planes, INPUT_SHAPE as unknown as number[])
      const out = await session.run({ '/input/planes': input })
      const policy = out['/output/policy']?.data as Float32Array
      const moves = decodePolicy(policy, msg.fen!, { temperature: msg.temperature ?? 1 })
      post({ type: 'policy', id: msg.id, moves })
    }
  } catch (err) {
    post({ type: 'error', id: msg.id, message: err instanceof Error ? err.message : String(err) })
  }
}

// --- minimal best-effort IndexedDB byte cache (no external dependency) ---
const DB_NAME = 'maia-model-cache'
const STORE = 'models'

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}
async function idbGet(key: string): Promise<ArrayBuffer | undefined> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const r = db.transaction(STORE, 'readonly').objectStore(STORE).get(key)
    r.onsuccess = () => resolve(r.result as ArrayBuffer | undefined)
    r.onerror = () => reject(r.error)
  })
}
async function idbPut(key: string, val: ArrayBuffer): Promise<void> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(val, key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}
