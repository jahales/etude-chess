// Fetch the Maia-1 spike model, which is too large to commit.
//   public/models/maia-1900.onnx  (Maia-1900 net, GPL-3.0, ~3.5 MB)
// Run once before `npm run dev` / the Maia probe:  node scripts/setup-maia.mjs
//
// The onnxruntime-web wasm runtime is NOT fetched here — the inference Worker
// imports it from node_modules via Vite `?url`, so Vite bundles it automatically.
import { mkdirSync, existsSync, createWriteStream } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const MODEL_URL = 'https://huggingface.co/shermansiu/maia-1900/resolve/main/model.onnx'
const MODEL_PATH = 'public/models/maia-1900.onnx'

mkdirSync('public/models', { recursive: true })

if (existsSync(MODEL_PATH)) {
  console.log(`✓ ${MODEL_PATH} already present`)
} else {
  console.log(`↓ ${MODEL_URL}`)
  const res = await fetch(MODEL_URL)
  if (!res.ok) throw new Error(`model download failed: ${res.status}`)
  await pipeline(Readable.fromWeb(res.body), createWriteStream(MODEL_PATH))
  console.log(`✓ wrote ${MODEL_PATH}`)
}
console.log('Maia spike model ready.')
