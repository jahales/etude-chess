import { test, expect } from '@playwright/test'

// v0.3 §2: Home is a chooser, each mode gets a focused setup screen, and every
// screen has a way back. No Maia nets needed — this never starts a game.
test.describe('home chooser navigation', () => {
  test('Home → each setup screen → back to Home', async ({ page }) => {
    await page.goto('/')

    const home = page.getByRole('heading', { name: 'Train your chess judgment.' })
    await expect(home).toBeVisible()

    // Play: cards lead to setup, not straight into a game.
    await page.getByRole('button', { name: /Play a coached game/ }).click()
    await expect(page.getByRole('heading', { name: 'Play a coached game' })).toBeVisible()
    await expect(page.getByRole('button', { name: /Play vs Maia/ })).toBeVisible()
    await page.getByRole('button', { name: '← Home' }).click()
    await expect(home).toBeVisible()

    // Study: same shape.
    await page.getByRole('button', { name: /Study a master game/ }).click()
    await expect(page.getByRole('heading', { name: 'Study a master game' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Study this game' }).first()).toBeVisible()
    await page.getByRole('button', { name: '← Home' }).click()
    await expect(home).toBeVisible()
  })

  test('the analysis-settings gear appears only on guess screens', async ({ page }) => {
    await page.goto('/')
    const gear = page.getByRole('button', { name: 'Analysis settings' })

    // Home and the Maia setup screen don't grade guesses, so the gear would be dead UI.
    await expect(gear).toBeHidden()
    await page.getByRole('button', { name: /Play a coached game/ }).click()
    await expect(gear).toBeHidden()
    await page.getByRole('button', { name: '← Home' }).click()

    // It belongs on the guess side, where it configures grading.
    await page.getByRole('button', { name: /Study a master game/ }).click()
    await expect(gear).toBeVisible()
    await gear.click()
    await expect(page.getByText('Engine strength')).toBeVisible()
  })
})
