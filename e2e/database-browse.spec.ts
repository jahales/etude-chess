import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, type Page } from '@playwright/test'

/**
 * Browsing and searching an attached database, end to end (#54, plan §10).
 *
 * §10's acceptance criterion exactly: import a fixture PGN, filter to one game,
 * open it. Unit tests cover the rules and the queries; what only a browser can
 * show is that a real import, a real IndexedDB and a real multiEntry index put
 * the right single row on screen, and that clicking it opens that game.
 *
 * Needs no Maia net and no engine — nothing on this path touches one. The
 * fixture is #53's, committed as an exception to the global `*.pgn` ignore
 * (game *scores* are facts, ADR 0018); the spec skips rather than fails without
 * it, like the specs that need a net.
 */

const FIXTURE = join('e2e', 'fixtures', 'sample.pgn')
const HAS_FIXTURE = existsSync(FIXTURE)

/** The fixture keeps two games: Morphy's opera game and the Evergreen. */
const MORPHY = 'Paul Morphy'
const ANDERSSEN = 'Adolf Anderssen'

/**
 * A row of the results table, by any text in it.
 *
 * Scoped to a row rather than a cell because a row's own "Open" button is
 * labelled with both players, so "the cell naming Anderssen" is two cells — and
 * scoped to the results table because the screen carries a second `games-table`
 * listing the attached files.
 */
const resultRow = (page: Page, text: string) =>
  page.locator('.results-table tbody tr', { hasText: text })

test.describe('browse the attached database', () => {
  test.skip(!HAS_FIXTURE, `missing ${FIXTURE}`)

  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.getByRole('button', { name: /Your game database/ }).click()
    await page.locator('input[type="file"]').setInputFiles(FIXTURE)
    await expect(page.getByText(/Attached 2 games from sample\.pgn/)).toBeVisible({
      timeout: 30_000,
    })
  })

  test('filters to one game and opens it', async ({ page }) => {
    // Everything imported is browsable without asking for anything.
    await expect(page.getByRole('heading', { name: 'Browse (2)' })).toBeVisible()
    await expect(resultRow(page, MORPHY)).toBeVisible()
    await expect(resultRow(page, ANDERSSEN)).toBeVisible()

    // A name narrows it to one — through the multiEntry index, and on a first
    // name, which is why the tokens are indexed rather than the whole fields.
    await page.getByLabel('Player or event', { exact: true }).fill('morphy')
    await expect(page.getByRole('heading', { name: 'Browse (1 of 2)' })).toBeVisible()
    await expect(resultRow(page, ANDERSSEN)).toBeHidden()

    // Open it.
    await page.getByRole('button', { name: new RegExp(`^Open ${MORPHY} vs `) }).click()
    await expect(page.getByRole('heading', { name: 'A game from your database' })).toBeVisible()
    await expect(page.getByRole('heading', { name: new RegExp(MORPHY) })).toBeVisible()

    // The moves are there, and so is the annotation that came with the file —
    // kept rather than stripped, which is what ADR 0018 §3 asks for.
    await expect(page.getByText('Rd8#', { exact: true })).toBeVisible()
    await expect(page.getByText(/Pinning the knight/)).toBeVisible()

    // And back to the list it was opened from.
    await page.getByRole('button', { name: '← Database' }).click()
    await expect(page.getByRole('heading', { name: /^Browse/ })).toBeVisible()
  })

  test('a filter matching nothing reads differently from an empty database', async ({ page }) => {
    await page.getByLabel('Player or event', { exact: true }).fill('nobody at all')
    await expect(page.getByText(/No games in this database match those filters/)).toBeVisible()

    // The way out is offered rather than left to be worked out.
    await page.getByRole('button', { name: 'Clear the filters' }).click()
    await expect(resultRow(page, MORPHY)).toBeVisible()
  })

  test('filters on the structured fields as well as on a name', async ({ page }) => {
    // Only the Evergreen carries ratings, and a rating floor leaves out the
    // games whose file never stated one: the opera game is unrated, not weak.
    await page.getByLabel('Min rating', { exact: true }).fill('2500')
    await expect(page.getByRole('heading', { name: 'Browse (1 of 2)' })).toBeVisible()
    await expect(resultRow(page, ANDERSSEN)).toBeVisible()
    await expect(resultRow(page, MORPHY)).toBeHidden()

    // Both fixture games are wins for White.
    await page.getByRole('button', { name: 'Clear', exact: true }).click()
    // Not `exact`: a <select> inside its <label> contributes its selected option
    // to the accessible name, so this one is "Result Any" until it isn't.
    await page.getByLabel('Result').selectOption('0-1')
    await expect(page.getByText(/No games in this database match those filters/)).toBeVisible()
  })

  test('says where to get a database, dead ends included', async ({ page }) => {
    await page.locator('summary', { hasText: 'Where to find games' }).click()
    await expect(page.getByRole('link', { name: /Lumbra/ })).toBeVisible()
    await expect(page.getByText(/crypto-casino affiliate/)).toBeVisible()
    await expect(page.getByText(/KingBase and Millionbase are both down/)).toBeVisible()
  })
})
