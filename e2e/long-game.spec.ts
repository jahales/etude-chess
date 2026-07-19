import { test, expect, type Page } from '@playwright/test'
import { Chess } from 'chess.js'
import { GAMES } from '../src/content/games'

// #79: every other e2e uses a 2-4 move game. A real game is 40-50 plies, which is
// where the move list, the transport and the study list either hold up or quietly
// don't. Seeded straight into IndexedDB rather than played out — no Maia needed,
// deterministic, and it exercises exactly the stored-game path the library reads.

const evergreen = GAMES.find((g) => g.id === 'evergreen-1852')!
const sanHistory = (() => {
  const c = new Chess()
  c.loadPgn(evergreen.pgn)
  return c.history()
})()

/** Write a finished game straight into the app's Dexie store. */
async function seedLongGame(page: Page) {
  await page.goto('/')
  // Let the app open (and upgrade) the database before writing to it.
  await expect(page.getByRole('heading', { name: 'Train your chess judgment.' })).toBeVisible()

  await page.evaluate(
    async ({ sans }) => {
      const record = {
        gameId: 'seeded-long-game',
        yourColor: 'w',
        level: 1500,
        sanHistory: sans,
        outcome: 'you',
        reason: 'checkmate',
        accuracy: 82.5,
        takebacks: 1,
        createdAt: Date.now(),
        // A coach entry deep in the game, so "Worth another look" and the coach
        // panel are exercised at a real ply rather than near the start.
        coachLog: [
          { ply: 40, fen: 'x', san: sans[40], tier: 'C', swing: 28, bestMoveSan: null },
        ],
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
    },
    { sans: sanHistory },
  )

  await page.reload()
  await page.getByRole('button', { name: /Your games/ }).click()
  await page.locator('.games-table tbody tr').first().getByRole('button', { name: 'Review →' }).click()
}

test.describe('a full-length game in the library', () => {
  test('replays end to end with the move list tracking the cursor', async ({ page }) => {
    await seedLongGame(page)

    const lastCursor = sanHistory.length
    await expect(page.locator('.replay-pos')).toContainText(`0 / ${lastCursor}`)
    await expect(page.locator('.mv-jump')).toHaveCount(sanHistory.length)

    // Jump to the end. The move list is a scroll box, so the selected move has to
    // be brought into view — on a 47-ply game it is far below the fold, and a
    // cursor you cannot see is a transport that does not work.
    await page.getByRole('button', { name: 'Last move' }).click()
    await expect(page.locator('.replay-pos')).toContainText(`${lastCursor} / ${lastCursor}`)

    const selected = page.locator('.mv-jump.selected')
    await expect(selected).toHaveCount(1)
    await expect(selected).toBeInViewport()

    // And stepping backwards keeps it in view too.
    for (let i = 0; i < 12; i++) await page.locator('body').press('ArrowLeft')
    await expect(page.locator('.mv-jump.selected')).toBeInViewport()
  })

  test('the board matches the move list at the end of a long game', async ({ page }) => {
    await seedLongGame(page)
    await page.getByRole('button', { name: 'Last move' }).click()

    // The final position of the Evergreen Game is mate; the last move must be the
    // one the fixture ends on, not an off-by-one neighbour.
    await expect(page.locator('.mv-jump.selected')).toContainText(sanHistory[sanHistory.length - 1]!)

    await page.getByRole('button', { name: 'First move' }).click()
    await expect(page.locator('.replay-pos')).toContainText('0 /')
    await expect(page.locator('.mv-jump.selected')).toHaveCount(0) // nothing selected at the start
  })

  test('the coach entry appears at the ply it belongs to, deep in the game', async ({ page }) => {
    await seedLongGame(page)
    // The seeded coach entry is at ply 40, so cursor 41 selects it.
    await page.locator('.mv-jump').nth(40).click()
    await expect(page.locator('.replay-pos')).toContainText('41 /')
    await expect(page.locator('.replay-coach')).toContainText(sanHistory[40]!)
    await expect(page.locator('.replay-coach')).toContainText('Mistake')
  })
})
