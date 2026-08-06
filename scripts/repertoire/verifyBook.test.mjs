import { describe, it, expect } from 'vitest'
import { Chess } from 'chess.js'
import { checkLegality } from './verifyBook.mjs'
import { fenKey } from '../../src/domain/repertoirePgn.ts'

// The legality sampler is the audit's last line: it replays the book's own keys
// to confirm each move is legal where it is filed. That catches key corruption
// and any drift between how a book is written and how it is read back.

const START = fenKey(new Chess().fen())

describe('checkLegality', () => {
  it('passes a book whose moves are all legal where filed', () => {
    const r = checkLegality({ [START]: { d4: [1, 0, 1], e4: [1, 0, 1], Nf3: [1, 0, 1] } })
    expect(r.bad).toEqual([])
    expect(r.checked).toBe(3)
  })

  it('flags a move that is not legal in its position', () => {
    const r = checkLegality({ [START]: { d4: [1, 0, 1], Qxh7: [1, 0, 1] } })
    expect(r.bad.map((b) => b.san)).toEqual(['Qxh7'])
  })

  it('flags a key that is not a legal position at all', () => {
    const r = checkLegality({ 'not/a/fen w - -': { d4: [1, 0, 1] } })
    expect(r.bad[0]).toMatchObject({ why: 'not a legal position' })
  })

  it('restores the board between moves rather than replaying them onto each other', () => {
    // Without the undo, the second move would be tried in the position after the
    // first and every book would look corrupt.
    const r = checkLegality({ [START]: { d4: [1, 0, 1], d3: [1, 0, 1], c4: [1, 0, 1] } })
    expect(r.bad).toEqual([])
  })

  it('samples rather than checking every position in a large book', () => {
    const positions = {}
    for (let i = 0; i < 500; i++) {
      const c = new Chess()
      c.move(c.moves()[i % 20])
      positions[fenKey(c.fen())] = { d5: [1, 0, 1] }
    }
    const r = checkLegality(positions, 10)
    expect(r.checked).toBeLessThan(500)
    expect(r.checked).toBeGreaterThan(0)
  })

  it('handles an empty book', () => {
    expect(checkLegality({})).toEqual({ checked: 0, bad: [] })
  })
})
