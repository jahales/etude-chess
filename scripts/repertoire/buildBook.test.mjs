import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { compress as zstdCompress } from 'zstd-napi'
import { buildBook } from './buildBook.mjs'
import { fenKey } from '../../src/domain/repertoirePgn.ts'
import { auditBook } from '../../src/domain/bookQuality.ts'

// `buildBook()` accepts a local file, so the whole scan is testable against a
// fixture — no network, no 27 GB month.
//
// The defect that motivates most of this: the book keyed on the raw PGN token,
// so `Bf5` and `Bf5?!` were filed as different moves. That splits one move's
// record in two, and it bites hardest on `?`/`??` — which land on exactly the
// bad-but-popular moves the trap detector exists to find.

const dir = mkdtempSync(join(tmpdir(), 'buildbook-'))
let seq = 0

function game({ event = 'Rated Blitz game', white = 1600, black = 1600, result = '1-0', moves }) {
  return [
    `[Event "${event}"]`,
    `[Site "https://lichess.org/x${seq++}"]`,
    `[Result "${result}"]`,
    `[WhiteElo "${white}"]`,
    `[BlackElo "${black}"]`,
    '',
    `${moves} ${result}`,
    '',
  ].join('\n')
}

/** Write games to a fixture file and build a book from it. */
async function build(games, opts = {}) {
  const path = join(dir, `f${seq}.pgn`)
  writeFileSync(path, games.join('\n'))
  const { book, meta } = await buildBook({
    file: path,
    minRating: 1500,
    maxRating: 1900,
    maxPly: 8,
    minGames: 1,
    ...opts,
  })
  return { book, meta }
}

const START = fenKey(new (await import('chess.js')).Chess().fen())
const first = (book) => Object.fromEntries([...(book.get(START) ?? new Map())])

describe('buildBook — move recording', () => {
  it('records the moves of an in-band game', async () => {
    const { book, meta } = await build([game({ moves: '1. d4 d5 2. c4 e6' })])
    expect(meta.gamesUsed).toBe(1)
    expect(first(book)).toEqual({ d4: [1, 0, 0] })
  })

  it('merges evaluation glyphs into the canonical move', async () => {
    // The bug: `Bf5` (570 games) and `Bf5?!` (57) filed apart, and the split-off
    // entry then deleted by pruning.
    const { book } = await build([
      game({ moves: '1. d4 d5 2. c4 e6' }),
      game({ moves: '1. d4?! d5 2. c4 e6', result: '0-1' }),
      game({ moves: '1. d4?? d5 2. c4 e6', result: '1/2-1/2' }),
    ])
    expect(first(book)).toEqual({ d4: [1, 1, 1] })
  })

  it('leaves no annotated keys anywhere in the book', async () => {
    const { book } = await build([game({ moves: '1. e4?! e5 2. Nf3!? Nc6' })])
    const positions = Object.fromEntries(
      [...book].map(([k, v]) => [k, Object.fromEntries([...v])]),
    )
    expect(auditBook(positions).filter((i) => i.check === 'canonical-san')).toEqual([])
  })

  it('strips clock and eval comments without losing the moves after them', async () => {
    const { book } = await build([
      game({ moves:
        '1. d4 { [%clk 0:03:00] [%eval 0.17] } d5 { [%clk 0:02:58] } 2. c4 { [%eval 0.2] } e6' }),
    ])
    expect(first(book)).toEqual({ d4: [1, 0, 0] })
  })

  it('records the result from the right side', async () => {
    const { book } = await build([
      game({ moves: '1. d4 d5 2. c4 e6', result: '1-0' }),
      game({ moves: '1. d4 d5 2. c4 e6', result: '0-1' }),
      game({ moves: '1. d4 d5 2. c4 e6', result: '1/2-1/2' }),
    ])
    expect(first(book)).toEqual({ d4: [1, 1, 1] })
  })

  it('stops at maxPly', async () => {
    const { book } = await build([game({ moves: '1. d4 d5 2. c4 e6 3. Nc3 Nf6 4. Bg5 Be7' })], {
      maxPly: 3,
    })
    // Positions are recorded before each of the first 3 plies, so 3 in total.
    expect(book.size).toBe(3)
  })

  it('abandons a game with a malformed move but keeps the book', async () => {
    const { book, meta } = await build([
      game({ moves: '1. d4 d5 2. zz9 e6' }),
      game({ moves: '1. d4 d5 2. c4 e6' }),
    ])
    expect(meta.gamesUsed).toBe(2)
    expect(first(book).d4).toEqual([2, 0, 0])
  })
})

describe('buildBook — filtering', () => {
  it('excludes games outside the rating band', async () => {
    const { meta } = await build([
      game({ moves: '1. d4 d5 2. c4 e6', white: 1600, black: 1600 }),
      game({ moves: '1. e4 e5 2. Nf3 Nc6', white: 2400, black: 2400 }),
      game({ moves: '1. c4 c5 2. Nc3 Nc6', white: 900, black: 900 }),
    ])
    expect(meta.gamesUsed).toBe(1)
  })

  it('requires both players in band, not just one', async () => {
    const { meta } = await build([game({ moves: '1. d4 d5 2. c4 e6', white: 1600, black: 2400 })])
    expect(meta.gamesUsed).toBe(0)
  })

  it('excludes a speed we did not ask for', async () => {
    const { meta } = await build([game({ moves: '1. d4 d5 2. c4 e6', event: 'Rated Bullet game' })], {
      speeds: ['blitz', 'rapid'],
    })
    expect(meta.gamesUsed).toBe(0)
  })

  it('keeps a game whose event names no speed at all', async () => {
    // An OTB or engine PGN never says "Rated Blitz game". Requiring a known
    // speed silently dropped every game in an imported database.
    const { meta } = await build([game({ moves: '1. d4 d5 2. c4 e6', event: 'Wijk aan Zee' })], {
      speeds: ['blitz'],
    })
    expect(meta.gamesUsed).toBe(1)
  })

  it('skips a game too short to be worth recording', async () => {
    // Under four plies is a mouse-slip or an instant resignation. Silent today,
    // and surprising enough to have broken this file's own fixtures — pin it.
    const { meta } = await build([game({ moves: '1. d4 d5' })])
    expect(meta.gamesUsed).toBe(0)
  })

  it('skips an unfinished game', async () => {
    const { meta } = await build([game({ moves: '1. d4 d5 2. c4 e6', result: '*' })])
    expect(meta.gamesUsed).toBe(0)
  })

  it('stops at maxGames and says it stopped because we asked', async () => {
    const games = Array.from({ length: 5 }, () => game({ moves: '1. d4 d5 2. c4 e6' }))
    const { meta } = await build(games, { maxGames: 2 })
    expect(meta.gamesUsed).toBe(2)
    expect(meta.stoppedAtLimit).toBe(true)
  })

  it('records that a full scan was NOT cut short', async () => {
    // verifyBook uses this to tell a capped build from a silent truncation.
    const { meta } = await build([game({ moves: '1. d4 d5 2. c4 e6' })], { maxGames: 100 })
    expect(meta.stoppedAtLimit).toBe(false)
    expect(meta.maxGames).toBe(100)
  })
})

describe('buildBook — pruning', () => {
  it('drops moves seen fewer times than minGames', async () => {
    const games = [
      ...Array.from({ length: 4 }, () => game({ moves: '1. d4 d5 2. c4 e6' })),
      game({ moves: '1. h4 d5 2. c4 e6' }),
    ]
    const { book } = await build(games, { minGames: 3 })
    expect(Object.keys(first(book))).toEqual(['d4'])
  })

  it('removes a position left with no moves after pruning', async () => {
    const { book } = await build([game({ moves: '1. d4 d5 2. c4' })], { minGames: 5 })
    expect(book.size).toBe(0)
  })
})

describe('buildBook — input formats', () => {
  const one = game({ moves: '1. d4 d5 2. c4 e6' })

  it('reads a gzipped PGN', async () => {
    const path = join(dir, 'g.pgn.gz')
    writeFileSync(path, gzipSync(Buffer.from(one)))
    const { meta } = await buildBook({ file: path, minRating: 1500, maxRating: 1900, minGames: 1 })
    expect(meta.gamesUsed).toBe(1)
  })

  it('reads a zstd PGN', async () => {
    const path = join(dir, 'z.pgn.zst')
    writeFileSync(path, zstdCompress(Buffer.from(one)))
    const { meta } = await buildBook({ file: path, minRating: 1500, maxRating: 1900, minGames: 1 })
    expect(meta.gamesUsed).toBe(1)
  })

  it('detects the format from content, not the file name', async () => {
    // Trusting an extension is how a binary Scid database gets fed to a text
    // parser and reports "scanned 0 games" with no indication why.
    const path = join(dir, 'lying-name.pgn')
    writeFileSync(path, gzipSync(Buffer.from(one)))
    const { meta } = await buildBook({ file: path, minRating: 1500, maxRating: 1900, minGames: 1 })
    expect(meta.gamesUsed).toBe(1)
  })
})
