import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect } from '@playwright/test'
import { BATCH_NODES } from '../src/app/gameAnalysis'

/**
 * Review mode end to end (#144).
 *
 * Unit tests cover the rules and jsdom covers the wording; what only a browser
 * can show is that the composition *runs* — a real import into real IndexedDB,
 * a real WASM pass over every position, a real session over the plies that pass
 * selected, and a reveal whose engine lines can actually be walked. #131 shipped
 * with click-to-move silently broken under passing jsdom tests, which is the
 * specific reason the move here is made by clicking squares rather than by
 * dispatching anything.
 *
 * The fixture is #53's, committed as an exception to the global `*.pgn` ignore
 * (game *scores* are facts, ADR 0018); the spec skips rather than fails without
 * it. No Maia net needed. The pass is the slow part — 48 searches at the default
 * budget — so the waits are generous and the timeout is raised.
 */

const FIXTURE = join('e2e', 'fixtures', 'sample.pgn')
const HAS_FIXTURE = existsSync(FIXTURE)

/** The Evergreen's loser. Reviewing a game you *lost* is the point of the mode. */
const LOSER = 'Jean Dufresne'
const NODE_LABEL = `${Math.round(BATCH_NODES / 1000)}k`

test.describe('review a game you played', () => {
  test.skip(!HAS_FIXTURE, `missing ${FIXTURE}`)

  test('analyses a game, then works what the pass could see and the whole game', async ({
    page,
  }) => {
    test.setTimeout(300_000)

    await page.goto('/')
    await page.getByRole('button', { name: /Your game database/ }).click()
    await page.locator('input[type="file"]').setInputFiles(FIXTURE)
    await expect(page.getByText(/Attached 2 games from sample\.pgn/)).toBeVisible({
      timeout: 30_000,
    })

    // Into the mode, and say who we are — without a name nothing can tell which
    // side of a game was ours, which is what the ordering rests on.
    await page.getByRole('button', { name: '← Home' }).click()
    await page.getByRole('button', { name: /Review a game you played/ }).click()
    await page.locator('details.study-you summary').click()
    await page.getByLabel(/names you play under/).fill(LOSER)
    await page.getByRole('button', { name: 'Save' }).click()

    // The picker knows it was a loss, and says so from *our* side.
    const row = page.locator('.games-table tbody tr').filter({ hasText: 'Dufresne' })
    await expect(row).toContainText('Lost as Black')
    await expect(row).toContainText('—') // not analysed yet
    await row.getByRole('button', { name: /^Review / }).click()

    // What it will cost, and what it cannot do, before the button that runs it.
    await expect(page.getByText(new RegExp(`\\d+ searches`))).toBeVisible()
    await expect(page.getByText(new RegExp(`${NODE_LABEL} nodes each`))).toBeVisible()
    await expect(page.getByText(/What this pass cannot do/)).toBeVisible()

    // The refusal that matters: no list at all until every move has been measured.
    await expect(
      page.getByRole('heading', { name: 'The positions this pass could see' }),
    ).toBeVisible()
    await expect(page.getByText(/analyse the game first/i)).toBeVisible()
    await expect(page.getByRole('button', { name: /Re-decide/ })).toBeHidden()

    // The whole-game path is open regardless — it grades per move as you commit.
    const wholeGame = page.getByRole('button', { name: /Work all \d+ positions/ })
    await expect(wholeGame).toBeVisible()

    await page.getByRole('button', { name: 'Analyse this game' }).click()
    await expect(page.locator('.analysis-progress')).toBeVisible()
    await expect(
      page.getByText(new RegExp(`Analysed — every position measured at ${NODE_LABEL} nodes`)),
    ).toBeVisible({ timeout: 240_000 })

    // Findings, and the claim they are allowed to support — never "the critical
    // positions in this game" at a budget a browser can afford (§9, §12).
    await expect(page.locator('.moment-list li').first()).toBeVisible()
    await expect(page.getByText(/list is a floor, not a ceiling/)).toBeVisible()
    const redecide = page.getByRole('button', { name: /Re-decide \d+ positions?/ })
    const promised = Number((await redecide.textContent())!.match(/\d+/)![0])

    // The narrowed session: the ordinary screen, asking exactly what was promised.
    await redecide.click()
    await expect(page.getByText(new RegExp(`position 1 of ${promised}\\b`))).toBeVisible()
    await expect(page.getByText(/You are playing Black/)).toBeVisible()

    // Back out and take the other path, where the first position is the same
    // every run: 5…Ba5 in the Evergreen, b4→a5. A session has no back link of
    // its own — the brand is the way out, as it is from every mode.
    await page.getByRole('button', { name: 'Home', exact: true }).click()
    await page.getByRole('button', { name: /Review a game you played/ }).click()
    await page
      .locator('.games-table tbody tr')
      .filter({ hasText: 'Dufresne' })
      .getByRole('button', { name: /^Review / })
      .click()
    // Coming back finds the work already done rather than offering to redo it.
    await expect(page.getByRole('button', { name: 'Analyse this game' })).toBeHidden()
    await page.getByRole('button', { name: /Work all \d+ positions/ }).click()

    await expect(page.getByText('engine ready')).toBeVisible({ timeout: 60_000 })
    await expect(page.getByText(/position 1 of \d+/)).toBeVisible()

    // Click-to-move on the real board — the path #131 shipped broken.
    await page.locator('[data-square="b4"]').click()
    await page.locator('[data-square="a5"]').click()
    await expect(page.locator('.picked')).toHaveText('Ba5')
    await page.getByRole('button', { name: 'Commit move' }).click()
    await expect(page.getByText(/Well played|Inaccuracy|Mistake/)).toBeVisible({ timeout: 60_000 })

    // #131's explorable lines, unchanged by this mode: click a move in a line and
    // the board walks into it, saying plainly that it is no longer the game.
    await page.locator('.line-move').first().click()
    await expect(page.locator('.exploring')).toContainText('Exploring')
    // Scoped: the board ribbon, the transport and the exploring bar all offer a
    // way back, which is deliberate — this picks the one on the bar.
    await page.locator('.exploring-back').click()
    await expect(page.locator('.exploring')).toHaveCount(0)
  })

  test('a game with no name on it is still reviewable, from a side you pick', async ({ page }) => {
    test.setTimeout(120_000)

    await page.goto('/')
    await page.getByRole('button', { name: /Your game database/ }).click()
    await page.locator('input[type="file"]').setInputFiles(FIXTURE)
    await expect(page.getByText(/Attached 2 games from sample\.pgn/)).toBeVisible({
      timeout: 30_000,
    })

    // No names given at all: nothing can say which side was ours, so the picker
    // says so rather than ordering the list as though it knew.
    await page.getByRole('button', { name: '← Home' }).click()
    await page.getByRole('button', { name: /Review a game you played/ }).click()
    await expect(page.getByText(/Tell us the names you play under/)).toBeVisible()

    // The Opera game is decisive, so the winner's side is the one offered — the
    // pack's rule, which only your own name overrides (#130).
    await page
      .locator('.games-table tbody tr')
      .filter({ hasText: 'Morphy' })
      .getByRole('button', { name: /^Review / })
      .click()
    // Decisive and not ours: exactly one side is worth taking, so it is stated
    // rather than offered as a choice there is nothing to choose from.
    await expect(page.getByText(/reviewed as the winner/)).toBeVisible()
    await expect(page.locator('.review-side')).toContainText('White')
    await expect(page.getByRole('button', { name: 'Black' })).toBeHidden()
  })
})
