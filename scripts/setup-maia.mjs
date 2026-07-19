// Fetch the Maia-1 nets the app ships with — too large to commit. Run once before
// `npm run dev` / the e2e tests:  node scripts/setup-maia.mjs
//
// The onnxruntime-web wasm runtime is NOT fetched here — the inference Worker imports
// it from node_modules via Vite `?url`, so Vite bundles it automatically.
import { mkdirSync, existsSync, createWriteStream } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

// Keep in sync with SHIPPED_LEVELS in src/engine/maia/opponent.ts (plus 1900 for the
// spike probe/tests). Each net is a GPL-3.0 Maia-1 ONNX (~3.5 MB).
const LEVELS = [1100, 1300, 1500, 1700, 1900]
const url = (lvl) => `https://huggingface.co/shermansiu/maia-${lvl}/resolve/main/model.onnx`
const path = (lvl) => `public/models/maia-${lvl}.onnx`

mkdirSync('public/models', { recursive: true })

for (const lvl of LEVELS) {
  const dest = path(lvl)
  if (existsSync(dest)) {
    console.log(`✓ ${dest} already present`)
    continue
  }
  console.log(`↓ maia-${lvl}`)
  const res = await fetch(url(lvl))
  if (!res.ok) throw new Error(`maia-${lvl} download failed: ${res.status}`)
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest))
  console.log(`✓ wrote ${dest}`)
}
console.log('Maia models ready.')
