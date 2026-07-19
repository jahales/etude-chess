import { test, expect } from '@playwright/test'
import { hasMaiaNets, MAIA_SKIP_REASON } from './maiaNets'

// #68: analyse every position of a stored game in one pass, so the move list
// shows where the game turned rather than only the moves the coach graded.

test.describe('whole-game analysis', () => {
  test.skip(!hasMaiaNets, MAIA_SKIP_REASON)

  test('analyses a stored game, scores every move, and persists the result', async ({ page }) => {
    test.setTimeout(180_000)

    // Produce a game with the eval readout OFF, so the move list starts bare and
    // any score that appears came from the pass rather than from live play.
    await page.goto('/')
    await page.getByRole('button', { name: /Play a coached game/ }).click()
    await page.getByRole('button', { name: /Play vs Maia/ }).click()
    await expect(page.getByText('Your move.')).toBeVisible({ timeout: 60_000 })
    await page.getByRole('button', { name: /Eval: on/ }).click()
    await page.locator('[data-square="e2"]').click()
    await page.locator('[data-square="e4"]').click()
    await expect(page.getByText('Your move.')).toBeVisible({ timeout: 60_000 })
    // 2.Ke2 — legal after 1.e4 whatever Black replied, and bad enough to glyph.
    await page.locator('[data-square="e1"]').click()
    await page.locator('[data-square="e2"]').click()
    await expect(page.getByText('Your move.')).toBeVisible({ timeout: 60_000 })
    await expect(page.locator('.coach-card')).toBeVisible({ timeout: 60_000 })
    await page.getByRole('button', { name: /Resign/ }).click()
    await expect(page.locator('.review')).toBeVisible()

    // Open it from the library and run the pass.
    await page.locator('.maia-actions').getByRole('button', { name: 'Home' }).click()
    await page.getByRole('button', { name: /Your games/ }).click()
    await page.locator('.games-table tbody tr').first().getByRole('button', { name: 'Review →' }).click()

    // Some moves may already carry a live eval from before the toggle; the point
    // of the pass is that *every* move ends up scored.
    const moveCount = await page.locator('.mv-jump').count()
    expect(await page.locator('.mv-score').count()).toBeLessThan(moveCount)

    await page.getByRole('button', { name: 'Analyse the whole game' }).click()
    await expect(page.getByText('Whole game analysed.')).toBeVisible({ timeout: 120_000 })
    await expect(page.locator('.mv-score')).toHaveCount(moveCount)
    const scored = moveCount

    // The pass makes the bad moves findable: 2.Ke2 is glyphed in the move list
    // and listed under "Worth studying", and clicking it jumps to the position.
    await expect(page.locator('.movelist .glyph')).not.toHaveCount(0)
    const study = page.locator('.study-list li').first()
    await expect(study).toContainText('Ke2')
    await study.locator('button').click()
    await expect(page.locator('.mv-jump.selected')).toContainText('Ke2')

    // Persisted: leaving and coming back finds it already analysed, with no
    // offer to redo the work.
    await page.getByRole('button', { name: /Back to your games/ }).click()
    await page.locator('.games-table tbody tr').first().getByRole('button', { name: 'Review →' }).click()
    await expect(page.getByText('Whole game analysed.')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Analyse the whole game' })).toBeHidden()
    expect(await page.locator('.mv-score').count()).toBe(scored)
  })
})
