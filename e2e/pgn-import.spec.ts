import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect } from '@playwright/test'

/**
 * Attaching your own PGN database, end to end (#53, docs/v0.3.0-plan.md §9).
 *
 * The one path unit tests can't cover: a real file going through a real Web
 * Worker into real IndexedDB. Needs no Maia net and no engine — the import
 * never touches one.
 *
 * The fixture is committed (game *scores* are facts, ADR 0018), but the spec
 * skips rather than fails if it isn't there, like the specs that need a net.
 */

const FIXTURE = join('e2e', 'fixtures', 'sample.pgn')
const HAS_FIXTURE = existsSync(FIXTURE)

test.describe('attach your own game database', () => {
  test.skip(!HAS_FIXTURE, `missing ${FIXTURE}`)

  test('imports a PGN, keeps the classical games and says what it dropped', async ({ page }) => {
    await page.goto('/')

    await page.getByRole('button', { name: /Your game database/ }).click()
    await expect(page.getByRole('heading', { name: 'Your game database' })).toBeVisible()

    await page.locator('#pgn-file').setInputFiles(FIXTURE)

    // Two of the fixture's games are classical with a known-or-unknown clock;
    // the rest are blitz, a stub, or not games at all.
    await expect(page.getByText(/Attached 2 games from sample\.pgn/)).toBeVisible({
      timeout: 30_000,
    })
    await expect(page.getByText(/blitz, rapid or bullet/)).toBeVisible()
    await expect(page.getByText(/too short/)).toBeVisible()

    // What is attached is listed, with the file it came from — provenance is
    // what makes re-attaching after an eviction a known operation.
    await expect(page.getByRole('cell', { name: 'sample.pgn', exact: true })).toBeVisible()
    await expect(page.getByText(/Keep the PGN file\./)).toBeVisible()
  })

  test('re-attaching the same file updates it instead of duplicating it', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('button', { name: /Your game database/ }).click()

    await page.locator('#pgn-file').setInputFiles(FIXTURE)
    await expect(page.getByText(/Attached 2 games/)).toBeVisible({ timeout: 30_000 })

    await page.locator('#pgn-file').setInputFiles(FIXTURE)
    // The picker is disabled while an import runs, so this waits for the second
    // one to finish before counting.
    await expect(page.locator('#pgn-file')).toBeEnabled({ timeout: 30_000 })
    await expect(page.getByRole('heading', { name: /^Attached \(2 games\)$/ })).toBeVisible()

    // Home reports the same count: importing twice is idempotent by the dedup
    // key, which is what makes "just attach it again" safe advice.
    await page.getByRole('button', { name: '← Home' }).click()
    await expect(page.getByText('2 games attached')).toBeVisible()
  })

  test('detaching a database removes its games', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('button', { name: /Your game database/ }).click()
    await page.locator('#pgn-file').setInputFiles(FIXTURE)
    await expect(page.getByText(/Attached 2 games/)).toBeVisible({ timeout: 30_000 })

    page.once('dialog', (d) => void d.accept())
    await page.getByRole('button', { name: 'Detach sample.pgn' }).click()

    await expect(page.getByRole('cell', { name: 'sample.pgn', exact: true })).toBeHidden()
    await page.getByRole('button', { name: '← Home' }).click()
    await expect(page.getByText('games attached')).toBeHidden()
  })
})
