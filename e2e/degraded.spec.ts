import { test, expect, type Page } from '@playwright/test'

// #80: the failure paths. These are handled in code but were never exercised, so
// we did not actually know they worked. No Maia needed — everything here is
// seeded or simulated, so it runs everywhere.

/** Write a game with a move that cannot be replayed partway through. */
async function seedCorruptGame(page: Page) {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Train your chess judgment.' })).toBeVisible()

  await page.evaluate(async () => {
    const record = {
      gameId: 'corrupt',
      yourColor: 'w',
      level: 1500,
      // Legal, legal, then nonsense — a record written by older code, or damaged.
      sanHistory: ['e4', 'e5', 'Qxz9', 'Nf3'],
      outcome: 'maia',
      reason: 'resignation',
      accuracy: 50,
      takebacks: 0,
      createdAt: Date.now(),
    }
    const db: IDBDatabase = await new Promise((resolve, reject) => {
      const req = indexedDB.open('etude-chess')
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('games', 'readwrite')
      tx.objectStore('games').add(record)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
    db.close()
  })

  await page.reload()
  await page.getByRole('button', { name: /Your games/ }).click()
  await page.locator('.games-table tbody tr').first().getByRole('button', { name: 'Review →' }).click()
}

test.describe('degraded and failure paths', () => {
  test('a game that cannot be fully replayed shows what it could, and says so', async ({
    page,
  }) => {
    await seedCorruptGame(page)

    // Two of four moves are reconstructable. Losing the whole record would be the
    // wrong answer; pretending it is complete would be worse.
    await expect(page.locator('.banner.error')).toContainText('2 of 4 moves')
    await expect(page.locator('.replay-pos')).toContainText('0 / 2')

    // And what survived is still navigable.
    await page.getByRole('button', { name: 'Last move' }).click()
    await expect(page.locator('.replay-pos')).toContainText('2 / 2')
    await expect(page.locator('.mv-jump.selected')).toContainText('e5')
  })

  test('the engine failing leaves no dead buttons behind', async ({ page }) => {
    // Block the vendored Stockfish worker so the engine never starts. Match the
    // exact public asset: in dev, Vite serves the app's own `src/engine/**`
    // modules too, and a broader pattern blocks the application itself rather
    // than the engine.
    await page.route('**/engine/stockfish-18-lite-single.js', (route) => route.abort())
    await seedCorruptGame(page)

    // No offer to analyse a position or the game — the affordances are gated on
    // the engine actually being available.
    await expect(page.getByRole('button', { name: 'Analyse this position' })).toBeHidden()
    await expect(page.getByRole('button', { name: 'Analyse the whole game' })).toBeHidden()
    // The replay itself still works: it reads stored data, not the engine.
    await page.getByRole('button', { name: 'Next move' }).click()
    await expect(page.locator('.replay-pos')).toContainText('1 / 2')
  })

  test('guess mode reports an engine failure instead of hanging', async ({ page }) => {
    await page.route('**/engine/stockfish-18-lite-single.js', (route) => route.abort())
    await page.goto('/')
    await page.getByRole('button', { name: /Study a master game/ }).click()

    // Either the error banner or the still-loading notice — what must not happen
    // is a silent dead end with a Commit button that never responds.
    await expect(page.locator('.banner')).toBeVisible({ timeout: 60_000 })
  })
})
