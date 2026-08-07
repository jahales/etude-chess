import { describe, it, expect, afterAll, beforeEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Chess } from 'chess.js'
import { fenKey } from '../../src/domain/repertoirePgn.ts'
import {
  buildAll,
  mergePgn,
  parseArgs,
  parseManifest,
  resolveEntry,
  summarise,
  illegalLines,
  isBuilt,
  numberFlag,
  pgnError,
  readBranch,
  resolveOnly,
  splitByColour,
  stringFlag,
  writeBranch,
  CRAWL_PLIES,
  DEFAULT_MANIFEST,
  MIN_OWN_PLIES,
} from './build.mjs'

// The batch layer: many crawls, one repertoire. Runs against the same stubs
// crawl.test.mjs uses, so a whole multi-branch build takes milliseconds.
//
// What is actually being tested here is agreement between branches. One crawl is
// always self-consistent; two crawls that both answer 2...e6 with a different
// move are a repertoire you cannot play.

const cp = (value) => ({ type: 'cp', value })

function stubEngine({ scores = {}, breadth = 5 } = {}) {
  let searches = 0
  return {
    async analyse(fen, { multipv = 1 } = {}) {
      searches++
      const legal = new Chess(fen).moves({ verbose: true })
      const base = scores[fenKey(fen)] ?? 0
      const lines = []
      for (let i = 0; i < Math.min(multipv, Math.max(1, legal.length)); i++) {
        lines.push({
          multipv: i + 1,
          score: cp(base - (i < breadth ? 0 : 400)),
          pv: legal[i] ? [legal[i].lan] : [],
        })
      }
      return { lines, bestMove: lines[0]?.pv[0] ?? null, depth: 22 }
    },
    searchCount: () => searches,
    quit: async () => {},
  }
}

function stubBook(spec) {
  const positions = {}
  for (const [path, moves] of Object.entries(spec)) {
    const chess = new Chess()
    for (const san of path.split(/\s+/).filter(Boolean)) chess.move(san)
    const fen = chess.fen()
    positions[fenKey(fen)] = moves.map((m) => {
      const mv = new Chess(fen).move(m.san)
      return { san: mv.san, uci: mv.lan, white: m.w ?? 0, draws: m.d ?? 0, black: m.b ?? 0 }
    })
  }
  return {
    async query(fen) {
      const moves = positions[fenKey(fen)] ?? []
      const tally = moves.reduce(
        (a, m) => ({ white: a.white + m.white, draws: a.draws + m.draws, black: a.black + m.black }),
        { white: 0, draws: 0, black: 0 },
      )
      return { ...tally, opening: null, moves }
    },
    stats: () => ({}),
  }
}

const BOOK = stubBook({
  d4: [{ san: 'd5', w: 400, d: 100, b: 400 }],
  'd4 d5': [{ san: 'c4', w: 400, d: 100, b: 300 }],
  'd4 d5 c4': [
    { san: 'e6', w: 300, d: 100, b: 300 },
    { san: 'e5', w: 20, d: 0, b: 80 },
  ],
  'd4 d5 c4 e6': [{ san: 'cxd5', w: 400, d: 100, b: 300 }],
  'd4 d5 c4 e6 cxd5': [{ san: 'exd5', w: 400, d: 100, b: 300 }],
  'd4 d5 c4 e5': [{ san: 'dxe5', w: 400, d: 100, b: 300 }],
})

// maxPly is explicit so the stub book, not the depth rule, bounds these trees.
const ENTRIES = [
  { id: 'sweeper', name: 'Queen’s Gambit — rare replies', color: 'w', line: 'd4 d5 c4', why: 'the tail', maxPly: 8 },
  { id: 'exchange', name: 'QGD Exchange', color: 'w', line: 'd4 d5 c4 e6 cxd5', why: 'the Carlsbad', maxPly: 8 },
]

const build = (entries = ENTRIES, opts = {}) =>
  buildAll({
    entries,
    engine: stubEngine({ scores: { [fenKeyOf('d4 d5 c4 e5')]: 300 } }),
    explorer: BOOK,
    date: '2026-08-06',
    defaults: { minPly: 99 },
    ...opts,
  })

function fenKeyOf(path) {
  const chess = new Chess()
  for (const san of path.split(/\s+/).filter(Boolean)) chess.move(san)
  return fenKey(chess.fen())
}

const byId = (results, id) => results.find((r) => r.entry.id === id)

// Scratch directories, removed together at the end. Left behind, they
// accumulate full branch dumps across runs and make it impossible to tell a
// leftover from a live fixture when debugging.
const scratchDirs = []
const scratch = (prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  scratchDirs.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true })
})

describe('parseManifest', () => {
  const valid = JSON.stringify({ entries: [{ id: 'a', name: 'A', color: 'w', line: 'd4' }] })

  it('reads a well-formed manifest', () => {
    expect(parseManifest(valid)).toHaveLength(1)
  })

  it('names the file rather than leaking a JSON parser error', () => {
    expect(() => parseManifest('{oops')).toThrow(/not valid JSON/)
  })

  it('rejects a manifest with no entries', () => {
    expect(() => parseManifest('{"entries": []}')).toThrow(/no .entries/)
    expect(() => parseManifest('{}')).toThrow(/no .entries/)
  })

  it('rejects a colour that is neither w nor b', () => {
    // "white" is the obvious thing to type and would crawl the wrong side in
    // silence, because the crawler only checks whether the string starts with b.
    expect(() => parseManifest(JSON.stringify({ entries: [{ id: 'a', name: 'A', color: 'white', line: 'd4' }] }))).toThrow(
      /colour "white"/,
    )
  })

  it('rejects an entry missing an id, a name or a line', () => {
    expect(() => parseManifest('{"entries":[{"name":"A","color":"w","line":"d4"}]}')).toThrow(/id and a name/)
    expect(() => parseManifest('{"entries":[{"id":"a","name":"A","color":"w"}]}')).toThrow(/no line/)
  })
})

describe('resolveEntry — how deep each branch crawls', () => {
  it('gives every branch the same crawl, not the same depth', () => {
    // A flat cap is wrong both ways: too shallow for a branch starting at ply 6
    // to find a quiet position, and far too deep for a sweeper off move one.
    expect(resolveEntry({ line: 'd4 d5 c4' }).maxPly).toBe(3 + CRAWL_PLIES)
    expect(resolveEntry({ line: 'e4 c6 d4 d5 exd5 cxd5' }).maxPly).toBe(6 + CRAWL_PLIES)
  })

  it('never caps a branch before it is allowed to stop', () => {
    // maxPly at or below minPly means the quiet test can never fire and the
    // branch ends on a depth cap — a line with no trainable position in it.
    const shallow = resolveEntry({ line: 'd4' }, { crawlPlies: 2 })
    expect(shallow.maxPly).toBeGreaterThan(shallow.minPly)
  })

  it('honours an explicit cap', () => {
    expect(resolveEntry({ line: 'd4 d5 c4 dxc4 e3', maxPly: 13 }).maxPly).toBe(13)
  })

  it('takes the crawl length from the run when it is given one', () => {
    expect(resolveEntry({ line: 'd4 d5 c4' }, { crawlPlies: 9 }).maxPly).toBe(12)
  })

  it('never lets a branch stop on its own root', () => {
    // The Caro-Kann Advance opens `1.e4 c6 2.d4 d5 3.e5 Bf5`, which is already a
    // quiet position at ply 6 — the global floor. Left alone the branch was one
    // node and no content: the prefix is scaffolding to reach the position worth
    // studying, and cannot also be the study.
    expect(resolveEntry({ line: 'e4 c6 d4 d5 e5 Bf5' }).minPly).toBe(6 + MIN_OWN_PLIES)
    expect(resolveEntry({ line: 'd4 d5 c4 c6 Nf3 Nf6' }).minPly).toBe(6 + MIN_OWN_PLIES)
  })

  it('keeps the global floor for a branch that starts shallower', () => {
    expect(resolveEntry({ line: 'd4' }).minPly).toBe(6)
    expect(resolveEntry({ line: 'd4 d5 c4' }).minPly).toBe(6)
  })

  it('still leaves room to stop once the floor moves', () => {
    const deep = resolveEntry({ line: 'e4 c6 d4 d5 exd5 cxd5' })
    expect(deep.maxPly).toBeGreaterThan(deep.minPly)
  })

  it('honours an explicit floor', () => {
    expect(resolveEntry({ line: 'e4 c6 d4 d5 e5 Bf5', minPly: 6 }).minPly).toBe(6)
  })

  it('splits the curated prefix for the crawler', () => {
    expect(resolveEntry({ line: ' d4  d5 c4 ' }).forced).toEqual(['d4', 'd5', 'c4'])
  })
})

describe('buildAll — branches that agree with each other', () => {
  it('crawls every branch', async () => {
    const results = await build()
    expect(results.map((r) => r.entry.id)).toEqual(['sweeper', 'exchange'])
    for (const r of results) expect(r.error).toBeUndefined()
  })

  it('stops the sweeper where the curated branch takes over', async () => {
    const sweeper = byId(await build(), 'sweeper')
    const node = [...sweeper.crawled.nodes.values()].find((n) => (n.line ?? []).join(' ') === 'd4 d5 c4 e6')
    expect(node).toMatchObject({ terminalReason: 'delegated', delegatedTo: 'exchange' })
    expect(sweeper.load.delegated).toBe(1)
  })

  it('lets the owning branch crawl the subtree it owns', async () => {
    const exchange = byId(await build(), 'exchange')
    expect(exchange.crawled.forcedSans).toEqual(['d4', 'd5', 'c4', 'e6', 'cxd5'])
    expect(exchange.crawled.nodes.size).toBeGreaterThan(1)
  })

  it('derives boundaries from the whole manifest, not from what is being run', async () => {
    // --only must not silently produce a branch that contradicts the ones it
    // skipped, so the entry list passed in stays the authority.
    const results = await build(ENTRIES.slice(0, 1), { plan: ENTRIES })
    expect(results).toHaveLength(1)
    expect(byId(results, 'sweeper').load.delegated).toBe(1)
  })

  it('names each branch in its PGN, so a trainer says what it is drilling', async () => {
    const results = await build()
    expect(byId(results, 'exchange').pgn).toContain('[Event "Repertoire — White: QGD Exchange"]')
    expect(byId(results, 'sweeper').pgn).toContain('{the tail}')
  })

  it('points the PGN at whoever owns a delegated subtree', async () => {
    expect(byId(await build(), 'sweeper').pgn).toContain('covered in the "exchange" line')
  })

  it('reports what each branch costs to learn', async () => {
    const sweeper = byId(await build(), 'sweeper')
    expect(sweeper.load.ourDecisions).toBeGreaterThanOrEqual(0)
    expect(sweeper.load.preparedReplies).toBeGreaterThan(0)
  })

  it('carries provenance into every branch', async () => {
    const results = await build(ENTRIES, { provenance: { engine: 'stockfish.exe', nodes: 400000, threads: 1 } })
    for (const r of results) {
      expect(r.pgn).toContain('[EngineThreads "1"]')
      expect(r.pgn).toContain('[Reproducible "yes"]')
    }
  })

  it('does not let one bad branch take the run down', async () => {
    // An hour of engine time is a lot to lose to one illegal prefix, and the
    // natural response to a crash is to stop running the build at all.
    const results = await build([{ id: 'broken', name: 'Broken', color: 'w', line: 'd4 d4' }, ...ENTRIES])
    expect(results[0].error).toBeInstanceOf(Error)
    expect(results[0].error.message).toMatch(/illegal move/)
    expect(results.slice(1).every((r) => !r.error)).toBe(true)
  })
})

describe('mergePgn', () => {
  it('joins games with the blank line the standard asks for', () => {
    expect(mergePgn(['[Event "a"]\n\n1. d4 *\n', '[Event "b"]\n\n1. e4 *\n'])).toBe(
      '[Event "a"]\n\n1. d4 *\n\n[Event "b"]\n\n1. e4 *\n',
    )
  })

  it('produces one game per branch', async () => {
    const merged = mergePgn((await build()).map((r) => r.pgn))
    expect(merged.match(/\[Event /g)).toHaveLength(2)
  })

  it('produces nothing at all for an empty build, not a blank line', () => {
    // A file holding one newline imports as a game with no moves, which then
    // sits in the library looking like a branch that failed.
    expect(mergePgn([])).toBe('')
  })
})

describe('summarise', () => {
  it('rolls the branches up and tags every trap with where it was found', async () => {
    const summary = summarise(await build())
    expect(summary.branches).toBe(2)
    expect(summary.positions).toBeGreaterThan(0)
    expect(summary.load.ourDecisions).toBeGreaterThanOrEqual(0)
    for (const t of summary.traps) expect(t.entry).toBeTruthy()
  })

  it('ranks traps across the whole repertoire, not per branch', async () => {
    const summary = summarise(await build())
    const values = summary.traps.map((t) => t.trapValue)
    expect([...values].sort((a, b) => b - a)).toEqual(values)
  })

  it('reports failed branches rather than quietly omitting them', async () => {
    const summary = summarise(await build([{ id: 'broken', name: 'B', color: 'w', line: 'd4 d4' }, ...ENTRIES]))
    expect(summary.failed).toEqual([{ id: 'broken', error: expect.stringMatching(/illegal move/) }])
    expect(summary.branches).toBe(3)
  })
})

describe('buildAll — running a subset', () => {
  it('a branch rebuilt alone still stops where the skipped branch takes over', async () => {
    // Without this, `--only sweeper` yields a sweeper that answers 2...e6
    // itself while the QGD Exchange branch on disk answers it differently —
    // two moves for one position, which is not a repertoire.
    const alone = await build(ENTRIES.slice(0, 1), { plan: ENTRIES })
    const whole = await build(ENTRIES)
    expect(byId(alone, 'sweeper').crawled.nodes.size).toBe(byId(whole, 'sweeper').crawled.nodes.size)
  })

  it('crawls the whole subtree when the plan really is just this branch', async () => {
    const solo = await build(ENTRIES.slice(0, 1))
    expect(byId(solo, 'sweeper').load.delegated).toBe(0)
    expect(byId(solo, 'sweeper').crawled.nodes.size).toBeGreaterThan(
      byId(await build(ENTRIES.slice(0, 1), { plan: ENTRIES }), 'sweeper').crawled.nodes.size,
    )
  })
})

describe('parseArgs', () => {
  it('reads flags with and without values', () => {
    expect(parseArgs(['--nodes', '400000', '--resume'])).toEqual({ nodes: '400000', resume: true })
  })

  it('rejects an unknown option instead of ignoring it', () => {
    // A silently-dropped `--trap 0.01` runs the whole build at the default and
    // reports success — an hour of engine time to discover. This exact thing
    // happened while building the manifest.
    expect(() => parseArgs(['--trapp', '0.01'])).toThrow(/unknown option --trapp/)
  })

  it('lists what it does accept, so the fix is in the error', () => {
    expect(() => parseArgs(['--nope'])).toThrow(/--nodes/)
  })

  it('rejects a bare argument rather than skipping it', () => {
    expect(() => parseArgs(['out/repertoire'])).toThrow(/unexpected argument/)
  })

  it('treats a following flag as the end of a value', () => {
    expect(parseArgs(['--check', '--nodes', '1'])).toEqual({ check: true, nodes: '1' })
  })
})

describe('readBranch — resuming without losing the rest of the repertoire', () => {
  let dir
  beforeEach(() => {
    dir = scratch('rep-build-')
  })

  it('round-trips a written branch back into the shape buildAll returns', async () => {
    const [written] = await build(ENTRIES.slice(1))
    await writeBranch(dir, written)
    const read = await readBranch(dir, ENTRIES[1])
    expect(read.entry.id).toBe('exchange')
    expect(read.pgn).toBe(written.pgn)
    expect(read.load).toEqual(written.load)
    expect(read.crawled.nodes.size).toBe(written.crawled.nodes.size)
    expect(read.crawled.rootFen).toBe(written.crawled.rootFen)
    expect(read.reused).toBe(true)
  })

  it('carries the report, so a resumed run still ranks the traps it found before', async () => {
    const [sweeper] = await build(ENTRIES.slice(0, 1), { plan: ENTRIES })
    await writeBranch(dir, sweeper)
    const read = await readBranch(dir, ENTRIES[0])
    expect(read.crawled.report.traps).toEqual(sweeper.crawled.report.traps)
    expect(summarise([read]).traps.map((t) => t.line)).toEqual(
      summarise([sweeper]).traps.map((t) => t.line),
    )
  })

  it('merges reused and freshly-crawled branches into one repertoire', async () => {
    // The bug: --resume skipped what was already built, so repertoire.pgn held
    // only today's branches — a repertoire missing most of itself, written
    // without complaint.
    const all = await build()
    for (const r of all) await writeBranch(dir, r)
    const reused = await readBranch(dir, ENTRIES[0])
    const fresh = await build(ENTRIES.slice(1))
    expect(mergePgn([reused, ...fresh].map((r) => r.pgn)).match(/\[Event /g)).toHaveLength(2)
  })
})

describe('the PGN a build actually emits', () => {
  // Ground truth over logic. Every unit test above passed while the generated
  // repertoire loaded in no parser at all: three `{…}` comments in a row on one
  // move, and a comment after a closing parenthesis. Both are legal by the
  // spec, both are rejected by chess.js — which is this project's own parser.
  const load = (pgn) => {
    const chess = new Chess()
    chess.loadPgn(pgn)
    return chess.history()
  }

  it('loads every branch, delegations and traps and all', async () => {
    for (const r of await build()) expect(() => load(r.pgn), r.entry.id).not.toThrow()
  })

  it('loads the merged file one game at a time', async () => {
    const merged = mergePgn((await build()).map((r) => r.pgn))
    const games = merged.split(/\n\s*\n(?=\[Event )/).filter((g) => g.trim())
    expect(games).toHaveLength(2)
    for (const g of games) expect(() => load(g)).not.toThrow()
  })

  it('replays the curated prefix as the start of the main line', async () => {
    const exchange = byId(await build(), 'exchange')
    expect(load(exchange.pgn).slice(0, 5)).toEqual(['d4', 'd5', 'c4', 'e6', 'cxd5'])
  })

  it('never puts two comments in a row', async () => {
    for (const r of await build()) expect(r.pgn, r.entry.id).not.toMatch(/\}\s*\{/)
  })
})

describe('pgnError — the artefact check', () => {
  it('passes a file a real parser reads', () => {
    expect(pgnError('[Event "t"]\n\n1. d4 d5 { note } (1... Nf6 2. c4) 2. c4 *\n')).toBeNull()
  })

  it('catches two comments in a row', () => {
    expect(pgnError('[Event "t"]\n\n1. d4 d5 { a } { b } 2. c4 *\n')).toBeTruthy()
  })

  it('catches a comment after a variation closes', () => {
    expect(pgnError('[Event "t"]\n\n1. d4 d5 (1... Nf6 2. c4) { note } *\n')).toBeTruthy()
  })

  it('marks a branch whose PGN will not load, without discarding the crawl', async () => {
    const [r] = await build(ENTRIES.slice(1))
    expect(r.pgnError).toBeNull()
    expect(summarise([r]).unparseable).toEqual([])
    // and a broken one is reported rather than written out in silence
    expect(summarise([{ ...r, pgnError: 'boom' }]).unparseable).toEqual([
      { id: 'exchange', error: 'boom' },
    ])
  })
})

describe('readBranch — a reused branch is checked, not assumed', () => {
  it('parses the PGN it reads back', async () => {
    const dir = scratch('rep-reuse-')
    const [written] = await build(ENTRIES.slice(1))
    await writeBranch(dir, written)
    expect((await readBranch(dir, ENTRIES[1])).pgnError).toBeNull()
  })

  it('re-renders past a stored PGN an older renderer left unreadable', async () => {
    // The case that matters: the renderer changed between runs, so what is on
    // disk was produced by code that no longer exists. Rendering afresh from the
    // stored tree means a fixed renderer reaches every reused branch — and the
    // check still runs on what it produced, not on what it found.
    const dir = scratch('rep-reuse-')
    const [written] = await build(ENTRIES.slice(1))
    await writeBranch(dir, written)
    writeFileSync(
      join(dir, 'exchange.pgn'),
      '[Event "t"]\n[Date "2026.08.06"]\n\n1. d4 d5 { a } { b } *\n',
    )
    const read = await readBranch(dir, ENTRIES[1])
    expect(read.pgnError).toBeNull()
    expect(read.pgn).not.toMatch(/\}\s*\{/)
    expect(summarise([read]).unparseable).toEqual([])
  })

  it('keeps the date the branch was crawled rather than restamping it', async () => {
    // A re-render is not a new crawl. Restamping would churn the committed
    // artefact's dates every time the renderer changes.
    const dir = scratch('rep-date-')
    const [written] = await build(ENTRIES.slice(1))
    await writeBranch(dir, written)
    const read = await readBranch(dir, ENTRIES[1], {}, { date: '2030-01-01' })
    expect(read.pgn).toContain('[Date "2026.08.06"]')
  })
})

// ---------------------------------------------------------------------------
// Regression tests from the #93 review. Written first, red, then fixed.
// ---------------------------------------------------------------------------

describe('buildAll — reporting failures must not be crawl failures', () => {
  it('does not lose the run when writing a branch fails', async () => {
    // `await onEntry(...)` sat inside the per-branch try, so a disk error was
    // recorded as a failed crawl — and the catch block's own onEntry(failed)
    // then threw uncaught, taking the remaining branches with it.
    const results = await build(ENTRIES, {
      onEntry: async () => {
        throw new Error('disk full')
      },
    })
    expect(results).toHaveLength(2)
    expect(results.every((r) => !r.error)).toBe(true)
    expect(results.every((r) => r.pgn)).toBe(true)
  })

  it('reports a write failure rather than swallowing it', async () => {
    const results = await build(ENTRIES.slice(0, 1), {
      plan: ENTRIES,
      onEntry: async () => {
        throw new Error('disk full')
      },
    })
    expect(results[0].writeError).toMatch(/disk full/)
    expect(summarise(results).unwritten).toEqual([{ id: 'sweeper', error: 'disk full' }])
  })

  it('still reports a genuine crawl failure as one', async () => {
    const results = await build([{ id: 'broken', name: 'B', color: 'w', line: 'd4 d4' }])
    expect(results[0].error).toBeInstanceOf(Error)
    expect(results[0].writeError).toBeUndefined()
  })
})

describe('readBranch — output written by an older version', () => {
  let dir
  beforeEach(() => {
    dir = scratch('rep-old-')
  })

  it('survives a branch file with no report or load', async () => {
    // Exactly the cross-version case --resume exists for: summarise used to die
    // with "Cannot read properties of undefined (reading 'traps')".
    const [r] = await build(ENTRIES.slice(1))
    await writeBranch(dir, r)
    const saved = JSON.parse(readFileSync(join(dir, 'exchange.json'), 'utf8'))
    delete saved.report
    delete saved.load
    writeFileSync(join(dir, 'exchange.json'), JSON.stringify(saved))

    const read = await readBranch(dir, ENTRIES[1])
    expect(read.load).toMatchObject({ ourDecisions: expect.any(Number) })
    expect(read.crawled.report.traps).toEqual([])
    expect(() => summarise([read])).not.toThrow()
  })

  it('rebuilds the theory load from the positions rather than reporting zero', async () => {
    const [r] = await build(ENTRIES.slice(0, 1), { plan: ENTRIES })
    await writeBranch(dir, r)
    const saved = JSON.parse(readFileSync(join(dir, 'sweeper.json'), 'utf8'))
    delete saved.load
    writeFileSync(join(dir, 'sweeper.json'), JSON.stringify(saved))
    expect((await readBranch(dir, ENTRIES[0])).load).toEqual(r.load)
  })

  it('carries the run defaults into a reused branch', async () => {
    // Otherwise a resumed run reports depths that describe neither the file on
    // disk nor the flags it was given.
    const [r] = await build(ENTRIES.slice(1))
    await writeBranch(dir, r)
    const uncapped = { ...ENTRIES[1], maxPly: undefined }
    const read = await readBranch(dir, uncapped, { crawlPlies: 9 })
    expect(read.entry.maxPly).toBe(resolveEntry(uncapped, { crawlPlies: 9 }).maxPly)
    // and without the defaults it would report the built-in depth instead
    expect(read.entry.maxPly).not.toBe(resolveEntry(uncapped).maxPly)
  })
})

describe('--resume — a half-written branch', () => {
  it('does not count a branch whose PGN never made it to disk', async () => {
    // writeBranch writes the JSON then the PGN, so a kill between the two
    // leaves precisely this state — and resume died on ENOENT before crawling
    // anything, with no way forward but deleting the file by hand.
    const dir = scratch('rep-half-')
    const [r] = await build(ENTRIES.slice(1))
    await writeBranch(dir, r)
    rmSync(join(dir, 'exchange.pgn'))
    expect(isBuilt(dir, ENTRIES[1])).toBe(false)
  })

  it('counts a branch with both files', async () => {
    const dir = scratch('rep-whole-')
    const [r] = await build(ENTRIES.slice(1))
    await writeBranch(dir, r)
    expect(isBuilt(dir, ENTRIES[1])).toBe(true)
  })

  it('is false for a branch never built', () => {
    expect(isBuilt(scratch('rep-none-'), ENTRIES[0])).toBe(false)
  })
})

describe('numberFlag — a value flag given no value', () => {
  it('reads a number', () => {
    expect(numberFlag({ nodes: '120000' }, 'nodes')).toBe(120000)
    expect(numberFlag({ trap: '0' }, 'trap')).toBe(0)
  })

  it('is undefined when the flag is absent, so the default stands', () => {
    expect(numberFlag({}, 'nodes')).toBeUndefined()
  })

  it('rejects a flag with its value missing rather than reading it as 1', () => {
    // `--trap --nodes 120000` set trapThreshold to Number(true) === 1, so no
    // move was ever a trap and the build reported success.
    expect(() => numberFlag({ trap: true }, 'trap')).toThrow(/--trap needs a number/)
  })

  it('rejects a value that is not a number', () => {
    expect(() => numberFlag({ nodes: 'abc' }, 'nodes')).toThrow(/--nodes needs a number/)
  })
})

describe('stringFlag', () => {
  it('reads a value', () => {
    expect(stringFlag({ out: 'out/x' }, 'out')).toBe('out/x')
  })

  it('rejects a bare flag rather than creating a directory called "true"', () => {
    expect(() => stringFlag({ out: true }, 'out')).toThrow(/--out needs a value/)
  })

  it('is undefined when absent', () => {
    expect(stringFlag({}, 'out')).toBeUndefined()
  })
})

describe('resolveOnly', () => {
  const all = [{ id: 'a' }, { id: 'b' }]

  it('selects the named branches', () => {
    expect(resolveOnly(all, 'a,b').map((e) => e.id)).toEqual(['a', 'b'])
  })

  it('names the branch it could not find', () => {
    expect(() => resolveOnly(all, 'a,zzz')).toThrow(/zzz/)
  })

  it('accepts a repeated id instead of blaming a branch that exists', () => {
    // The length comparison tripped on duplicates and then reported an empty
    // list of unknown branches.
    expect(resolveOnly(all, 'a,a').map((e) => e.id)).toEqual(['a'])
  })

  it('is null when the flag is absent, meaning everything', () => {
    expect(resolveOnly(all, undefined)).toBeNull()
  })

  it('rejects a bare --only', () => {
    expect(() => resolveOnly(all, true)).toThrow(/--only needs a value/)
  })
})

describe('illegalLines — a curated prefix that is not legal chess', () => {
  // `--check` exists so a manifest is validated before an hour of engine time.
  // It reported "manifest ok" for a line the crawler cannot play, and the run
  // only failed twenty minutes in. Lives here rather than in the domain because
  // it needs a board, and repertoirePlan.ts stays runtime-import-free.
  it('rejects a line whose moves cannot be played', () => {
    const problems = illegalLines([{ id: 'typo', name: 'T', color: 'w', line: 'd4 d5 c5' }])
    expect(problems).toHaveLength(1)
    expect(problems[0].entryId).toBe('typo')
    expect(problems[0].message).toContain('c5')
  })

  it('names the moves that were legal, so the typo is obvious', () => {
    expect(illegalLines([{ id: 'typo', name: 'T', color: 'w', line: 'd4 d5 c5' }])[0].message).toContain(
      'd4 d5',
    )
  })

  it('rejects a move that is not notation at all', () => {
    expect(illegalLines([{ id: 'junk', name: 'J', color: 'w', line: 'd4 zzz' }])[0].message).toContain('zzz')
  })

  it('accepts an empty line — that is the initial position', () => {
    expect(illegalLines([{ id: 'root', name: 'R', color: 'w', line: '' }])).toEqual([])
  })

  it('accepts every line in the shipped manifest', async () => {
    const entries = parseManifest(await readFile(DEFAULT_MANIFEST, 'utf8'))
    expect(illegalLines(entries)).toEqual([])
  })
})

describe('splitByColour — one file per side', () => {
  // En Croissant trains a repertoire from one side's point of view, so a file
  // mixing White and Black branches is not importable as either. The split is
  // part of the build rather than a manual step, or it drifts on the next run.
  const load = (pgn) => {
    const chess = new Chess()
    chess.loadPgn(pgn)
    return chess.history()
  }
  const games = (pgn) => pgn.split(/\n\s*\n(?=\[Event )/).filter((g) => g.trim())

  const MIXED = [
    ...ENTRIES,
    { id: 'caro', name: 'Caro-Kann', color: 'b', line: 'e4 c6', why: 'the defence', maxPly: 8 },
  ]

  it('puts every branch in the file for its own colour', async () => {
    const { white, black } = splitByColour(await build(MIXED))
    expect(games(white)).toHaveLength(2)
    expect(games(black)).toHaveLength(1)
  })

  it('never mixes the two, which is the whole point', async () => {
    const { white, black } = splitByColour(await build(MIXED))
    expect(white).not.toContain('Repertoire — Black')
    expect(black).not.toContain('Repertoire — White')
  })

  it('emits files a parser still reads', async () => {
    const { white, black } = splitByColour(await build(MIXED))
    for (const pgn of [white, black]) {
      for (const g of games(pgn)) expect(() => load(g)).not.toThrow()
    }
  })

  it('loses nothing — every branch lands in exactly one file', async () => {
    const results = await build(MIXED)
    const { white, black } = splitByColour(results)
    expect(games(white).length + games(black).length).toBe(results.length)
  })

  it('keeps manifest order within each file', async () => {
    const { white } = splitByColour(await build(MIXED))
    expect(games(white)[0]).toContain('rare replies')
    expect(games(white)[1]).toContain('QGD Exchange')
  })

  it('gives an empty string for a colour with no branches, not a stray newline', async () => {
    // A one-line file imports as a game with no moves and clutters the library.
    const { black } = splitByColour(await build(ENTRIES))
    expect(black).toBe('')
  })

  it('skips branches that failed to crawl', async () => {
    const results = await build([{ id: 'broken', name: 'B', color: 'w', line: 'd4 d4' }, ...ENTRIES])
    expect(games(splitByColour(results).white)).toHaveLength(2)
  })
})

describe('readBranch — resume re-renders rather than replaying an old file', () => {
  // The crawl is the expensive part and the PGN is a cheap rendering of it, so
  // resume should reuse the first and redo the second. Reading the stored .pgn
  // back verbatim meant a change to the renderer never reached a resumed
  // branch: the [Orientation] tag the trainer needs was added, every test
  // passed, and the regenerated files did not have it.
  let dir
  beforeEach(() => {
    dir = scratch('rep-render-')
  })

  it('renders the PGN from the stored tree, not from the stored PGN', async () => {
    const [r] = await build(ENTRIES.slice(1))
    await writeBranch(dir, r)
    writeFileSync(join(dir, 'exchange.pgn'), '[Event "stale"]\n\n1. d4 *\n')

    const read = await readBranch(dir, ENTRIES[1], {}, { date: '2026-08-06' })
    expect(read.pgn).not.toContain('stale')
    expect(read.pgn).toBe(r.pgn)
  })

  it('picks up a renderer change without re-crawling', async () => {
    const [r] = await build(ENTRIES.slice(1))
    await writeBranch(dir, r)
    const read = await readBranch(dir, ENTRIES[1], {}, { date: '2026-08-06' })
    expect(read.pgn).toContain('[Orientation "white"]')
  })

  it('carries the run provenance into the re-rendered file', async () => {
    const [r] = await build(ENTRIES.slice(1))
    await writeBranch(dir, r)
    const read = await readBranch(dir, ENTRIES[1], {}, {
      date: '2026-08-06',
      provenance: { engine: 'sf.exe', nodes: 120000, threads: 1 },
    })
    expect(read.pgn).toContain('[EngineNodes "120000"]')
    expect(read.pgn).toContain('[Reproducible "yes"]')
  })

  it('still checks that what it rendered will parse', async () => {
    const [r] = await build(ENTRIES.slice(1))
    await writeBranch(dir, r)
    expect((await readBranch(dir, ENTRIES[1], {}, { date: '2026-08-06' })).pgnError).toBeNull()
  })
})
