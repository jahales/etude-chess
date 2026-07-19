import { describe, it, expect } from 'vitest'
import { saveAttempt, countAttempts } from './db'

// jsdom has no IndexedDB, so this exercises the graceful-degradation path:
// persistence must never throw or block the app.
//
// db.roundtrip.test.ts installs a global IndexedDB via fake-indexeddb, and
// getDb() caches its decision on first call — so these two files only coexist
// because Vitest isolates them. Assert the precondition rather than trusting
// it: without this, flipping `isolate` would leave these tests passing against
// a real store and silently delete the coverage they exist to provide.
describe('persistence (no IndexedDB available)', () => {
  it('really is running without IndexedDB', () => {
    expect(typeof indexedDB).toBe('undefined')
  })

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
