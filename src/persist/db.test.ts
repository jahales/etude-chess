import { describe, it, expect } from 'vitest'
import { saveAttempt, countAttempts } from './db'

// jsdom has no IndexedDB, so this exercises the graceful-degradation path:
// persistence must never throw or block the app.
describe('persistence (no IndexedDB available)', () => {
  it('saveAttempt resolves silently', async () => {
    await expect(
      saveAttempt({
        gameId: 'g',
        sessionId: 's',
        createdAt: 0,
        itemIndex: 0,
        moveNumber: 1,
        sideToMove: 'w',
        fen: 'x',
        userMoveSan: 'e4',
        masterMoveSan: 'e4',
        reason: '',
        tier: 'A',
        swing: 0,
      }),
    ).resolves.toBeUndefined()
  })

  it('countAttempts returns 0 rather than throwing', async () => {
    await expect(countAttempts()).resolves.toBe(0)
  })
})
