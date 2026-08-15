import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect } from '@playwright/test'

/**
 * Taking your own side of a game you played (#130).
 *
 * The domain rule is unit-tested (`domain/studyGame.yourSide`, `studySides`) and
 * the list of names is too (`app/settings`). What only a browser can show is the
 * loop between them: names typed into the study control, kept in `localStorage`,
 * read back on the next game, and deciding which side the control offers first.
 *
 * The fixture's games are Morphy wins, so **claiming the losing side is the
 * point** — before #130 the winner rule made exactly that side unreachable.
 * Needs no engine and no Maia net: everything asserted here happens before a
 * session starts.
 */

const FIXTURE = join('e2e', 'fixtures', 'sample.pgn')
const HAS_FIXTURE = existsSync(FIXTURE)

const LOSER = 'Duke Karl / Count Isouard'

test.describe('study your own side', () => {
  test.skip(!HAS_FIXTURE, `missing ${FIXTURE}`)

  test('offers the side you played of a game you lost, and remembers who you are', async ({
    page,
  }) => {
    await page.goto('/')
    await page.getByRole('button', { name: /Your game database/ }).click()
    await page.locator('input[type="file"]').setInputFiles(FIXTURE)
    await expect(page.getByText(/Attached 2 games from sample\.pgn/)).toBeVisible({
      timeout: 30_000,
    })

    await page.getByLabel('Player or event', { exact: true }).fill('morphy')
    await page.getByRole('button', { name: /^Open Paul Morphy vs / }).click()

    // Nobody has said who they are yet, so this is still the winner's game.
    await expect(page.getByText(/You take White's side, the winner's/)).toBeVisible()

    await page.getByText('Is this one of your games?').click()
    await page.getByLabel(/The names you play under/).fill(`quiet_etude\n${LOSER}`)
    await page.getByRole('button', { name: 'Save' }).click()

    // Black is the side that lost, which is the side that is now offered first.
    const buttons = page.locator('.study-buttons button')
    await expect(buttons.first()).toHaveText('Study your side (Black)')
    await expect(buttons.nth(1)).toHaveText('Study as White')
    await expect(page.getByText(/You played Black here, so your side comes first/)).toBeVisible()
    await expect(page.getByText(/graded against the engine rather than against what was played/))
      .toBeVisible()

    // The names outlive the screen they were typed on: back to the database,
    // into the other game, and the same side is claimed without asking again.
    await page.getByRole('button', { name: /Database/ }).click()
    await page.getByLabel('Player or event', { exact: true }).fill('dufresne')
    await page.getByRole('button', { name: /^Open Adolf Anderssen vs / }).click()
    await expect(page.getByText('Is this one of your games?')).toBeVisible()

    // …and a game with none of your names on it keeps the curated rule.
    await expect(page.getByText(/You take White's side, the winner's/)).toBeVisible()

    // Reload: the names came back from storage rather than from this session.
    await page.reload()
    await page.getByRole('button', { name: /Your game database/ }).click()
    await page.getByLabel('Player or event', { exact: true }).fill('morphy')
    await page.getByRole('button', { name: /^Open Paul Morphy vs / }).click()
    await expect(page.getByText('This is one of your games')).toBeVisible()
    await expect(page.locator('.study-buttons button').first()).toHaveText(
      'Study your side (Black)',
    )
  })

  test('quizzes the side you played once the session starts', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('button', { name: /Your game database/ }).click()
    await page.locator('input[type="file"]').setInputFiles(FIXTURE)
    await expect(page.getByText(/Attached 2 games from sample\.pgn/)).toBeVisible({
      timeout: 30_000,
    })

    await page.getByLabel('Player or event', { exact: true }).fill('morphy')
    await page.getByRole('button', { name: /^Open Paul Morphy vs / }).click()
    await page.getByText('Is this one of your games?').click()
    await page.getByLabel(/The names you play under/).fill(LOSER)
    await page.getByRole('button', { name: 'Save' }).click()
    await page.getByRole('button', { name: 'Study your side (Black)' }).click()

    // The session runs on the side the control promised — the losing one.
    await expect(page.getByText(/You are playing Black/)).toBeVisible()
  })
})
