import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Chess } from 'chess.js'
import { createLocalBook } from './localBook.mjs'
import { fenKey } from '../../src/domain/repertoirePgn.ts'

// The book reader is what the crawler actually talks to, and it must satisfy the
// same contract as the explorer client so the crawler cannot tell them apart.

let dir
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'localbook-'))
})

const START = new Chess().fen()
const AFTER_D4 = (() => {
  const c = new Chess()
  c.move('d4')
  return c.fen()
})()

function bookFile(positions, meta = {}) {
  const path = join(dir, `book-${Math.random().toString(36).slice(2)}.json`)
  writeFileSync(path, JSON.stringify({ meta, positions }))
  return path
}

describe('createLocalBook', () => {
  it('returns each move with its tally and a derived UCI', async () => {
    // The book stores SAN only; UCI is derived at read time so it cannot
    // disagree with the position.
    const book = await createLocalBook({
      path: bookFile({ [fenKey(START)]: { d4: [10, 2, 8], e4: [30, 5, 25] } }),
    })
    const r = await book.query(START)
    const d4 = r.moves.find((m) => m.san === 'd4')
    expect(d4).toMatchObject({ uci: 'd2d4', white: 10, draws: 2, black: 8 })
    expect(r.white).toBe(40)
    expect(r.draws).toBe(7)
    expect(r.black).toBe(33)
  })

  it('orders moves by how often they were played', async () => {
    const book = await createLocalBook({
      path: bookFile({ [fenKey(START)]: { a3: [1, 0, 1], e4: [50, 0, 50], d4: [20, 0, 20] } }),
    })
    expect((await book.query(START)).moves.map((m) => m.san)).toEqual(['e4', 'd4', 'a3'])
  })

  it('ignores clock and move counters when matching a position', async () => {
    // Transpositions must collapse, so lookups key on the first four FEN fields.
    const book = await createLocalBook({ path: bookFile({ [fenKey(START)]: { d4: [1, 0, 1] } }) })
    const shifted = START.replace(/ 0 1$/, ' 7 30')
    expect((await book.query(shifted)).moves).toHaveLength(1)
  })

  it('skips a stored move that is not legal in the position it is filed under', async () => {
    const book = await createLocalBook({
      path: bookFile({ [fenKey(START)]: { d4: [5, 0, 5], Qxh7: [3, 0, 3] } }),
    })
    const r = await book.query(START)
    expect(r.moves.map((m) => m.san)).toEqual(['d4'])
    // and the bogus move must not be counted into the totals
    expect(r.white + r.draws + r.black).toBe(10)
  })

  it('returns an empty result for a position it has never seen', async () => {
    const book = await createLocalBook({ path: bookFile({ [fenKey(START)]: { d4: [1, 0, 1] } }) })
    const r = await book.query(AFTER_D4)
    expect(r.moves).toEqual([])
    expect(r.white + r.draws + r.black).toBe(0)
  })

  it('gives every miss its own array, not one shared instance', async () => {
    // A shared `moves` array would let one caller's mutation corrupt unrelated
    // positions for the rest of the process.
    const book = await createLocalBook({ path: bookFile({}) })
    const a = await book.query(START)
    const b = await book.query(AFTER_D4)
    expect(a.moves).not.toBe(b.moves)
    a.moves.push({ san: 'junk' })
    expect(b.moves).toEqual([])
  })

  it('counts hits and misses so a run can report its coverage', async () => {
    const book = await createLocalBook({ path: bookFile({ [fenKey(START)]: { d4: [1, 0, 1] } }) })
    await book.query(START)
    await book.query(AFTER_D4)
    expect(book.stats()).toMatchObject({ hits: 1, misses: 1 })
  })

  it('carries the book meta through, so provenance survives to the report', async () => {
    const book = await createLocalBook({
      path: bookFile({}, { ratings: [1500, 1900], gamesUsed: 300000 }),
    })
    expect(book.stats()).toMatchObject({ ratings: [1500, 1900], gamesUsed: 300000 })
  })

  it('tolerates a book with no positions at all', async () => {
    const path = join(dir, 'bare.json')
    writeFileSync(path, JSON.stringify({ meta: {} }))
    const book = await createLocalBook({ path })
    expect((await book.query(START)).moves).toEqual([])
  })
})
