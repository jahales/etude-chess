import { describe, it, expect } from 'vitest'
import { createPositionFilter, hashKey } from './positionFilter.mjs'

// The one property that matters: the filter may keep too much, never too
// little. Dropping a position that would have survived the prune silently
// removes a line from the repertoire, which is exactly the class of failure
// this pipeline keeps producing.

describe('createPositionFilter', () => {
  it('keeps a position seen at least minGames times', () => {
    const f = createPositionFilter({ bits: 16, minGames: 5 })
    for (let i = 0; i < 5; i++) f.count('a')
    expect(f.keeps('a')).toBe(true)
  })

  it('drops one seen fewer times', () => {
    const f = createPositionFilter({ bits: 16, minGames: 5 })
    for (let i = 0; i < 4; i++) f.count('a')
    expect(f.keeps('a')).toBe(false)
  })

  it('drops a position never seen', () => {
    expect(createPositionFilter({ bits: 16 }).keeps('never')).toBe(false)
  })

  it('is exact on the threshold itself', () => {
    for (const minGames of [1, 2, 5, 20]) {
      const f = createPositionFilter({ bits: 16, minGames })
      for (let i = 0; i < minGames - 1; i++) f.count('x')
      expect(f.keeps('x'), `${minGames - 1} of ${minGames}`).toBe(false)
      f.count('x')
      expect(f.keeps('x'), `${minGames} of ${minGames}`).toBe(true)
    }
  })

  it('saturates rather than wrapping past 255', () => {
    // A byte rolling over to zero would drop the *most common* positions in the
    // book — the worst possible failure for this structure.
    const f = createPositionFilter({ bits: 16, minGames: 5 })
    for (let i = 0; i < 1000; i++) f.count('busy')
    expect(f.keeps('busy')).toBe(true)
  })

  it('errs toward keeping when two keys collide', () => {
    // Forced collision: same slot, counts add up, so a rare position inherits a
    // common one's count. It is kept and the second pass prunes it exactly.
    const f = createPositionFilter({ bits: 1, minGames: 3 })
    for (let i = 0; i < 3; i++) f.count('common')
    // With a two-slot table something must share; whatever does is kept, and
    // nothing that earned its place is ever dropped.
    for (let i = 0; i < 3; i++) f.count('other')
    expect(f.keeps('common')).toBe(true)
    expect(f.keeps('other')).toBe(true)
  })

  it('never drops a key that reached the threshold, across many keys', () => {
    const f = createPositionFilter({ bits: 18, minGames: 3 })
    const earned = []
    for (let i = 0; i < 5000; i++) {
      const key = `position-${i}`
      const times = i % 7
      for (let n = 0; n < times; n++) f.count(key)
      if (times >= 3) earned.push(key)
    }
    for (const key of earned) expect(f.keeps(key), key).toBe(true)
    expect(earned.length).toBeGreaterThan(1000)
  })

  it('reports its size and load so a build can say the filter stopped helping', () => {
    const f = createPositionFilter({ bits: 12, minGames: 2 })
    expect(f.bytes).toBe(4096)
    for (let i = 0; i < 100; i++) f.count(`k${i}`)
    const s = f.stats()
    expect(s.counted).toBe(100)
    expect(s.live).toBeGreaterThan(0)
    expect(s.load).toBeGreaterThan(0)
    expect(s.load).toBeLessThanOrEqual(1)
  })

  it('uses constant memory regardless of how many keys it sees', () => {
    const f = createPositionFilter({ bits: 12 })
    for (let i = 0; i < 200_000; i++) f.count(`k${i}`)
    expect(f.stats().bytes).toBe(4096)
  })
})

describe('hashKey', () => {
  it('is deterministic and unsigned', () => {
    expect(hashKey('abc')).toBe(hashKey('abc'))
    expect(hashKey('abc')).toBeGreaterThanOrEqual(0)
    expect(hashKey('')).toBeGreaterThanOrEqual(0)
  })

  it('separates the FEN keys a book actually holds', () => {
    const keys = [
      'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -',
      'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -',
      'rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq -',
    ]
    expect(new Set(keys.map(hashKey)).size).toBe(keys.length)
  })
})
