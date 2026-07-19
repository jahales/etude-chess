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

/** A realistic graded move — the placeholders these tests used are now read. */
const graded = (swing = 0) => [
  { ply: 0, fen: 'f', san: 'e4', tier: 'A' as const, swing, bestMoveSan: null },
]

describe('lastAccuracyOf', () => {
  it('is undefined with no games', () => {
    expect(lastAccuracyOf([])).toBeUndefined()
  })

  it('takes the newest game (the list is already newest-first)', () => {
    // Both graded; the newest wins. A perfect move scores 100.
    const games = [g({ coachLog: graded(0) }), g({ coachLog: graded(40) })]
    expect(lastAccuracyOf(games)).toBeCloseTo(100, 0)
  })

  it('skips a game that was never graded rather than reporting 0%', () => {
    // Resigning on move one stores accuracy 0 with no coached moves. Showing
    // "last game 0.00%" would read as a verdict on your play, not as no data.
    const games = [g({ accuracy: 0, coachLog: [] }), g({ coachLog: graded(0) })]
    expect(lastAccuracyOf(games)).toBeCloseTo(100, 0)
  })

  it('counts a v0.2 record, whose coachLog is unknown rather than empty', () => {
    // Absent means "predates the field", so dropping it would silently erase
    // pre-v0.3 games from your history.
    expect(lastAccuracyOf([g({ accuracy: 64, coachLog: undefined })])).toBe(64)
  })
})
