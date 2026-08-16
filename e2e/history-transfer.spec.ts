import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, type Page } from '@playwright/test'

/**
 * Exporting and importing your history, end to end (#152).
 *
 * The path unit tests cannot reach: a real `Blob` through a real object URL,
 * back in through a real `<input type="file">`, into real IndexedDB. The merge
 * rules themselves are proven against fake-indexeddb in
 * `src/persist/historyArchive.roundtrip.test.ts`; what is only checkable here is
 * that the bytes survive the browser's own file plumbing.
 *
 * Needs no Maia net and no engine — nothing in a transfer touches one.
 */

const FIXTURE = join('e2e', 'fixtures', 'sample.pgn')
const HAS_FIXTURE = existsSync(FIXTURE)

/** One attempt, written straight in: the part of a history with no other source. */
async function seedAnAttempt(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('etude-chess')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('attempts', 'readwrite')
      tx.objectStore('attempts').put({
        gameId: 'opera',
        sessionId: 's1',
        createdAt: 1_700_000_000_000,
        itemIndex: 0,
        moveNumber: 8,
        sideToMove: 'w',
        fen: 'rnbqkb1r/pp2pppp/3p1n2/8/3NP3/2N5/PPP2PPP/R1BQKB1R w KQkq - 0 6',
        userMoveSan: 'Bc4',
        masterMoveSan: 'Bg5',
        reason: 'the light squares are where the play is',
        tier: 'B',
        swing: 3.5,
      })
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  })
}

/** Everything this profile holds, gone — a second browser, in one call. */
async function clearStorage(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('etude-chess')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const stores = [...db.objectStoreNames]
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(stores, 'readwrite')
      for (const store of stores) tx.objectStore(store).clear()
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  })
}

const rowCount = (page: Page, store: string) =>
  page.evaluate(async (name) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('etude-chess')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    return await new Promise<number>((resolve) => {
      const request = db.transaction(name).objectStore(name).count()
      request.onsuccess = () => resolve(request.result)
    })
  }, store)

/** Attach the fixture, seed an attempt, and export the lot. Returns the file. */
async function exportHistory(page: Page): Promise<string> {
  await page.goto('/')
  await page.getByRole('button', { name: /Your game database/ }).click()
  await page.locator('#pgn-file').setInputFiles(FIXTURE)
  await expect(page.getByText(/Attached 2 games from sample\.pgn/)).toBeVisible({ timeout: 30_000 })

  await seedAnAttempt(page)
  await page.reload()
  await page.getByRole('button', { name: /Your game database/ }).click()

  await page.getByRole('button', { name: 'Prepare an export' }).click()
  const save = page.getByRole('link', { name: /^Save etude-history-/ })
  await expect(save).toBeVisible({ timeout: 30_000 })
  // The size is on the control that writes the file — the last moment it can
  // still be acted on.
  await expect(save).toHaveText(/\(\d+(\.\d+)? (B|KB|MB|GB)\)/)

  const href = await save.getAttribute('href')
  return await page.evaluate((url) => fetch(url!).then((r) => r.text()), href)
}

const asFile = (text: string, name = 'etude-history.jsonl') => ({
  name,
  mimeType: 'application/x-ndjson',
  buffer: Buffer.from(text, 'utf8'),
})

test.describe('move your history to another browser', () => {
  test.skip(!HAS_FIXTURE, `missing ${FIXTURE}`)

  test('exports a profile and merges it back into an empty one, twice over', async ({ page }) => {
    const archive = await exportHistory(page)
    expect(archive.split('\n')[0]).toContain('"format":"etude-chess-history"')

    // A second browser: nothing here at all.
    await clearStorage(page)
    await page.reload()
    await page.getByRole('button', { name: /Your game database/ }).click()

    await page.locator('#history-file').setInputFiles(asFile(archive))
    await expect(page.getByText(/Nothing already on this device was removed/)).toBeVisible({
      timeout: 30_000,
    })
    expect(await rowCount(page, 'dbGames')).toBe(2)
    expect(await rowCount(page, 'attempts')).toBe(1)

    // The games are searchable, which they are not unless the index was
    // rebuilt over the vocabulary the import just changed (#54).
    await expect(page.getByRole('heading', { name: /^Attached \(2 games\)$/ })).toBeVisible()

    // The same file again: one copy, not two, and it says so.
    await page.locator('#history-file').setInputFiles(asFile(archive))
    await expect(page.getByText(/Everything in that file was already here/)).toBeVisible({
      timeout: 30_000,
    })
    expect(await rowCount(page, 'dbGames')).toBe(2)
    expect(await rowCount(page, 'attempts')).toBe(1)
  })

  test('refuses a truncated or wrong-version file without writing anything', async ({ page }) => {
    const archive = await exportHistory(page)
    const lines = archive.trim().split('\n')
    const before = {
      games: await rowCount(page, 'dbGames'),
      attempts: await rowCount(page, 'attempts'),
    }

    // Truncated: the end marker, and the records before it, lost to an
    // interrupted download.
    await page.locator('#history-file').setInputFiles(asFile(lines.slice(0, -2).join('\n')))
    await expect(page.getByRole('alert')).toContainText('ends part-way through', {
      timeout: 30_000,
    })
    await expect(page.getByRole('alert')).toContainText('Nothing has been imported')

    // Written by a newer étude than this one.
    const newer = [
      JSON.stringify({ ...JSON.parse(lines[0]!), version: 99 }),
      ...lines.slice(1),
    ].join('\n')
    await page.locator('#history-file').setInputFiles(asFile(newer))
    await expect(page.getByRole('alert')).toContainText('newer version of étude', {
      timeout: 30_000,
    })

    // Not a refusal that got half way: the counts are exactly what they were.
    expect(await rowCount(page, 'dbGames')).toBe(before.games)
    expect(await rowCount(page, 'attempts')).toBe(before.attempts)
  })
})
