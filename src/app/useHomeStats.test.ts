import { describe, it, expect } from 'vitest'
import { lastAccuracyOf } from './useHomeStats'
import type { StoredGame } from '../persist/db'

function g(over: Partial<StoredGame>): StoredGame {
  return {
    gameId: 'g',
    yourColor: 'w',
    level: 1500,
    sanHistory: [],
    outcome: 'you',
    reason: 'resignation',
    accuracy: 0,
    takebacks: 0,
    createdAt: 0,
    ...over,
  }
}

describe('lastAccuracyOf', () => {
  it('is undefined with no games', () => {
    expect(lastAccuracyOf([])).toBeUndefined()
  })

  it('takes the newest game (the list is already newest-first)', () => {
    const graded = [{} as never]
    const games = [g({ accuracy: 91, coachLog: graded }), g({ accuracy: 55, coachLog: graded })]
    expect(lastAccuracyOf(games)).toBe(91)
  })

  it('skips a game that was never graded rather than reporting 0%', () => {
    // Resigning on move one stores accuracy 0 with no coached moves. Showing
    // "last game 0.00%" would read as a verdict on your play, not as no data.
    const games = [g({ accuracy: 0, coachLog: [] }), g({ accuracy: 78.5, coachLog: [{} as never] })]
    expect(lastAccuracyOf(games)).toBe(78.5)
  })

  it('counts a v0.2 record, whose coachLog is unknown rather than empty', () => {
    // Absent means "predates the field", so dropping it would silently erase
    // pre-v0.3 games from your history.
    expect(lastAccuracyOf([g({ accuracy: 64, coachLog: undefined })])).toBe(64)
  })
})
