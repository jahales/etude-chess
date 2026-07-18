import { test, expect } from '@playwright/test'
import { existsSync } from 'node:fs'

// v0.2: play vs client-side Maia with the in-game coach (ADR 0017) — you move, the
// coach grades it (take back / continue), then Maia replies with a legal move. Needs
// the nets (node scripts/setup-maia.mjs); skips otherwise so CI is unaffected.
const hasModel = existsSync('public/models/maia-1300.onnx')

test.describe('play vs Maia + coach', () => {
  test.skip(!hasModel, 'run `node scripts/setup-maia.mjs` to fetch the Maia nets')

  test('you move → coached → continue → Maia replies', async ({ page }) => {
    await page.goto('/')

    await page.getByRole('button', { name: /Play vs Maia/ }).click()
    await expect(page.getByText('Your move.')).toBeVisible({ timeout: 60_000 })

    // Play 1.e4 by click-to-move.
    await page.locator('[data-square="e2"]').click()
    await page.locator('[data-square="e4"]').click()

    // The coach grades it before Maia replies: a verdict + Continue appear. The move
    // stays pending (not yet in the move list) so it can be taken back.
    const continueBtn = page.getByRole('button', { name: /Continue/ })
    await expect(continueBtn).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText('Good move.')).toBeVisible()
    await expect(page.locator('.movelist')).toBeEmpty()

    // Continue → the move is committed, Maia replies, and the turn returns to you.
    await continueBtn.click()
    await expect(page.locator('.movelist')).toContainText('e4')
    await expect(page.getByText('Your move.')).toBeVisible({ timeout: 30_000 })
    // First row now holds both your move and Maia's reply.
    await expect(page.locator('.movelist li').first().locator('.mv-cell')).toHaveCount(2)
  })
})
