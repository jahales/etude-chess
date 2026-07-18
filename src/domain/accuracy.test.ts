import { describe, it, expect } from 'vitest'
import { moveAccuracy, meanAccuracy, phaseOf, byPhase } from './accuracy'

describe('moveAccuracy', () => {
  it('is 100 for a best move (no win% lost) and decreases with the loss', () => {
    expect(moveAccuracy(0)).toBeCloseTo(100, 1)
    expect(moveAccuracy(5)).toBeLessThan(100)
    expect(moveAccuracy(30)).toBeLessThan(moveAccuracy(5))
  })

  it('clamps to [0, 100]', () => {
    expect(moveAccuracy(1000)).toBeGreaterThanOrEqual(0)
    expect(moveAccuracy(-10)).toBeLessThanOrEqual(100) // negative loss treated as 0
    expect(moveAccuracy(-10)).toBeCloseTo(100, 1)
  })
})

describe('meanAccuracy', () => {
  it('averages per-move accuracy; empty is 100', () => {
    expect(meanAccuracy([])).toBe(100)
    const mixed = meanAccuracy([0, 40])
    expect(mixed).toBeGreaterThan(moveAccuracy(40))
    expect(mixed).toBeLessThan(100)
    expect(mixed).toBeCloseTo((moveAccuracy(0) + moveAccuracy(40)) / 2, 5)
  })
})

describe('phaseOf', () => {
  it('calls the opening early, the middlegame later, the endgame when thin', () => {
    expect(phaseOf('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1')).toBe('opening')
    // full material but move 15 → middlegame
    expect(phaseOf('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 15')).toBe('middlegame')
    // kings + a couple pieces → endgame
    expect(phaseOf('8/5k2/8/8/3K4/8/4R3/8 w - - 0 40')).toBe('endgame')
    expect(phaseOf('8/8/4k3/8/8/4K3/8/8 w - - 0 60')).toBe('endgame') // K vs K
  })
})

describe('byPhase', () => {
  it('groups attempts by phase with per-phase accuracy', () => {
    const attempts = [
      { fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', swing: 0 }, // opening
      { fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 20', swing: 20 }, // middlegame
      { fen: '8/5k2/8/8/3K4/8/4R3/8 w - - 0 40', swing: 10 }, // endgame
    ]
    const r = byPhase(attempts)
    expect(r.opening.moves).toBe(1)
    expect(r.opening.accuracy).toBeCloseTo(100, 1)
    expect(r.middlegame.moves).toBe(1)
    expect(r.endgame.moves).toBe(1)
  })
})
