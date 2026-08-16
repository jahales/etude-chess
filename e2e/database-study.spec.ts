import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect } from '@playwright/test'

/**
 * Studying a game out of the attached database, end to end (#55, plan §11).
 *
 * §11's acceptance criteria, on the one path unit tests can't reach: a real
 * import into real IndexedDB, opened as a real guess session, graded by the real
 * engine — and the file's own note appearing at the reveal for the ply it was
 * written on, named as the file's.
 *
 * Needs the engine (grading a committed move is what produces a reveal), so the
 * waits are the generous ones `smoke.spec.ts` uses. Needs no Maia net. The
 * fixture is #53's, committed as an exception to the global `*.pgn` ignore (game
 * *scores* are facts, ADR 0018); the spec skips rather than fails without it.
 */

const FIXTURE = join('e2e', 'fixtures', 'sample.pgn')
const HAS_FIXTURE = existsSync(FIXTURE)

const MORPHY = 'Paul Morphy'

test.describe('study a game from the attached database', () => {
  test.skip(!HAS_FIXTURE, `missing ${FIXTURE}`)

  test('opens an imported game as a guess session and shows the file’s note', async ({
    page,
  }) => {
    await page.goto('/')
    await page.getByRole('button', { name: /Your game database/ }).click()
    await page.locator('#pgn-file').setInputFiles(FIXTURE)
    await expect(page.getByText(/Attached 2 games from sample\.pgn/)).toBeVisible({
      timeout: 30_000,
    })

    // Find the game and open it — the seam #54 left, now with a control on it.
    await page.getByLabel('Player or event', { exact: true }).fill('morphy')
    await page.getByRole('button', { name: new RegExp(`^Open ${MORPHY} vs `) }).click()

    // What the session will be is stated before it starts, because a database
    // row is whatever was in the file rather than something we curated: which
    // side, and how many positions it will ask for.
    await expect(page.getByText(/You take White's side, the winner's/)).toBeVisible()
    await expect(page.getByText(/13 positions to guess/)).toBeVisible()

    await page.getByRole('button', { name: 'Study this game' }).click()

    // Straight into the ordinary guess screen, titled from the row's players,
    // event and year rather than from a curated title we don't have.
    await expect(page.getByText('engine ready')).toBeVisible({ timeout: 60_000 })
    await expect(page.getByText(/to move · position 1 of 13/)).toBeVisible()
    await expect(
      page.getByRole('heading', { name: `${MORPHY} vs Duke Karl / Count Isouard, Paris Opera 1858` }),
    ).toBeVisible()
    await expect(page.getByText(/You are playing White/)).toBeVisible()

    // Commit the master's move at the first quiz position (5.Qxf3, d1→f3) —
    // which is exactly the ply the fixture carries a comment on.
    await page.locator('[data-square="d1"]').click()
    await page.locator('[data-square="f3"]').click()
    await expect(page.locator('.picked')).toHaveText('Qxf3')
    await page.getByRole('button', { name: 'Commit move' }).click()
    await expect(page.getByText(/Well played|Inaccuracy|Mistake/)).toBeVisible({ timeout: 60_000 })

    // The file's note, at the reveal, below our why and attributed to the file
    // — the whole point of §11. Both blocks say whose they are, so the engine's
    // sentence and the annotator's can't be read as one voice.
    await expect(page.getByText(/Recapturing towards the centre/)).toBeVisible()
    await expect(page.getByText(/the file's own note on this move/)).toBeVisible()
    await expect(page.getByText(/étude's reading, computed from the engine/)).toBeVisible()
    await expect(page.locator('.source-note').getByText('sample.pgn')).toBeVisible()
  })

  test('a game the file left unannotated reveals with no note at all', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('button', { name: /Your game database/ }).click()
    await page.locator('#pgn-file').setInputFiles(FIXTURE)
    await expect(page.getByText(/Attached 2 games from sample\.pgn/)).toBeVisible({
      timeout: 30_000,
    })

    // The Evergreen carries no comments in the fixture.
    await page.getByLabel('Player or event', { exact: true }).fill('dufresne')
    await page.getByRole('button', { name: /^Open Adolf Anderssen vs / }).click()
    await page.getByRole('button', { name: 'Study this game' }).click()

    await expect(page.getByText('engine ready')).toBeVisible({ timeout: 60_000 })
    await expect(page.getByText(/to move · position 1 of 20/)).toBeVisible()

    // 5.c3 is the Evergreen's first quiz position (ply 8, c2→c3).
    await page.locator('[data-square="c2"]').click()
    await page.locator('[data-square="c3"]').click()
    await expect(page.locator('.picked')).toHaveText('c3')
    await page.getByRole('button', { name: 'Commit move' }).click()
    await expect(page.getByText(/Well played|Inaccuracy|Mistake/)).toBeVisible({ timeout: 60_000 })

    await expect(page.locator('.source-note')).toHaveCount(0)
    await expect(page.getByText(/the file's own note/)).toBeHidden()
  })
})
