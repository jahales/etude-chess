import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { compress as zstdCompress } from 'zstd-napi'
import {
  buildBook,
  bookOptions,
  cachePath,
  ratingBand,
  speedList,
  twoPassBuild,
  DEFAULTS,
  DEFAULT_CACHE,
  FLAGS,
  HELP,
  KNOWN_SPEEDS,
} from './buildBook.mjs'
import { DEFAULT_BITS } from './positionFilter.mjs'
import { flagsNamedIn, parseArgs } from './args.mjs'
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

// ---------------------------------------------------------------------------
// The command line (#122, and #115 before it)
//
// buildBook.mjs is the front of the pipeline: every crawl, every trap statistic
// and every study ranking downstream is computed against whatever book this
// produced. It kept its own parser after #115 unified the other eight scripts,
// with both of the defects that issue was about — so a typo, or a flag whose
// value fell off, built a book that looked entirely normal and was wrong, and
// said so hours later in somebody else's numbers. The tests below are about the
// arguments, not the scan.

describe('buildBook.mjs rejects flags it does not know (#122)', () => {
  it('throws on a typo instead of scanning a 27 GB month at the defaults', () => {
    // The old parser took anything, so `--max-plies 20` built the whole book at
    // ply 16 and wrote it out — with a meta that records 16 and nothing that
    // records what you asked for.
    expect(() => parseArgs(['--max-plies', '20'], FLAGS)).toThrow(/unknown option --max-plies/)
  })

  it('names what it does accept, so the fix is in the error', () => {
    expect(() => parseArgs(['--max-plies', '20'], FLAGS)).toThrow(/--max-ply/)
  })

  it('rejects a bare argument rather than skipping past it', () => {
    // The local parser `continue`d over anything not starting with `--`, so
    // `buildBook.mjs db/book.json` ran with no --out at all.
    expect(() => parseArgs(['db/book.json'], FLAGS)).toThrow(/unexpected argument/)
  })

  it('accepts every flag the two shipped books were built with', () => {
    // The failure this fix must not introduce: a flag missing from FLAGS turns
    // a working invocation into a hard error. These are the commands in
    // README.md and in --help, which are how both shipped books were made.
    const band =
      '--month 2026-07 --out db/book-band-2026-07.json --ratings 1300-1800 ' +
      '--speeds blitz,rapid --max-ply 20 --max-games 8000000'
    const otb =
      '--file LumbrasGigaBase_OTB_Complete.7z --out db/book-otb.json ' +
      '--ratings 2200-2900 --max-ply 20 --max-games 9000000 --min-games 3'
    for (const command of [band, otb]) {
      expect(() => bookOptions(parseArgs(command.split(' '), FLAGS))).not.toThrow()
    }
  })

  it('accepts the flags only this script has', () => {
    for (const argv of [['--one-pass'], ['--no-cache'], ['--filter-bits', '24'], ['--cache', 'x']]) {
      expect(() => parseArgs(argv, FLAGS)).not.toThrow()
    }
  })
})

describe('buildBook.mjs --help says what buildBook.mjs accepts (#122)', () => {
  it('documents every flag it accepts', () => {
    // --help was the last place `--help` itself went undocumented.
    expect(flagsNamedIn(HELP)).toEqual([...FLAGS].sort())
  })

  it('accepts every flag it documents', () => {
    // The other direction, and the expensive one: a flag in --help that the
    // parser has never heard of turns a correct invocation into a hard error.
    for (const flag of flagsNamedIn(HELP)) {
      expect(() => parseArgs([`--${flag}`, 'x'], FLAGS)).not.toThrow()
    }
  })

  it('quotes the defaults from the constants, so they cannot drift', () => {
    // #115 found this text advertising `--ratings 1600-2000 --max-games 400000`
    // when neither was what the script did nor what shipped.
    expect(HELP).toContain(`--ratings   ${DEFAULTS.minRating}-${DEFAULTS.maxRating}`)
    expect(HELP).toContain(`--max-ply   ${DEFAULTS.maxPly}`)
    expect(HELP).toContain(`--max-games ${DEFAULTS.maxGames}`)
    expect(HELP).toContain(`--min-games ${DEFAULTS.minGames}`)
    expect(HELP).toContain(`--filter-bits ${DEFAULT_BITS}`)
    expect(HELP).toContain(`--cache     ${DEFAULT_CACHE}`)
    expect(HELP).toContain(DEFAULTS.speeds.join(','))
  })

  it('still shows the command the shipped band book was built with', () => {
    expect(HELP).toContain('--ratings 1300-1800')
    expect(HELP).toContain('--max-games 8000000')
  })
})

describe('bookOptions — a numeric flag with its value dropped (#122)', () => {
  it('reads a number', () => {
    expect(bookOptions({ 'max-games': '8000000' }).maxGames).toBe(8_000_000)
    expect(bookOptions({ 'max-ply': '20' }).maxPly).toBe(20)
  })

  it('rejects a bare --max-games rather than building a book from one game', () => {
    // parseArgs marks a valueless flag `true`, and Number(true) is 1. The build
    // then completes, writes a book and reports success — and every crawl, trap
    // statistic and study ranking after it is computed against that one game.
    expect(() => bookOptions({ 'max-games': true })).toThrow(/--max-games needs a number/)
    expect(() => bookOptions({ 'max-games': true })).toThrow(/value is missing/)
  })

  it('rejects every other numeric flag given no value', () => {
    for (const [flag, option] of [
      ['max-ply', 'maxPly'],
      ['max-games', 'maxGames'],
      ['min-games', 'minGames'],
      ['filter-bits', 'filterBits'],
    ]) {
      expect(() => bookOptions({ [flag]: true })).toThrow(new RegExp(`--${flag} needs a number`))
      expect(bookOptions({ [flag]: '7' })[option]).toBe(7)
    }
  })

  it('rejects a value that is not a number', () => {
    expect(() => bookOptions({ 'max-games': '8M' })).toThrow(/--max-games needs a number/)
  })

  it('leaves the defaults alone when the command line says nothing', async () => {
    // buildBook takes its defaults in the destructuring, which skips an
    // explicit undefined — so passing the keys straight through is safe here in
    // a way it was not for crawl(), which merges with a spread.
    const path = join(dir, 'defaults.pgn')
    const games = Array.from({ length: DEFAULTS.minGames }, () =>
      game({ moves: '1. d4 d5 2. c4 e6' }),
    )
    writeFileSync(path, games.join('\n'))

    const { meta } = await buildBook(bookOptions({ file: path }))
    expect(meta.ratings).toEqual([DEFAULTS.minRating, DEFAULTS.maxRating])
    expect(meta.maxPly).toBe(DEFAULTS.maxPly)
    expect(meta.maxGames).toBe(DEFAULTS.maxGames)
    expect(meta.minGames).toBe(DEFAULTS.minGames)
    expect(meta.speeds).toEqual([...DEFAULTS.speeds])
    expect(meta.gamesUsed).toBe(DEFAULTS.minGames)
  })
})

describe('bookOptions — a string flag with its value dropped (#122)', () => {
  it('rejects a bare --out rather than writing the book to a file called "true"', () => {
    // `String(true)` is 'true', and the required-argument check passed because
    // `true` is truthy — so the scan ran to the end and wrote ./true.
    expect(() => bookOptions({ out: true })).toThrow(/--out needs a value/)
  })

  it('rejects a bare --month rather than fetching a dump called "true"', () => {
    expect(() => bookOptions({ month: true })).toThrow(/--month needs a value/)
  })

  it('rejects a bare --file and a bare --cache', () => {
    expect(() => bookOptions({ file: true })).toThrow(/--file needs a value/)
    expect(() => bookOptions({ cache: true })).toThrow(/--cache needs a value/)
  })
})

describe('ratingBand — a min-max range, not the explorer buckets', () => {
  it('reads a range', () => {
    expect(ratingBand({ ratings: '1300-1800' })).toEqual([1300, 1800])
  })

  it('is undefined when absent, so the default band stands', () => {
    expect(ratingBand({})).toBeUndefined()
    expect(bookOptions({}).minRating).toBeUndefined()
  })

  it("rejects crawl.mjs's bucket syntax rather than scanning a month for nothing", () => {
    // '1600,1800'.split('-') is one NaN, and no game falls inside a NaN band —
    // so the whole dump is read and the book comes out empty.
    expect(() => ratingBand({ ratings: '1600,1800' })).toThrow(/min-max range/)
  })

  it('rejects a bare --ratings', () => {
    expect(() => ratingBand({ ratings: true })).toThrow(/--ratings needs a value/)
  })

  it('rejects one number, which used to mean a band nobody asked for', () => {
    expect(() => ratingBand({ ratings: '1600' })).toThrow(/min-max range/)
  })

  it('rejects a range that runs backwards', () => {
    expect(() => ratingBand({ ratings: '1800-1300' })).toThrow(/above/)
  })
})

describe('speedList — the speeds a dump actually names', () => {
  it('reads a comma-separated list', () => {
    expect(speedList({ speeds: 'blitz,rapid' })).toEqual(['blitz', 'rapid'])
  })

  it('is undefined when absent, so the default speeds stand', () => {
    expect(speedList({})).toBeUndefined()
  })

  it('rejects a misspelling rather than emptying the book', () => {
    // The scan excludes known-wrong speeds rather than requiring a known-right
    // one, so 'blizt' keeps only games naming no speed at all — which on a
    // Lichess month is none of them.
    expect(() => speedList({ speeds: 'blizt' })).toThrow(/--speeds takes any of/)
    expect(() => speedList({ speeds: 'blitz,rapdi' })).toThrow(/rapdi/)
  })

  it('rejects a bare --speeds', () => {
    expect(() => speedList({ speeds: true })).toThrow(/--speeds needs a value/)
  })

  it('accepts every speed the scan can match', () => {
    expect(speedList({ speeds: KNOWN_SPEEDS.join(',') })).toEqual(KNOWN_SPEEDS)
  })
})

describe('cachePath — only --no-cache turns the cache off (#122)', () => {
  it('caches at the default when nothing is said', () => {
    // Absence is not "off". Backwards, this silently re-downloads 27 GB on
    // every run — or writes it to a disk that was never offered.
    expect(cachePath({})).toBe(DEFAULT_CACHE)
    expect(bookOptions({}).cache).toBe(DEFAULT_CACHE)
  })

  it('is off, and only off, when --no-cache is given', () => {
    expect(cachePath({ 'no-cache': true })).toBeNull()
  })

  it('takes a path from --cache', () => {
    expect(cachePath({ cache: 'db/other' })).toBe('db/other')
  })

  it('lets --no-cache win over --cache, as it always has', () => {
    expect(cachePath({ cache: 'db/other', 'no-cache': true })).toBeNull()
  })
})

describe('twoPassBuild — the counting pass (#122)', () => {
  it('counts first for a local file, where a second read is cheap', () => {
    expect(twoPassBuild({ file: 'games.pgn' })).toBe(true)
  })

  it('does not for a month, where a second read is a second download', () => {
    expect(twoPassBuild({ month: '2026-07' })).toBe(false)
  })

  it('is turned off by --one-pass, which takes no value', () => {
    expect(twoPassBuild({ file: 'games.pgn', 'one-pass': true })).toBe(false)
  })
})
