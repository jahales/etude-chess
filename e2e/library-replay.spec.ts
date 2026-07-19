import { test, expect } from '@playwright/test'
import { existsSync } from 'node:fs'

// v0.3 §3 (#39): a finished game is browsable and walkable. The point of the
// feature is that a flagged mistake has a way back into the position, so the
// test follows that thread end to end. Needs the Maia nets to produce a game.
const hasModel = existsSync('public/models/maia-1300.onnx')

test.describe('game library + replay', () => {
  test.skip(!hasModel, 'run `node scripts/setup-maia.mjs` to fetch the Maia nets')

  test('play → resign → jump from the review → browse the library → step through', async ({
    page,
  }) => {
    test.setTimeout(180_000) // two graded moves against the real engine

    await page.goto('/')
    await page.getByRole('button', { name: /Play a coached game/ }).click()
    await page.getByRole('button', { name: /Play vs Maia/ }).click()
    await expect(page.getByText('Your move.')).toBeVisible({ timeout: 60_000 })

    // 1. e4, then a deliberate blunder so the review has something to flag.
    await page.locator('[data-square="e2"]').click()
    await page.locator('[data-square="e4"]').click()
    await expect(page.getByText('Your move.')).toBeVisible({ timeout: 60_000 })

    // 2. Ke2 — legal after 1.e4 whatever Black replied (nothing reaches e2 in one
    // move), and bad enough to clear the review's 5% threshold.
    await page.locator('[data-square="e1"]').click()
    await page.locator('[data-square="e2"]').click()
    await expect(page.getByText('Your move.')).toBeVisible({ timeout: 60_000 })
    await expect(page.locator('.coach-card')).toBeVisible({ timeout: 60_000 })

    await page.getByRole('button', { name: /Resign/ }).click()
    await expect(page.locator('.review')).toBeVisible()

    // "Worth another look" is navigation now, not just a list: it opens the game
    // in replay at the flagged move. This is the loop v0.3 closes.
    const flagged = page.locator('.worst-jump').first()
    await expect(flagged).toContainText('Ke2')
    await flagged.click()
    await expect(page.locator('.mv-jump.selected')).toContainText('Ke2')

    // Back goes to the library, where the finished game is listed.
    await page.getByRole('button', { name: /Back to your games/ }).click()
    const row = page.locator('.games-table tbody tr').first()
    await expect(row).toContainText('Lost')
    await row.getByRole('button', { name: 'Review →' }).click()

    // Replay opens at the start and walks forward — stored data only, no engine.
    await expect(page.locator('.replay-pos')).toContainText('0 /')
    await page.getByRole('button', { name: 'Next move' }).click()
    await expect(page.locator('.replay-pos')).toContainText('1 /')
    await expect(page.locator('.mv-jump.selected')).toContainText('e4')

    // Arrow keys do the same thing.
    await page.locator('body').press('ArrowLeft')
    await expect(page.locator('.replay-pos')).toContainText('0 /')
    await page.locator('body').press('ArrowRight')
    await expect(page.locator('.mv-jump.selected')).toContainText('e4')

    // Clicking a move jumps to it.
    await page.locator('.mv-jump').nth(1).click()
    await expect(page.locator('.replay-pos')).toContainText('2 /')

    // Reviewing your own game needs the engine, not just the stored verdicts:
    // the coach only ever graded *your* moves, so every other position is
    // unexplained without this.
    const analyse = page.getByRole('button', { name: 'Analyse this position' })
    await expect(analyse).toBeVisible({ timeout: 60_000 })
    await analyse.click()
    await expect(page.locator('.lines')).toBeVisible({ timeout: 60_000 })
    await expect(page.locator('.replay-analysis .score-chip')).toBeVisible()

    // Stepping away drops the result rather than showing it against a new position.
    await page.locator('body').press('ArrowLeft')
    await expect(page.locator('.lines')).toBeHidden()
  })
})
