import { test, expect } from '@playwright/test'
import { existsSync } from 'node:fs'

// v0.2: play vs Maia with the ambient in-game coach (ADR 0017). You move → Maia replies
// immediately → the coach grades your move, with the best move hidden behind "Show me";
// you can take the pair back. Needs the nets (node scripts/setup-maia.mjs); skips otherwise.
const hasModel = existsSync('public/models/maia-1300.onnx')

test.describe('play vs Maia + ambient coach', () => {
  test.skip(!hasModel, 'run `node scripts/setup-maia.mjs` to fetch the Maia nets')

  test('move → Maia replies → coach feedback → show me → take back', async ({ page }) => {
    await page.goto('/')

    await page.getByRole('button', { name: /Play vs Maia/ }).click()
    await expect(page.getByText('Your move.')).toBeVisible({ timeout: 60_000 })

    // Play 1.e4 — committed immediately, no acknowledge gate.
    await page.locator('[data-square="e2"]').click()
    await page.locator('[data-square="e4"]').click()
    await expect(page.locator('.movelist')).toContainText('e4')

    // Maia replies and the turn returns to you.
    await expect(page.getByText('Your move.')).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('.movelist li').first().locator('.mv-cell')).toHaveCount(2)

    // Coach feedback appears; the better move stays hidden until "Show me".
    await expect(page.getByText('Good move.')).toBeVisible({ timeout: 30_000 })
    const showMe = page.getByRole('button', { name: /Show me/ })
    await expect(showMe).toBeVisible()

    // Reveal the engine's answer + lines.
    await showMe.click()
    await expect(page.getByText(/Engine.s pick/)).toBeVisible({ timeout: 30_000 })

    // Take back the pair → the move list empties.
    await page.getByRole('button', { name: /Take back/ }).click()
    await expect(page.locator('.movelist')).toBeEmpty()
  })
})
