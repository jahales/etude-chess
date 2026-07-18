// Browser entry for the Maia spike probe (maia-probe.html). Proves the full
// in-browser path: Vite-bundled module Worker + onnxruntime-web wasm + model fetch
// + encode/decode. Driven headlessly by e2e/maia-probe.spec.ts. Not part of the app.

import { MaiaOnnxOpponent } from './maiaOpponent'

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
const AFTER_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1'

const el = document.getElementById('result')!

async function run() {
  const t0 = performance.now()
  const maia = new MaiaOnnxOpponent()
  await maia.ready()
  const readyMs = Math.round(performance.now() - t0)

  const best = await maia.move(START)
  const whiteTop = (await maia.policy(START, { temperature: 1 })).slice(0, 5)
  const blackTop = (await maia.policy(AFTER_E4, { temperature: 1 })).slice(0, 5)

  el.textContent = JSON.stringify(
    {
      readyMs,
      best,
      whiteTop5: whiteTop.map((m) => `${m.uci} ${(m.prob * 100) | 0}%`),
      blackTop5: blackTop.map((m) => `${m.uci} ${(m.prob * 100) | 0}%`),
    },
    null,
    2,
  )
  el.setAttribute('data-state', 'done')
  el.setAttribute('data-best', best.uci)
}

run().catch((err) => {
  el.textContent = 'ERROR: ' + (err instanceof Error ? err.message : String(err))
  el.setAttribute('data-state', 'error')
})
