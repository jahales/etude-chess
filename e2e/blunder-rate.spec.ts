import { test, expect, type Page } from '@playwright/test'
import { BATCH_NODES } from '../src/app/gameAnalysis'

// #65: the blunder rate per game, the project's leading indicator
// (docs/development-focus.md §Measurement, ADR 0027).
//
// The feature is not the arithmetic — it is *which games are allowed into it*,
// and that the sample is stated. So this seeds the records directly rather than
// playing games: it needs no Maia nets and no engine, and it can assert on an
// exact figure, which a real game could never give us.

interface Seed {
  gameId: string
  createdAt: number
  analysed: boolean
}

/**
 * Two games with the same moves. You are White, so plies 0 and 2 are yours, and
 * `evalByPly` puts a 42-point collapse on ply 2 — a blunder by the same
 * threshold the move list glyphs `??` with.
 */
async function seedGames(page: Page, seeds: Seed[], batchNodes = BATCH_NODES) {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Train your chess judgment.' })).toBeVisible()

  await page.evaluate(
    async ({ seeds, batchNodes }) => {
      const ev = (whitePct: number) => ({ whitePct, label: `${whitePct}` })
      const records = seeds.map((seed) => ({
        gameId: seed.gameId,
        yourColor: 'w',
        level: 1500,
        sanHistory: ['e4', 'e5', 'Ke2', 'Nf6'],
        outcome: 'maia',
        reason: 'resignation',
        accuracy: 50,
        takebacks: 0,
        createdAt: seed.createdAt,
        ...(seed.analysed
          ? {
              analysedAt: seed.createdAt,
              analysisNodes: batchNodes,
              startEval: ev(50),
              // ply 0: 50→52 (you gained) · ply 2: 50→8 (you gave up 42)
              evalByPly: [ev(52), ev(50), ev(8), ev(9)],
            }
          : {}),
      }))

      const db: IDBDatabase = await new Promise((resolve, reject) => {
        const req = indexedDB.open('etude-chess')
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      })
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('games', 'readwrite')
        for (const record of records) tx.objectStore('games').add(record)
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
      db.close()
    },
    { seeds, batchNodes },
  )

  await page.reload()
  await page.getByRole('button', { name: /Your games/ }).click()
}

/** The Blunders column: Played · You · Maia · Result · Accuracy · **Blunders**. */
function blundersCell(page: Page, row: number) {
  return page.locator('.games-table tbody tr').nth(row).locator('td').nth(5)
}

test.describe('blunder rate per game', () => {
  test('counts only analysed games, and states the sample it rests on', async ({ page }) => {
    await seedGames(page, [
      { gameId: 'analysed', createdAt: 2_000, analysed: true },
      { gameId: 'raw', createdAt: 1_000, analysed: false },
    ])

    const rate = page.locator('.blunder-rate')
    // One blunder in the one game that has been analysed.
    await expect(rate).toContainText('1.00 blunders per game')
    await expect(rate).toContainText('over 1 game')
    // The unanalysed game is excluded and *said* to be excluded — the whole point
    // of the metric. A partial analysis grades your early moves first, so folding
    // it in would read better than the games were (#74).
    await expect(rate).toContainText('1 game not counted')
    // n is small, and the number says so rather than wearing two decimal places
    // as if it were settled.
    await expect(rate).toContainText('Too few games')
    // No progress bar, no goal, no trend: it is a leading indicator, not a score
    // (constitution §9, §12).
    await expect(rate.locator('[role="progressbar"]')).toHaveCount(0)

    // Per row, so the total above is checkable against the games it came from.
    await expect(page.locator('.games-table tbody tr')).toHaveCount(2)
    await expect(blundersCell(page, 0)).toHaveText('1')
    await expect(blundersCell(page, 1)).toContainText('not analysed')
  })

  test('reports no rate at all when nothing has been analysed', async ({ page }) => {
    await seedGames(page, [{ gameId: 'raw', createdAt: 1_000, analysed: false }])

    // Not "0.00 per game", which reads as a perfect record over games nobody
    // measured. And it says how to make the number exist.
    const rate = page.locator('.blunder-rate')
    await expect(rate).toContainText('No blunder rate yet')
    await expect(rate).not.toContainText('per game')
    await expect(rate).toContainText('Analyse the whole game')
  })

  test('will not count a pass run at a different budget', async ({ page }) => {
    // Swings differenced across two node budgets are manufactured, not measured —
    // the same reason the move list withholds its glyphs until a uniform pass.
    await seedGames(page, [{ gameId: 'stale', createdAt: 1_000, analysed: true }], 40_000)

    await expect(page.locator('.blunder-rate')).toContainText('No blunder rate yet')
    await expect(blundersCell(page, 0)).toContainText('not analysed')
  })
})
