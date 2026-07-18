import { test, expect } from '@playwright/test'

// The full guess-the-move loop against the real Stockfish engine: the one path
// unit tests can't cover (Worker + board + React together). This is what the
// flaky interactive browser pane could never verify reliably.
test('play the master move through to the graded analysis reveal', async ({ page }) => {
  await page.goto('/')

  // The engine boots (WASM Worker handshake).
  await expect(page.getByText('engine ready')).toBeVisible({ timeout: 60_000 })

  // Start the Opera Game (first card).
  await page.getByRole('button', { name: 'Study this game' }).first().click()
  await expect(page.getByText(/to move · position 1 of/)).toBeVisible()
  await expect(page.getByText('Philidor Defense')).toBeVisible() // detected opening (#5)

  // Position 1 is White to move; play the master's move Qxf3 (d1 → f3) by
  // click-to-move. The picked move should read back before we commit.
  await page.locator('[data-square="d1"]').click()
  await page.locator('[data-square="f3"]').click()
  await expect(page.getByText('Qxf3')).toBeVisible()

  // Commit and grade.
  await page.getByRole('button', { name: 'Commit move' }).click()

  // The coached reveal: a verdict, the engine's alternative lines, and a next step.
  await expect(page.getByText(/Well played|Inaccuracy|Mistake/)).toBeVisible({ timeout: 60_000 })
  await expect(page.getByText('Engine lines')).toBeVisible()
  await expect(page.getByRole('button', { name: /Next position|See summary/ })).toBeVisible()
})
