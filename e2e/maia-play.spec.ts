import { test, expect } from '@playwright/test'
import { existsSync } from 'node:fs'

// v0.2: play a real move against client-side Maia and get a legal human reply.
// Needs the nets in place (node scripts/setup-maia.mjs); skips otherwise so CI is
// unaffected.
const hasModel = existsSync('public/models/maia-1300.onnx')

test.describe('play vs Maia', () => {
  test.skip(!hasModel, 'run `node scripts/setup-maia.mjs` to fetch the Maia nets')

  test('you move, Maia replies with a legal move', async ({ page }) => {
    await page.goto('/')

    // Start a game as White vs the default level (1300).
    await page.getByRole('button', { name: /Play vs Maia/ }).click()

    // Maia loads, then it's your move.
    await expect(page.getByText('Your move.')).toBeVisible({ timeout: 60_000 })

    // Play 1.e4 by click-to-move.
    await page.locator('[data-square="e2"]').click()
    await page.locator('[data-square="e4"]').click()

    const movelist = page.locator('.movelist')
    await expect(movelist).toContainText('e4')

    // Maia thinks, then replies — the turn comes back to you and a black move appears.
    await expect(page.getByText('Your move.')).toBeVisible({ timeout: 30_000 })
    const firstRow = movelist.locator('li').first()
    // row = [number, white move, black move]; the black cell should be filled.
    await expect(firstRow.locator('span').nth(2)).not.toBeEmpty()
  })
})
