import { test, expect } from '@playwright/test'

// Spike proof: the Maia-1 net actually runs in the browser — Vite-bundled module
// Worker + onnxruntime-web wasm + model fetch + our 112-plane encode / 1858 decode —
// and returns a legal, human-like move. Needs the binaries in place:
//   node scripts/setup-maia.mjs
// Skipped automatically if the model isn't present, so it never breaks CI.
import { existsSync } from 'node:fs'

const hasModel = existsSync('public/models/maia-1900.onnx')

test.describe('Maia ONNX in-browser', () => {
  test.skip(!hasModel, 'run `node scripts/setup-maia.mjs` to fetch the Maia model + wasm')

  test('runs Maia-1900 in a Worker and returns a human-like move', async ({ page }) => {
    await page.goto('/maia-probe.html')

    const result = page.locator('#result')
    await expect(result).toHaveAttribute('data-state', 'done', { timeout: 60_000 })

    const best = await result.getAttribute('data-best')
    const commonWhite = ['e2e4', 'd2d4', 'g1f3', 'c2c4', 'e2e3', 'd2d3', 'g2g3', 'b1c3']
    expect(commonWhite).toContain(best)

    console.log('Maia probe:', await result.textContent())
  })
})
