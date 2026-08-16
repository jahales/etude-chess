import { test, expect, type Page } from '@playwright/test'

/**
 * The board is sized against the window, **height included** (#150).
 *
 * This is here rather than in a unit test because jsdom lays nothing out: every
 * box is 0×0, so a board that overflows its window, a strip that no longer ends
 * where the board ends, and a board that collapses to the width of the text
 * under it all pass a unit test identically. Only a browser can tell them apart,
 * and each of those three is a failure this file has already caught once.
 *
 * Needs no engine and no Maia net — the board renders while Stockfish is still
 * loading, and the sizing does not wait for a position to be evaluated.
 */

type Metrics = {
  boardW: number
  boardH: number
  boardTop: number
  boardBottom: number
  boardLeft: number
  boardRight: number
  colRight: number
  barTop: number
  barBottom: number
  barLeft: number
  materialLeft: number
  materialRight: number
  controlsLeft: number
  controlsRight: number
  controlsBottom: number
  viewportH: number
}

const metrics = (page: Page): Promise<Metrics> =>
  page.evaluate(() => {
    const box = (sel: string) => document.querySelector(sel)!.getBoundingClientRect()
    const board = box('.board-frame')
    const col = box('.board-col')
    const bar = box('.evalbar')
    const material = box('.material')
    const controls = box('.board-controls')
    const r = Math.round
    return {
      boardW: r(board.width), boardH: r(board.height),
      boardTop: r(board.top), boardBottom: r(board.bottom),
      boardLeft: r(board.left), boardRight: r(board.right),
      colRight: r(col.right),
      barTop: r(bar.top), barBottom: r(bar.bottom), barLeft: r(bar.left),
      materialLeft: r(material.left), materialRight: r(material.right),
      controlsLeft: r(controls.left), controlsRight: r(controls.right),
      controlsBottom: r(controls.bottom),
      viewportH: window.innerHeight,
    }
  })

async function openBoard(page: Page) {
  await page.goto('/')
  await page.getByRole('button', { name: /Study a master game/ }).click()
  await page.getByRole('button', { name: 'Study this game' }).first().click()
  await page.locator('.board-frame [data-square="d1"]').waitFor()
  // One frame for the resize observer to report the width CSS settled on.
  await page.waitForTimeout(250)
}

/**
 * `atLeast` is the floor each window should comfortably clear, not the size we
 * expect: an exact number would fail on any deliberate change to the reserved
 * chrome, while a floor still catches the collapses. 560px was the old fixed
 * cap, so anything at or below it on a desktop window is the bug this closed.
 */
const WINDOWS = [
  { label: 'a maximised desktop window', width: 1920, height: 1080, atLeast: 800 },
  { label: 'a short, wide window', width: 1920, height: 800, atLeast: 540 },
  { label: 'a tall, narrow window', width: 1000, height: 1400, atLeast: 560 },
  { label: 'the narrow breakpoint, one column', width: 760, height: 900, atLeast: 600 },
]

test.describe('the board is sized to the window', () => {
  for (const { label, width, height, atLeast } of WINDOWS) {
    test(`${width}×${height} — ${label}`, async ({ page }) => {
      await page.setViewportSize({ width, height })
      await openBoard(page)
      const m = await metrics(page)

      // Square, always: a board sized on one axis and clipped on the other is
      // not a chessboard.
      expect(m.boardW).toBe(m.boardH)

      // Big enough to be worth having. At 760×900 this is what caught the
      // board collapsing to 271px: an auto margin on the grid item made it
      // shrink to fit the *control row* under the board rather than the track.
      expect(m.boardW).toBeGreaterThanOrEqual(atLeast)

      // The board and the controls under it are both on screen without
      // scrolling — losing them in the same motion is worse than a small board,
      // and is exactly what sizing on width alone does to a short window.
      expect(m.controlsBottom).toBeLessThanOrEqual(height)

      // The eval bar, the material strip and the controls travel with the
      // board: same left edge, same right edge, bar exactly as tall.
      expect(m.barTop).toBe(m.boardTop)
      expect(m.barBottom).toBe(m.boardBottom)
      expect(m.materialLeft).toBe(m.barLeft)
      expect(m.controlsLeft).toBe(m.barLeft)
      expect(m.materialRight).toBe(m.boardRight)
      expect(m.controlsRight).toBe(m.boardRight)
    })
  }

  test('a window made shorter re-sizes the board instead of leaving it hanging', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1920, height: 1080 })
    await openBoard(page)
    const tall = await metrics(page)

    await page.setViewportSize({ width: 1920, height: 800 })
    await page.waitForTimeout(400)
    const short = await metrics(page)

    expect(short.boardW).toBeLessThan(tall.boardW)
    expect(short.boardW).toBe(short.boardH)
    expect(short.controlsBottom).toBeLessThanOrEqual(800)
    // A flex item will not shrink below its content, and its content is a board
    // rendered at the *last* measured size — so without `min-width: 0` the board
    // hung past its own column here, and the measurement that should have
    // corrected it read the stale width straight back.
    expect(short.boardRight).toBeLessThanOrEqual(short.colRight)
    expect(short.materialRight).toBe(short.boardRight)

    // ...and back, so nothing is one resize behind in the other direction.
    await page.setViewportSize({ width: 1920, height: 1080 })
    await page.waitForTimeout(400)
    const again = await metrics(page)
    expect(again.boardW).toBe(tall.boardW)
    expect(again.boardW).toBe(again.boardH)
  })

  test('the board still takes the clicks, at the size it is now', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 })
    await openBoard(page)

    // Click-to-move on a board four hundred pixels wider than it used to be.
    // #131 found this silently broken while dragging still worked, and a
    // resized board with a stale pixel size fails in precisely that way.
    await page.locator('.board-frame [data-square="d1"]').click()
    await page.locator('.board-frame [data-square="f3"]').click()
    await expect(page.locator('.picked')).toHaveText('Qxf3')

    await page.getByRole('button', { name: 'Take back' }).click()
    await page.setViewportSize({ width: 1920, height: 800 })
    await page.waitForTimeout(400)

    // The square the mouse lands on is the square the board thinks it hit —
    // the board's own geometry and the DOM's agreeing after a resize.
    const landed = await page.evaluate(() => {
      const el = document.querySelector('.board-frame [data-square="h8"]')!
      const b = el.getBoundingClientRect()
      const under = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)
      return (under as HTMLElement)?.closest('[data-square]')?.getAttribute('data-square')
    })
    expect(landed).toBe('h8')

    await page.locator('.board-frame [data-square="d1"]').click()
    await page.locator('.board-frame [data-square="f3"]').click()
    await expect(page.locator('.picked')).toHaveText('Qxf3')
  })
})
