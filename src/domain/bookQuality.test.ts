import { describe, it, expect } from 'vitest'
import {
  annotatedKeys,
  auditBook,
  firstMoveShares,
  positionGames,
  recordedVsClaimed,
  START_KEY,
  type BookPositions,
} from './bookQuality'

/** A plausible amateur first-move distribution, scaled to `games`. */
function healthyBook(games = 10_000, extra: Record<string, number> = {}): BookPositions {
  // Shares must sum to 1, or every fraction the tests assert is off by the gap.
  const shares: Record<string, number> = { e4: 0.55, d4: 0.25, Nf3: 0.09, c4: 0.06, b3: 0.05, ...extra }
  const node: Record<string, [number, number, number]> = {}
  for (const [san, share] of Object.entries(shares)) {
    const n = Math.round(games * share)
    node[san] = [Math.round(n * 0.5), Math.round(n * 0.06), n - Math.round(n * 0.5) - Math.round(n * 0.06)]
  }
  return { [START_KEY]: node }
}

describe('positionGames', () => {
  it('sums every outcome across every move', () => {
    expect(positionGames({ e4: [10, 2, 8], d4: [5, 0, 5] })).toBe(30)
  })
})

describe('annotatedKeys', () => {
  it('finds evaluation glyphs anywhere in the book', () => {
    const book: BookPositions = { a: { Bf5: [1, 0, 1], 'Bf5?!': [1, 0, 0] }, b: { 'e5??': [0, 0, 1] } }
    expect(annotatedKeys(book).sort()).toEqual(['Bf5?!', 'e5??'])
  })

  it('is quiet on a clean book', () => {
    expect(annotatedKeys(healthyBook())).toEqual([])
  })

  it('does not mistake check or mate markers for annotations', () => {
    expect(annotatedKeys({ a: { 'Qxf7+': [1, 0, 0], 'Qxf7#': [1, 0, 0] } })).toEqual([])
  })
})

describe('firstMoveShares', () => {
  it('reports each first move as a fraction of the whole', () => {
    const shares = firstMoveShares(healthyBook())
    expect(shares.e4).toBeCloseTo(0.55, 2)
    expect(shares.d4).toBeCloseTo(0.25, 2)
  })

  it('returns nothing when the start position is missing', () => {
    expect(firstMoveShares({ someOtherKey: { e4: [1, 0, 0] } })).toEqual({})
  })
})

describe('auditBook', () => {
  it('passes a healthy book', () => {
    expect(auditBook(healthyBook())).toEqual([])
  })

  it('rejects an empty book', () => {
    const issues = auditBook({})
    expect(issues[0]!.severity).toBe('error')
    expect(issues[0]!.check).toBe('non-empty')
  })

  it('catches statistics split by evaluation glyphs', () => {
    // The real defect: the band book held Bf5 (570 games) and Bf5?! (57) apart.
    const book = healthyBook()
    book[START_KEY]!['e4?!'] = [10, 1, 9]
    const issues = auditBook(book)
    expect(issues.some((i) => i.check === 'canonical-san' && i.severity === 'error')).toBe(true)
  })

  it('catches a mis-parsed scan via the first-move distribution', () => {
    // If e4/d4/Nf3/c4 are not most of the first moves, we are not looking at
    // chess games — whatever else the book may claim about itself.
    const junk: BookPositions = { [START_KEY]: { a3: [50, 5, 45], h4: [50, 5, 45] } }
    const issues = auditBook(junk)
    expect(issues.some((i) => i.check === 'first-move-distribution')).toBe(true)
    expect(issues[0]!.severity).toBe('error')
  })

  it('flags a missing major first move', () => {
    const noD4: BookPositions = {
      [START_KEY]: { e4: [500, 60, 440], Nf3: [200, 20, 180], c4: [200, 20, 180], d4: [5, 0, 5] },
    }
    const issues = auditBook(noD4)
    expect(issues.some((i) => i.detail.includes('1.d4'))).toBe(true)
  })

  it('rejects malformed tallies', () => {
    const book = healthyBook()
    book.weird = { e4: [1, -2, 3] as [number, number, number] }
    expect(auditBook(book).some((i) => i.check === 'well-formed-tallies')).toBe(true)
  })

  it('warns about positions left with no moves', () => {
    const book = healthyBook()
    book.stripped = {}
    const issues = auditBook(book)
    expect(issues.some((i) => i.check === 'no-empty-positions' && i.severity === 'warn')).toBe(true)
  })

  it('warns rather than errors when the start position is absent', () => {
    // A subtree book (crawled from a forced line) legitimately lacks it.
    const issues = auditBook({ someKey: { Nf3: [10, 1, 9] } })
    expect(issues.every((i) => i.severity === 'warn')).toBe(true)
  })

  it('lists errors before warnings', () => {
    const book = healthyBook()
    book.stripped = {}
    book[START_KEY]!['e4?!'] = [10, 1, 9]
    const severities = auditBook(book).map((i) => i.severity)
    expect(severities.indexOf('error')).toBeLessThan(severities.indexOf('warn'))
  })
})

describe('recordedVsClaimed', () => {
  it('matches when every used game was recorded', () => {
    const r = recordedVsClaimed(healthyBook(10_000), 10_000)
    expect(r.ratio).toBeCloseTo(1, 2)
  })

  it('exposes a shortfall between games used and games recorded', () => {
    // This is the shape a silent truncation leaves behind.
    const r = recordedVsClaimed(healthyBook(3_000), 100_000)
    expect(r.ratio).toBeLessThan(0.1)
  })
})
