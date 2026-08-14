import { describe, it, expect } from 'vitest'
import { annotationForSwing, BLUNDER_MIN_SWING } from './annotation'
import {
  isBlunder,
  countBlunders,
  blunderRate,
  MIN_GAMES_FOR_SIGNAL,
  type GameBlunders,
} from './blunderRate'

const played = (blunders: number, yourMoves = 30): GameBlunders => ({ blunders, yourMoves })

describe('isBlunder', () => {
  it('is exactly the swing that earns a ?? in the move list', () => {
    // The tie is the point. If this counted a different set of moves than the
    // glyphs mark, the rate would disagree with the game it was computed from
    // and neither could be trusted (constitution §9).
    for (const swing of [0, 4, 5, 6, 15, 16, 29, 29.9, 30, 31, 80, 100]) {
      expect(isBlunder(swing)).toBe(annotationForSwing(swing) === '??')
    }
  })

  it('starts at the blunder threshold, not above it', () => {
    expect(isBlunder(BLUNDER_MIN_SWING - 0.1)).toBe(false)
    expect(isBlunder(BLUNDER_MIN_SWING)).toBe(true)
  })

  it('does not count a move nothing measured', () => {
    // Absent is unknown, not innocent — counting it as "fine" would drag the
    // rate down with every move the analysis never reached.
    expect(isBlunder(undefined)).toBe(false)
  })

  it('does not count a move that gained ground', () => {
    expect(isBlunder(-40)).toBe(false)
  })
})

describe('countBlunders', () => {
  it('counts the moves over the threshold and nothing else', () => {
    expect(countBlunders([0, 12, 30, 4, 55, 29])).toBe(2)
  })

  it('is 0 over no moves', () => {
    expect(countBlunders([])).toBe(0)
  })
})

describe('blunderRate', () => {
  it('is blunders divided by games', () => {
    const r = blunderRate([played(2), played(0), played(1), played(1)])
    expect(r.games).toBe(4)
    expect(r.blunders).toBe(4)
    expect(r.perGame).toBe(1)
  })

  it('reports the moves it rests on, not just the games', () => {
    const r = blunderRate([played(1, 20), played(3, 41)])
    expect(r.yourMoves).toBe(61)
  })

  it('has no rate at all over no games, rather than a flattering zero', () => {
    // 0.00 blunders per game reads as a perfect record. "No games counted" is
    // the honest rendering of an empty sample.
    const r = blunderRate([])
    expect(r.perGame).toBeUndefined()
    expect(r.games).toBe(0)
    expect(r.blunders).toBe(0)
  })

  it('carries the games it could not count, so the number can state what it left out', () => {
    const r = blunderRate([played(1)], 7)
    expect(r.games).toBe(1)
    expect(r.uncounted).toBe(7)
  })

  it('flags a sample too small to read anything into', () => {
    // The owner has played a few hundred games in total, so a thin sample is the
    // normal case here, not an edge case.
    expect(blunderRate([played(1)]).smallSample).toBe(true)
    expect(blunderRate(Array(MIN_GAMES_FOR_SIGNAL - 1).fill(played(1))).smallSample).toBe(true)
    expect(blunderRate(Array(MIN_GAMES_FOR_SIGNAL).fill(played(1))).smallSample).toBe(false)
  })

  it('flags an empty sample as small too, so no caller has to special-case it', () => {
    expect(blunderRate([]).smallSample).toBe(true)
  })

  it('counts a clean game as evidence, not as an absence', () => {
    // A game you played without a blunder is a real observation and must pull the
    // rate down. Dropping "empty" games would only ever inflate it.
    const r = blunderRate([played(0), played(0), played(2)])
    expect(r.perGame).toBeCloseTo(2 / 3)
  })
})
