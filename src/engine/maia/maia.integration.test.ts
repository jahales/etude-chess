// @vitest-environment node
//
// End-to-end feasibility proof for the Maia-1 client-side pipeline: encode a FEN →
// run the real Maia-1900 ONNX through onnxruntime-web (wasm) → decode a legal,
// human-like move. Opt-in (loads a 3.5 MB model + wasm), so it stays out of the
// fast `npm run verify` suite:
//
//   RUN_MAIA_MODEL=1 npx vitest run src/engine/maia/maia.integration.test.ts
//
// onnxruntime-web's wasm backend runs in Node too, so this exercises the exact
// runtime the browser worker will use.

import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { encodeFen, INPUT_SHAPE } from './encoding'
import { decodePolicy } from './decoding'

const MODEL = 'public/models/maia-1900.onnx'
const run = process.env.RUN_MAIA_MODEL === '1' && existsSync(MODEL)
const d = run ? describe : describe.skip

d('Maia-1900 ONNX end-to-end', () => {
  it('returns a human-like top move for the start position and for black', async () => {
    const ort = await import('onnxruntime-web')
    ort.env.wasm.numThreads = 1
    const session = await ort.InferenceSession.create(readFileSync(MODEL))

    async function bestMoves(fen: string) {
      const input = new ort.Tensor('float32', encodeFen(fen), INPUT_SHAPE as unknown as number[])
      const out = await session.run({ '/input/planes': input })
      const policy = out['/output/policy']?.data as Float32Array
      return decodePolicy(policy, fen, { temperature: 1 })
    }

    const start = await bestMoves('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1')
    console.log('START top5:', start.slice(0, 5).map((m) => `${m.uci} ${(m.prob * 100) | 0}%`))
    const commonWhite = ['e2e4', 'd2d4', 'g1f3', 'c2c4', 'e2e3', 'd2d3', 'g2g3', 'b1c3']
    expect(commonWhite).toContain(start[0]?.uci)

    const black = await bestMoves('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1')
    console.log('1.e4 black top5:', black.slice(0, 5).map((m) => `${m.uci} ${(m.prob * 100) | 0}%`))
    const commonBlack = ['e7e5', 'c7c5', 'e7e6', 'c7c6', 'd7d5', 'g8f6', 'd7d6', 'g7g6']
    expect(commonBlack).toContain(black[0]?.uci)
  })
})
