import { test, expect } from '@playwright/test'

// The full guess-the-move loop against the real Stockfish engine: the one path
// unit tests can't cover (Worker + board + React together). This is what the
// flaky interactive browser pane could never verify reliably.
test('play the master move through to the graded analysis reveal', async ({ page }) => {
  await page.goto('/')

  // Home is a chooser (v0.3): pick the mode, then the game. The engine pill only
  // appears on screens that actually use an engine, so wait for it after the hop.
  await page.getByRole('button', { name: /Study a master game/ }).click()
  await expect(page.getByText('engine ready')).toBeVisible({ timeout: 60_000 })
  await page.getByRole('button', { name: 'Study this game' }).first().click()
  await expect(page.getByText(/to move · position 1 of/)).toBeVisible()
  await expect(page.getByText('Philidor Defense')).toBeVisible() // detected opening (#5)

  // How the position arrived (#160). The quiz opens at ply 8, so the very first
  // item does have a move before it — Black's 4…Bxf3 — and it must be that move
  // and not a stand-in. Asserted on the squares as well as in words because the
  // mark is the part a reader actually uses, and it is the part a jsdom test
  // cannot see: this is a real board, sized and painted.
  await expect(page.getByText('4…Bxf3')).toBeVisible()
  for (const square of ['g4', 'f3']) {
    const mark = page.locator(`[data-square="${square}"] > *`).first()
    await expect(mark).toHaveCSS('box-shadow', /inset/)
  }
  // …and only those two.
  const marked = await page.locator('[data-square] > *').evaluateAll(
    (els) => els.filter((el) => getComputedStyle(el).boxShadow.includes('inset')).length,
  )
  expect(marked).toBe(2)

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

  // …and the move *you* played, scored and continued (#151). The second move
  // being on screen is the assertion that matters: the continuation is the
  // second search's own pv coming back through the real Worker, and a version
  // of this that lost it would still render your move and still pass every
  // other check on this page.
  const played = page.locator('.played-line')
  await expect(played).toContainText('The move you played')
  await expect(played.locator('.line-move').first()).toHaveText('Qxf3')
  await expect(played.locator('.line-move').nth(1)).toBeVisible()
})
