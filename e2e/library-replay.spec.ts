import { test, expect, type Page } from '@playwright/test'
import { hasMaiaNets, MAIA_SKIP_REASON } from './maiaNets'

// v0.3 §3 (#39): a finished game is browsable and walkable. The point of the
// feature is that a flagged mistake has a way back into the position, so the
// test follows that thread end to end. Needs the Maia nets to produce a game.

/** Play 1.e4, then 2.Ke2 — legal after any Black reply, and bad enough to be flagged. */
async function playBlunderAndResign(page: Page) {
  await page.goto('/')
  await page.getByRole('button', { name: /Play a coached game/ }).click()
  await page.getByRole('button', { name: /Play vs Maia/ }).click()
  await expect(page.getByText('Your move.')).toBeVisible({ timeout: 60_000 })

  await page.locator('[data-square="e2"]').click()
  await page.locator('[data-square="e4"]').click()
  await expect(page.getByText('Your move.')).toBeVisible({ timeout: 60_000 })

  // Nothing reaches e2 in one move, so Ke2 is legal whatever Black played.
  await page.locator('[data-square="e1"]').click()
  await page.locator('[data-square="e2"]').click()
  await expect(page.getByText('Your move.')).toBeVisible({ timeout: 60_000 })
  await expect(page.locator('.coach-card')).toBeVisible({ timeout: 60_000 })

  await page.getByRole('button', { name: /Resign/ }).click()
  await expect(page.locator('.review')).toBeVisible()
}

test.describe('game library + replay', () => {
  test.skip(!hasMaiaNets, MAIA_SKIP_REASON)

  test('play → resign → jump from the review → browse the library → step through', async ({
    page,
  }) => {
    test.setTimeout(180_000) // two graded moves against the real engine
    await playBlunderAndResign(page)

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

  test('the library states whether storage is durable, and can delete a game', async ({
    page,
  }) => {
    test.setTimeout(180_000)
    await playBlunderAndResign(page)
    await page.locator('.maia-actions').getByRole('button', { name: 'Home' }).click()
    await page.getByRole('button', { name: /Your games/ }).click()

    // #78: durability is stated either way, never left to be assumed.
    await expect(page.locator('.storage-note')).toContainText(/persistent storage/i)

    // #81: a declined confirmation must leave the game alone. Deleting a game
    // destroys coach data and analysis that can't be recovered, so the dismissal
    // path matters more than the accept path.
    const before = await page.locator('.games-table tbody tr').count()
    expect(before).toBeGreaterThan(0)
    page.once('dialog', (d) => void d.dismiss())
    await page
      .locator('.games-table tbody tr')
      .first()
      .getByRole('button', { name: /Delete the/ })
      .click()
    await expect(page.locator('.games-table tbody tr')).toHaveCount(before)

    // Confirming removes it.
    page.once('dialog', (d) => void d.accept())
    await page
      .locator('.games-table tbody tr')
      .first()
      .getByRole('button', { name: /Delete the/ })
      .click()
    await expect(page.locator('.games-table tbody tr')).toHaveCount(before - 1)
  })
})
