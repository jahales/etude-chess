import { describe, it, expect } from 'vitest'
import { Chess } from 'chess.js'
import { fenKey } from '../../src/domain/repertoirePgn.ts'
import { crawl, crawlOptions, ratingBuckets, DEFAULTS, FLAGS, HELP } from './crawl.mjs'
import { FLAGS as BUILD_FLAGS } from './build.mjs'
import { flagsNamedIn, parseArgs } from './args.mjs'

// Unit tests for the crawler itself. `crawl()` takes its engine and books as
// parameters, so the whole thing runs deterministically with stubs — no
// Stockfish, no network, milliseconds.
//
// This file exists because twelve real defects shipped through this pipeline and
// none were caught by a test: every one lived in orchestration, and orchestration
// had no tests. The punishment-verification gap in particular was fixed once and
// regressed unnoticed, because "did we actually check?" was never asserted.

const cp = (value) => ({ type: 'cp', value })

/** fenKey for a position reached by a SAN path from the initial position. */
function at(path) {
  const chess = new Chess()
  for (const san of path.split(' ').filter(Boolean)) chess.move(san)
  return fenKey(chess.fen())
}

/**
 * Engine stub. Every position is worth `scores[fenKey]` centipawns *to the side
 * to move*; `breadth` controls how many MultiPV lines sit inside the Tier-A
 * window, which is what the quiet test counts.
 */
function stubEngine({ scores = {}, breadth = 5 } = {}) {
  let searches = 0
  return {
    async analyse(fen, { multipv = 1 } = {}) {
      searches++
      const legal = new Chess(fen).moves({ verbose: true })
      const base = scores[fenKey(fen)] ?? 0
      const lines = []
      for (let i = 0; i < Math.min(multipv, Math.max(1, legal.length)); i++) {
        // Lines past `breadth` fall far enough to be outside the window.
        lines.push({
          multipv: i + 1,
          score: cp(base - (i < breadth ? 0 : 400)),
          pv: legal[i] ? [legal[i].lan] : [],
        })
      }
      return { lines, bestMove: lines[0]?.pv[0] ?? null, depth: 22 }
    },
    searchCount: () => searches,
  }
}

/** Book stub, specified as `{ 'd4 d5 c4': [{ san, w, d, b }] }`. */
function stubBook(spec) {
  const positions = {}
  for (const [path, moves] of Object.entries(spec)) {
    const chess = new Chess()
    for (const san of path.split(' ').filter(Boolean)) chess.move(san)
    const fen = chess.fen()
    positions[fenKey(fen)] = moves.map((m) => {
      const mv = new Chess(fen).move(m.san)
      return { san: mv.san, uci: mv.lan, white: m.w ?? 0, draws: m.d ?? 0, black: m.b ?? 0 }
    })
  }
  return {
    async query(fen) {
      const moves = positions[fenKey(fen)] ?? []
      let white = 0
      let draws = 0
      let black = 0
      for (const m of moves) {
        white += m.white
        draws += m.draws
        black += m.black
      }
      return { white, draws, black, opening: null, moves }
    },
    stats: () => ({}),
  }
}

/** Defaults that keep a test focused: never stop early for quietness. */
const run = (opts) =>
  crawl({ ourColor: 'w', forcedLine: ['d4', 'd5', 'c4'], minPly: 99, maxPly: 6, ...opts })

const childrenAt = (result, path) => {
  const node = [...result.nodes.values()].find((n) => (n.line ?? []).join(' ') === path)
  return node?.children ?? []
}
const childFor = (result, path, san) => childrenAt(result, path).find((c) => c.san === san)

// A trap: Black's 2...e5 is bad by evaluation yet scores far better than it
// deserves. `d4 d5 c4 e5` evaluates +300 for White, so Black gave up real ground
// and we can punish it.
const TRAP_BOOK = {
  'd4 d5 c4': [
    { san: 'e6', w: 300, d: 100, b: 300 }, // the main line
    { san: 'e5', w: 20, d: 0, b: 80 }, // the trap: Black scores 80%
  ],
  'd4 d5 c4 e6': [{ san: 'Nc3', w: 400, d: 100, b: 300 }],
  'd4 d5 c4 e5': [{ san: 'dxe5', w: 400, d: 100, b: 300 }],
}

describe('crawl — trap punishment verification', () => {
  it('confirms a trap whose punishment actually materialises', async () => {
    const result = await run({
      engine: stubEngine({ scores: { [at('d4 d5 c4 e5')]: 300 } }),
      explorer: stubBook(TRAP_BOOK),
    })
    const trap = childFor(result, 'd4 d5 c4', 'e5')
    expect(trap.reason).toContain('trap')
    expect(trap.punished).toBe(true)
    expect(trap.afterReplyWinPercent).toBeGreaterThan(55)
    expect(result.report.unpunishedTraps).toEqual([])
    expect(result.report.unverifiedTraps).toEqual([])
  })

  it('marks a trap we cannot actually punish', async () => {
    // The opponent already stood better and their "trap" only gives that up:
    // we equalise rather than win, so the punishment does not exist.
    const result = await run({
      engine: stubEngine({
        scores: { [at('d4 d5 c4')]: 120, [at('d4 d5 c4 e5')]: 0 },
      }),
      explorer: stubBook(TRAP_BOOK),
    })
    const trap = childFor(result, 'd4 d5 c4', 'e5')
    expect(trap.reason).toContain('trap')
    expect(trap.punished).toBe(false)
    expect(result.report.unpunishedTraps).toHaveLength(1)
    expect(result.report.unpunishedTraps[0].line).toBe('d4 d5 c4 e5')
  })

  it('reports a trap whose follow-up hit the depth cap as unverified', async () => {
    // The regression this file exists for: the check used to sit after the
    // depth-cap `continue`, so `punished` stayed undefined — and undefined
    // rendered in the PGN exactly like a confirmed punishment.
    const result = await run({
      maxPly: 4, // the position after 2...e5 is ply 4, so it is capped on arrival
      engine: stubEngine({ scores: { [at('d4 d5 c4 e5')]: 300 } }),
      explorer: stubBook(TRAP_BOOK),
    })
    const trap = childFor(result, 'd4 d5 c4', 'e5')
    expect(trap.punished).toBeUndefined()
    expect(result.report.unverifiedTraps.map((t) => t.line)).toContain('d4 d5 c4 e5')
  })

  it('settles a trap that transposes into an already-assessed position', async () => {
    // Both 2...e6 3.Nc3 and 2...Nc6 3.Nc3 can reach the same position. Whichever
    // arrives second hits the transposition `continue`; the pending trap must
    // still be answered, from the win% already recorded there.
    const spec = {
      'd4 d5 c4': [
        { san: 'e6', w: 300, d: 100, b: 300 },
        { san: 'Nc6', w: 20, d: 0, b: 80 },
      ],
      'd4 d5 c4 e6': [{ san: 'Nc3', w: 400, d: 100, b: 300 }],
      'd4 d5 c4 Nc6': [{ san: 'Nc3', w: 400, d: 100, b: 300 }],
    }
    const result = await run({
      engine: stubEngine({ scores: { [at('d4 d5 c4 Nc6')]: 300 } }),
      explorer: stubBook(spec),
    })
    const trap = childFor(result, 'd4 d5 c4', 'Nc6')
    // Either answered outright, or explicitly recorded as unverified — never
    // left silently undefined while claiming nothing is wrong.
    const named = result.report.unverifiedTraps.map((t) => t.line)
    expect(trap.punished !== undefined || named.includes('d4 d5 c4 Nc6')).toBe(true)
  })

  it('never leaves a trap silently unaccounted for', async () => {
    const result = await run({
      maxPly: 4,
      engine: stubEngine({ scores: { [at('d4 d5 c4 e5')]: 300 } }),
      explorer: stubBook(TRAP_BOOK),
    })
    for (const trap of result.report.traps) {
      const child = childFor(result, 'd4 d5 c4', trap.san)
      const accounted =
        child.punished !== undefined ||
        result.report.unverifiedTraps.some((t) => t.line === trap.line)
      expect(accounted).toBe(true)
    }
  })
})

describe('crawl — choosing our move', () => {
  const CHOICE_BOOK = {
    'd4 d5 c4': [{ san: 'e6', w: 300, d: 100, b: 300 }],
    'd4 d5 c4 e6': [
      { san: 'Nc3', w: 400, d: 100, b: 300 },
      { san: 'Nf3', w: 100, d: 50, b: 100 },
    ],
    'd4 d5 c4 e6 Nc3': [{ san: 'Nf6', w: 200, d: 50, b: 200 }],
    'd4 d5 c4 e6 Nf3': [{ san: 'Nf6', w: 200, d: 50, b: 200 }],
  }

  it('picks exactly one move at our nodes — that is what makes it a repertoire', async () => {
    const result = await run({
      engine: stubEngine(),
      explorer: stubBook(CHOICE_BOOK),
    })
    expect(childrenAt(result, 'd4 d5 c4 e6')).toHaveLength(1)
  })

  it('refuses a move outside the soundness gate', async () => {
    // Nc3 leads to a position worth -400 to us, far outside the gate; Nf3 is
    // level. The unsound move must not be adopted however popular.
    const result = await run({
      engine: stubEngine({ scores: { [at('d4 d5 c4 e6 Nc3')]: 400 } }),
      explorer: stubBook(CHOICE_BOOK),
    })
    expect(childrenAt(result, 'd4 d5 c4 e6')[0].san).toBe('Nf3')
  })

  it('falls back to the engine when no move humans play is sound', async () => {
    // The normal case right after a trap: the refutation is too rare to appear
    // in any book, and a repertoire that gave up here would omit exactly the
    // punishments it exists to teach.
    const result = await run({
      engine: stubEngine({
        scores: { [at('d4 d5 c4 e6 Nc3')]: 400, [at('d4 d5 c4 e6 Nf3')]: 400 },
      }),
      explorer: stubBook(CHOICE_BOOK),
    })
    const child = childrenAt(result, 'd4 d5 c4 e6')[0]
    expect(child.reason).toBe('ours-engine')
    expect(result.report.engineFallbacks).toHaveLength(1)
  })

  it('prefers the canonical source for our move and records which decided', async () => {
    const canon = stubBook({
      'd4 d5 c4 e6': [{ san: 'Nf3', w: 900, d: 100, b: 200 }],
    })
    const result = await run({
      engine: stubEngine(),
      explorer: stubBook(CHOICE_BOOK),
      canon,
    })
    const child = childrenAt(result, 'd4 d5 c4 e6')[0]
    expect(child.san).toBe('Nf3') // only the master book offers it here
    expect(child.source).toBe('canon')
    expect(result.report.moveSource.canon).toBeGreaterThan(0)
  })

  it('falls back to band data when the canonical book is silent, and says so', async () => {
    const result = await run({
      engine: stubEngine(),
      explorer: stubBook(CHOICE_BOOK),
      canon: stubBook({}), // masters have never been here
    })
    expect(childrenAt(result, 'd4 d5 c4 e6')[0].source).toBe('band')
  })
})

describe('crawl — covering their moves', () => {
  it('covers the frequent replies and reports the mass reached', async () => {
    const spec = {
      'd4 d5 c4': [
        { san: 'e6', w: 300, d: 100, b: 300 },
        { san: 'c6', w: 200, d: 50, b: 200 },
        { san: 'Nf6', w: 100, d: 20, b: 100 },
      ],
      'd4 d5 c4 e6': [{ san: 'Nc3', w: 400, d: 100, b: 300 }],
      'd4 d5 c4 c6': [{ san: 'Nc3', w: 400, d: 100, b: 300 }],
      'd4 d5 c4 Nf6': [{ san: 'cxd5', w: 400, d: 100, b: 300 }],
    }
    const result = await run({ engine: stubEngine(), explorer: stubBook(spec) })
    const sans = childrenAt(result, 'd4 d5 c4').map((c) => c.san)
    expect(sans).toContain('e6')
    expect(sans).toContain('c6')
  })

  it('stops at a position the book barely knows rather than inventing lines', async () => {
    const result = await run({
      engine: stubEngine(),
      explorer: stubBook({ 'd4 d5 c4': [{ san: 'e6', w: 3, d: 1, b: 3 }] }),
    })
    expect(result.report.terminal['out-of-book']).toBeGreaterThan(0)
  })

  it('reports the evaluation cap instead of applying it silently', async () => {
    const many = ['e6', 'c6', 'Nf6', 'e5', 'Nc6', 'c5'].map((san) => ({ san, w: 40, d: 10, b: 40 }))
    const result = await run({
      maxEvalPerNode: 2,
      engine: stubEngine(),
      explorer: stubBook({ 'd4 d5 c4': many }),
    })
    expect(result.report.truncatedNodes).toHaveLength(1)
    expect(result.report.truncatedNodes[0]).toMatchObject({ evaluated: 2, available: 6 })
  })
})

describe('crawl — stopping', () => {
  it('stops at a quiet position and records why', async () => {
    const result = await run({
      minPly: 3, // the root itself qualifies
      engine: stubEngine({ breadth: 5 }),
      explorer: stubBook({ 'd4 d5 c4': [{ san: 'e6', w: 300, d: 100, b: 300 }] }),
    })
    expect(result.report.terminal.quiet).toBeGreaterThan(0)
  })

  it('does not stop where only one move is playable — that is a sequence', async () => {
    const result = await run({
      minPly: 3,
      engine: stubEngine({ breadth: 1 }), // everything else falls outside the window
      explorer: stubBook({
        'd4 d5 c4': [{ san: 'e6', w: 300, d: 100, b: 300 }],
        'd4 d5 c4 e6': [{ san: 'Nc3', w: 400, d: 100, b: 300 }],
      }),
    })
    expect(result.report.terminal.quiet).toBe(0)
  })

  it('honours the depth cap', async () => {
    const result = await run({
      maxPly: 4,
      engine: stubEngine(),
      explorer: stubBook({
        'd4 d5 c4': [{ san: 'e6', w: 300, d: 100, b: 300 }],
        'd4 d5 c4 e6': [{ san: 'Nc3', w: 400, d: 100, b: 300 }],
      }),
    })
    expect(result.report.terminal['depth-cap']).toBeGreaterThan(0)
    for (const node of result.nodes.values()) expect(node.ply).toBeLessThanOrEqual(4)
  })

  it('replays the curated prefix verbatim and starts there', async () => {
    const result = await run({
      engine: stubEngine(),
      explorer: stubBook({ 'd4 d5 c4': [{ san: 'e6', w: 300, d: 100, b: 300 }] }),
    })
    expect(result.forcedSans).toEqual(['d4', 'd5', 'c4'])
    expect(result.rootFen).toContain(' b ') // Black to move after 2.c4
  })

  it('rejects an illegal curated prefix rather than crawling nonsense', async () => {
    await expect(
      crawl({
        ourColor: 'w',
        forcedLine: ['d4', 'd4'],
        engine: stubEngine(),
        explorer: stubBook({}),
      }),
    ).rejects.toThrow(/illegal move/)
  })
})

// A repertoire is many crawls, and the property it must have is that you know
// which move you play. Where two branches of the manifest overlap, one owns the
// subtree and the other stops — see src/domain/repertoirePlan.ts.
describe('crawl — delegating a subtree to another branch', () => {
  const BOOK = {
    'd4 d5 c4': [
      { san: 'e6', w: 300, d: 100, b: 300 },
      { san: 'e5', w: 20, d: 0, b: 80 },
    ],
    'd4 d5 c4 e6': [{ san: 'Nc3', w: 400, d: 100, b: 300 }],
    'd4 d5 c4 e5': [{ san: 'dxe5', w: 400, d: 100, b: 300 }],
    'd4 d5 c4 e6 Nc3': [{ san: 'Nf6', w: 400, d: 100, b: 300 }],
  }

  const delegated = (opts) =>
    run({
      engine: stubEngine({ scores: { [at('d4 d5 c4 e5')]: 300 } }),
      explorer: stubBook(BOOK),
      delegations: new Map([['d4 d5 c4 e6', 'qgd-exchange']]),
      ...opts,
    })

  it('stops at the boundary instead of choosing a move the owner will choose', async () => {
    const result = await delegated()
    const node = [...result.nodes.values()].find((n) => (n.line ?? []).join(' ') === 'd4 d5 c4 e6')
    expect(node).toMatchObject({ terminal: true, terminalReason: 'delegated', delegatedTo: 'qgd-exchange' })
    expect(node.children).toEqual([])
    // and nothing beyond it was crawled
    expect([...result.nodes.values()].some((n) => (n.line ?? []).join(' ').startsWith('d4 d5 c4 e6 '))).toBe(false)
  })

  it('records the boundary on the move, so the PGN can point at the owner', async () => {
    const result = await delegated()
    expect(childFor(result, 'd4 d5 c4', 'e6').delegatedTo).toBe('qgd-exchange')
  })

  it('keeps crawling everything the boundary does not cover', async () => {
    const result = await delegated()
    expect(childFor(result, 'd4 d5 c4', 'e5')).toBeTruthy()
    expect([...result.nodes.values()].some((n) => (n.line ?? []).join(' ') === 'd4 d5 c4 e5')).toBe(true)
    expect(result.report.delegated).toEqual([{ line: 'd4 d5 c4 e6', to: 'qgd-exchange' }])
  })

  it('does not report a delegated trap as unverified — the owner verifies it', async () => {
    // Otherwise every sweeper prints "punishment not verified" over a line that
    // has in fact been checked, which trains you to ignore the warning that
    // matters.
    const result = await delegated({ delegations: new Map([['d4 d5 c4 e5', 'albin']]) })
    const trap = childFor(result, 'd4 d5 c4', 'e5')
    expect(trap.reason).toContain('trap')
    expect(trap.delegatedTo).toBe('albin')
    expect(result.report.unverifiedTraps).toEqual([])
    expect(result.report.unpunishedTraps).toEqual([])
  })

  it('still lists a delegated trap in the report, so the sweeper says what it found', async () => {
    const result = await delegated({ delegations: new Map([['d4 d5 c4 e5', 'albin']]) })
    expect(result.report.traps.map((t) => t.line)).toContain('d4 d5 c4 e5')
  })

  it('never delegates its own root', async () => {
    const result = await delegated({ delegations: new Map([['d4 d5 c4', 'somewhere-else']]) })
    expect(result.report.delegated).toEqual([])
    expect(result.nodes.size).toBeGreaterThan(1)
  })

  it('can delegate one of our own moves, not just theirs', async () => {
    const result = await run({
      ourColor: 'b',
      forcedLine: ['d4', 'd5', 'c4'],
      engine: stubEngine(),
      explorer: stubBook(BOOK),
      delegations: new Map([['d4 d5 c4 e6', 'slav']]),
    })
    expect(result.report.delegated).toEqual([{ line: 'd4 d5 c4 e6', to: 'slav' }])
  })

  it('behaves exactly as before when nothing is delegated', async () => {
    const plain = await run({ engine: stubEngine(), explorer: stubBook(BOOK) })
    expect(plain.report.delegated).toEqual([])
    expect(plain.report.terminal.delegated).toBe(0)
    expect(childFor(plain, 'd4 d5 c4', 'e6').delegatedTo).toBeUndefined()
  })

  it('accepts a plain object as well as a Map', async () => {
    const result = await delegated({ delegations: { 'd4 d5 c4 e6': 'qgd-exchange' } })
    expect(result.report.delegated).toEqual([{ line: 'd4 d5 c4 e6', to: 'qgd-exchange' }])
  })
})

describe('crawl — the shipped defaults must be usable', () => {
  // How the break got in: `DEFAULTS.minPly` was raised to match build.mjs and
  // `DEFAULTS.maxPly` was left behind, so the depth cap fired before the quiet
  // test could and no line could ever end quiet. build.mjs always passes an
  // explicit maxPly, so nothing in the suite noticed — every depth test spells
  // both plies out.
  const ladder = (sans) => {
    const spec = {}
    for (let i = 0; i < sans.length; i++) {
      spec[sans.slice(0, i).join(' ')] = [{ san: sans[i], w: 400, d: 100, b: 300 }]
    }
    return stubBook(spec)
  }

  it('leaves room between the floor and the cap', () => {
    expect(DEFAULTS.minPly).toBeLessThan(DEFAULTS.maxPly)
  })

  // A QGD to ply 20, so a line can actually reach the floor. A ladder shorter
  // than `maxPly` runs out of book first and every terminal is `out-of-book`,
  // which reports as "no quiet positions" and looks exactly like the bug this
  // block exists to catch.
  const QGD_20 = [
    'd4', 'd5', 'c4', 'e6', 'Nc3', 'Nf6', 'Nf3', 'Be7', 'Bg5', 'O-O',
    'e3', 'h6', 'Bh4', 'b6', 'cxd5', 'Nxd5', 'Bxe7', 'Qxe7', 'Nxd5', 'exd5',
  ]

  it('has a fixture deep enough to reach the shipped floor', () => {
    // Fails loudly if the defaults outgrow the ladder, rather than letting the
    // next test report zero quiet terminals for a reason that is not the bug.
    expect(QGD_20.length).toBeGreaterThanOrEqual(DEFAULTS.minPly + 4)
  })

  it('produces quiet terminals with no ply options at all', async () => {
    const result = await crawl({
      engine: stubEngine(),
      explorer: ladder(QGD_20),
      ourColor: 'w',
      forcedLine: [],
    })
    expect(result.report.terminal.quiet).toBeGreaterThan(0)
  })

  it('refuses a floor raised past the default cap, rather than ending every line on it', async () => {
    // The shape the mistake takes: raise the floor, do not notice the cap it
    // now meets. Nothing here says maxPly, so the default is in play.
    await expect(
      crawl({ engine: stubEngine(), explorer: stubBook({}), ourColor: 'w', minPly: DEFAULTS.maxPly }),
    ).rejects.toThrow(/no line could end quiet/)
  })

  it('leaves a caller that set both plies alone', async () => {
    // "Crawl to depth 6 and never stop early" is a legitimate thing to ask for,
    // and is how most of this file's tests are written.
    await expect(
      crawl({ engine: stubEngine(), explorer: stubBook({}), ourColor: 'w', minPly: 99, maxPly: 6 }),
    ).resolves.toBeTruthy()
  })
})

describe('crawl — positions another branch has already decided', () => {
  // SAN-keyed ownership cannot see a transposition: `1.d4 e6 2.c4 d5` and
  // `1.d4 d5 2.c4 e6` are the same board by different orders, so the sweeper
  // picked 3.Nc3 while the QGD Exchange branch forced 3.cxd5. En Croissant
  // keeps whichever card it walked first, so the trainer demanded a move the
  // PGN also showed as an alternative. ADR 0022 called this cheap; it is not.
  const BOOK = {
    'd4 d5 c4': [{ san: 'e6', w: 300, d: 100, b: 300 }],
    'd4 d5 c4 e6': [{ san: 'cxd5', w: 400, d: 100, b: 300 }],
    'd4 d5 c4 e6 cxd5': [{ san: 'exd5', w: 400, d: 100, b: 300 }],
  }
  const owned = (path, id) => new Map([[at(path), id]])

  it('stops where another branch already decided the position', async () => {
    const result = await run({
      engine: stubEngine(),
      explorer: stubBook(BOOK),
      ownedPositions: owned('d4 d5 c4 e6', 'qgd-exchange'),
    })
    const node = [...result.nodes.values()].find((n) => (n.line ?? []).join(' ') === 'd4 d5 c4 e6')
    expect(node).toMatchObject({ terminal: true, terminalReason: 'delegated', delegatedTo: 'qgd-exchange' })
  })

  it('reports it, so the duplication is visible rather than silent', async () => {
    const result = await run({
      engine: stubEngine(),
      explorer: stubBook(BOOK),
      ownedPositions: owned('d4 d5 c4 e6', 'qgd-exchange'),
    })
    expect(result.report.transposed).toEqual([
      { line: 'd4 d5 c4 e6', to: 'qgd-exchange' },
    ])
  })

  it('never stops on its own root, however it was reached', async () => {
    const result = await run({
      engine: stubEngine(),
      explorer: stubBook(BOOK),
      ownedPositions: owned('d4 d5 c4', 'someone-else'),
    })
    expect(result.report.transposed).toEqual([])
    expect(result.nodes.size).toBeGreaterThan(1)
  })

  it('behaves exactly as before when nothing is owned elsewhere', async () => {
    const plain = await run({ engine: stubEngine(), explorer: stubBook(BOOK) })
    const owned0 = await run({ engine: stubEngine(), explorer: stubBook(BOOK), ownedPositions: new Map() })
    expect(owned0.nodes.size).toBe(plain.nodes.size)
    expect(owned0.report.transposed).toEqual([])
  })

  it('collapses clock differences, so a transposition is recognised', async () => {
    // The two orders reach the same board with different move counters; the key
    // is the first four FEN fields, as everywhere else in the crawler.
    const viaOtherOrder = at('d4 e6 c4 d5')
    expect(viaOtherOrder).toBe(at('d4 d5 c4 e6'))
  })
})

describe('crawl — candidate evaluations come from the index first', () => {
  // Measured over a partial v2 build: 96.7% of candidate positions are already
  // in the index at median depth 34, against the ~26 a 4M-node search reaches.
  // The engine was re-deriving a worse answer than the one on disk.
  const BOOK = stubBook({
    'd4 d5 c4': [
      { san: 'e6', w: 300, d: 100, b: 300 },
      { san: 'c6', w: 200, d: 50, b: 200 },
    ],
    'd4 d5 c4 e6': [{ san: 'Nc3', w: 400, d: 100, b: 300 }],
    'd4 d5 c4 c6': [{ san: 'Nf3', w: 400, d: 100, b: 300 }],
  })

  /** Every position the crawl reaches from this book, so "all indexed" means all. */
  const ALL = new Set([
    at('d4 d5 c4 e6'), at('d4 d5 c4 c6'),
    at('d4 d5 c4 e6 Nc3'), at('d4 d5 c4 c6 Nf3'),
  ])

  const indexed = (fens, depth = 40) => ({
    query: (fen) =>
      fens.has(fenKey(fen))
        ? { lines: [{ multipv: 1, score: cp(20), pv: ['a2a3'] }], bestMove: 'a2a3', depth, knodes: 1 }
        : null,
  })

  it('does not search a position the index already holds', async () => {
    const engine = stubEngine()
    const withIndex = await run({ engine, explorer: BOOK, evalDb: indexed(ALL) })
    expect(withIndex.report.candidateSource).toEqual({ cloud: 4, local: 0 })

    const bare = stubEngine()
    const without = await run({ engine: bare, explorer: BOOK })
    expect(without.report.candidateSource).toEqual({ cloud: 0, local: 4 })
    // The index run must have done strictly less engine work for the same tree.
    expect(engine.searchCount()).toBeLessThan(bare.searchCount())
  })

  it('searches the ones it does not hold', async () => {
    const r = await run({
      engine: stubEngine(),
      explorer: BOOK,
      evalDb: indexed(new Set([at('d4 d5 c4 e6')])),
    })
    expect(r.report.candidateSource).toEqual({ cloud: 1, local: 3 })
  })

  it('searches rather than trusting an entry shallower than the gate accepts', async () => {
    const r = await run({ engine: stubEngine(), explorer: BOOK, evalDb: indexed(ALL, 5) })
    expect(r.report.candidateSource).toEqual({ cloud: 0, local: 4 })
  })
})

describe('crawl — the baseline candidates are measured against', () => {
  // `swing = bestWp - candidate`. Once candidates come from the index, leaving
  // the baseline on a shallower engine reading manufactures swing out of the
  // depth difference — and that swing feeds trap detection. Both sides of the
  // subtraction have to come from one source.
  const BOOK = stubBook({
    'd4 d5 c4': [{ san: 'e6', w: 300, d: 100, b: 300 }],
    'd4 d5 c4 e6': [{ san: 'Nc3', w: 400, d: 100, b: 300 }],
  })
  const at40 = (score) => ({
    query: () => ({ lines: [{ multipv: 1, score, pv: ['a2a3'] }], bestMove: 'a2a3', depth: 40, knodes: 1 }),
  })

  it('takes the baseline from the index when it is deep enough', async () => {
    const r = await run({ engine: stubEngine(), explorer: BOOK, evalDb: at40(cp(0)) })
    expect(r.report.bestSource.cloud).toBeGreaterThan(0)
    expect(r.report.bestSource.local).toBe(0)
  })

  it('falls back to the engine when the index is absent or shallow', async () => {
    const none = await run({ engine: stubEngine(), explorer: BOOK })
    expect(none.report.bestSource).toEqual({ cloud: 0, local: none.report.bestSource.local })
    expect(none.report.bestSource.local).toBeGreaterThan(0)

    const shallow = {
      query: () => ({ lines: [{ multipv: 1, score: cp(0), pv: ['a2a3'] }], bestMove: 'a2a3', depth: 5, knodes: 1 }),
    }
    const r = await run({ engine: stubEngine(), explorer: BOOK, evalDb: shallow })
    expect(r.report.bestSource.cloud).toBe(0)
  })

  it('leaves the quiet test entirely on the engine', async () => {
    // The tactic gap is relative, so deepening one side decalibrates it. An
    // index that disagrees wildly with the engine must not change quietness.
    const engineOnly = await run({ engine: stubEngine(), explorer: BOOK, minPly: 4, maxPly: 8 })
    const withIndex = await run({
      engine: stubEngine(),
      explorer: BOOK,
      evalDb: at40(cp(900)),
      minPly: 4,
      maxPly: 8,
    })
    expect(withIndex.report.terminal.quiet).toBe(engineOnly.report.terminal.quiet)
  })
})

describe('crawl — the shallow search is bought only when it can matter', () => {
  // quietness needs all three tests to pass, so where breadth or balance has
  // already failed a second reading can only add a reason, never remove one.
  // Skipping it there is lossless; the verdict must be identical either way.
  const BOOK = stubBook({
    'd4 d5 c4': [{ san: 'e6', w: 300, d: 100, b: 300 }],
    'd4 d5 c4 e6': [{ san: 'Nc3', w: 400, d: 100, b: 300 }],
  })

  it('skips it where the position is already decided', async () => {
    // Wildly imbalanced: balance fails on the deep reading alone.
    const r = await run({
      engine: stubEngine({ scores: { [at('d4 d5 c4 e6')]: 2000 } }),
      explorer: BOOK,
      minPly: 4,
      maxPly: 8,
      tacticGap: true,
    })
    expect(r.report.tacticGap.skipped).toBeGreaterThan(0)
  })

  it('buys it where breadth and balance both pass', async () => {
    // Opted in — the filter is off by default since ADR 0026.
    const r = await run({ engine: stubEngine(), explorer: BOOK, minPly: 4, maxPly: 8, tacticGap: true })
    expect(r.report.tacticGap.tested).toBeGreaterThan(0)
  })

  it('does fewer searches for the same tree', async () => {
    // The saving, stated as the thing that matters: identical crawl, fewer
    // engine calls. Losslessness itself rests on `quietness` needing all three
    // tests to pass, which the domain suite pins directly.
    const decided = stubEngine({ scores: { [at('d4 d5 c4 e6')]: 2000 } })
    const r = await run({ engine: decided, explorer: BOOK, minPly: 4, maxPly: 8, tacticGap: true })
    const assessed = r.report.tacticGap.tested + r.report.tacticGap.skipped
    expect(r.report.tacticGap.skipped).toBeGreaterThan(0)
    // Two searches per assessed position would be the old cost; we did fewer.
    expect(decided.searchCount()).toBeLessThan(2 * assessed + r.report.expanded)
  })
})

describe('crawl — the tactic gap is opt-in (ADR 0026)', () => {
  const BOOK = stubBook({
    'd4 d5 c4': [{ san: 'e6', w: 300, d: 100, b: 300 }],
    'd4 d5 c4 e6': [{ san: 'Nc3', w: 400, d: 100, b: 300 }],
  })

  it('buys no shallow search by default', async () => {
    const r = await run({ engine: stubEngine(), explorer: BOOK, minPly: 4, maxPly: 8 })
    expect(r.report.tacticGap.enabled).toBe(false)
    expect(r.report.tacticGap.tested).toBe(0)
  })

  it('does fewer searches than with the filter on, for the same tree', async () => {
    const off = stubEngine()
    const on = stubEngine()
    const a = await run({ engine: off, explorer: BOOK, minPly: 4, maxPly: 8 })
    const b = await run({ engine: on, explorer: BOOK, minPly: 4, maxPly: 8, tacticGap: true })
    expect(b.report.tacticGap.enabled).toBe(true)
    expect(b.report.tacticGap.tested).toBeGreaterThan(0)
    expect(off.searchCount()).toBeLessThan(on.searchCount())
    // Same tree either way — the filter never fired on this fixture.
    expect(a.nodes.size).toBe(b.nodes.size)
  })

  it('still decides against a position when it is switched on and the gap is real', async () => {
    // A stub whose shallow reading disagrees wildly: the filter must bite, or
    // re-enabling it at a low budget would be doing nothing.
    const jumpy = {
      async analyse(fen, { nodes = 0, multipv = 1 } = {}) {
        const legal = new Chess(fen).moves({ verbose: true })
        const base = nodes < 200_000 ? 900 : 0
        const lines = []
        for (let i = 0; i < Math.min(multipv, Math.max(1, legal.length)); i++) {
          lines.push({ multipv: i + 1, score: cp(base), pv: legal[i] ? [legal[i].lan] : [] })
        }
        return { lines, bestMove: lines[0]?.pv[0] ?? null, depth: 22 }
      },
      searchCount: () => 0,
    }
    const r = await run({ engine: jumpy, explorer: BOOK, minPly: 4, maxPly: 8, tacticGap: true })
    expect(r.report.tacticGap.decided).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// The command line (issue #115)
// ---------------------------------------------------------------------------
//
// This script is the most expensive one in the repo — a real run is hours of
// Stockfish — and until #115 it was the one that took any flag you gave it. The
// tests below are about the arguments, not the crawl: everything here decides
// whether an hour of engine time answers the question you asked.

describe('crawl.mjs rejects flags it does not know (#115)', () => {
  it('throws on a typo instead of crawling for hours at the default', () => {
    // `--nodez 4000000` crawled at the default budget and wrote a summary
    // indistinguishable from the one you wanted. build.mjs threw on the same
    // typo; the two entry points now share one parser and one answer.
    expect(() => parseArgs(['--nodez', '4000000'], FLAGS)).toThrow(/unknown option --nodez/)
  })

  it('names what it does accept, so the fix is in the error', () => {
    expect(() => parseArgs(['--nodez', '4000000'], FLAGS)).toThrow(/--nodes/)
  })

  it('accepts every flag build.mjs passes through to a crawl', () => {
    // build.mjs drives crawl() directly rather than shelling out, but the two
    // flag lists describe the same run and every shared name must parse here.
    const shared = BUILD_FLAGS.filter((f) => FLAGS.includes(f))
    expect(shared).toContain('trap')
    expect(shared).toContain('tactic-gap')
    for (const flag of shared) expect(() => parseArgs([`--${flag}`, 'x'], FLAGS)).not.toThrow()
  })

  it('rejects a bare argument rather than skipping it', () => {
    expect(() => parseArgs(['out/qga'], FLAGS)).toThrow(/unexpected argument/)
  })
})

describe('crawl.mjs --help says what crawl.mjs accepts (#115)', () => {
  it('documents every flag it accepts', () => {
    // `--tactic-gap` was read at crawl.mjs:912 and appeared in no help text.
    expect(flagsNamedIn(HELP)).toEqual([...FLAGS].sort())
  })

  it('accepts every flag it documents', () => {
    // The failure this fix must not introduce: a flag in --help that the
    // parser has never heard of turns a correct invocation into a hard error.
    for (const flag of flagsNamedIn(HELP)) {
      expect(() => parseArgs([`--${flag}`, 'x'], FLAGS)).not.toThrow()
    }
  })

  it('quotes the defaults from the constants, so they cannot drift', () => {
    expect(HELP).toContain(`--min-ply ${DEFAULTS.minPly}`)
    expect(HELP).toContain(`--max-ply ${DEFAULTS.maxPly}`)
    expect(HELP).toContain(`--trap    ${DEFAULTS.trapThreshold}`)
    // ADR 0024's index is median depth 34–50; both help texts said 50 alone.
    expect(HELP).not.toMatch(/median depth 50/)
  })
})

describe('crawlOptions — a numeric flag with its value dropped (#115)', () => {
  it('reads a number', () => {
    expect(crawlOptions({ trap: '0.01' }).trapThreshold).toBe(0.01)
    expect(crawlOptions({ nodes: '4000000' }).deepNodes).toBe(4_000_000)
  })

  it('rejects a bare --trap rather than crawling at a threshold of 1', () => {
    // parseArgs marks a valueless flag `true` and Number(true) is 1 — a
    // threshold 100× the intended 0.01, which reports no traps at all and
    // looks exactly like a clean run.
    expect(() => crawlOptions({ trap: true })).toThrow(/--trap needs a number/)
  })

  it('still means zero when you ask for zero', () => {
    // argv values arrive as strings, so `--trap 0` is '0' — truthy, and 0 is
    // what it means. An earlier draft of #115 called this a bug; it is not,
    // and a refactor must not "fix" it into the default.
    expect(crawlOptions({ trap: '0' })).toEqual({ trapThreshold: 0 })
  })

  it('rejects every other numeric flag given no value', () => {
    for (const [flag, option] of [
      ['max-ply', 'maxPly'],
      ['min-ply', 'minPly'],
      ['nodes', 'deepNodes'],
      ['mass', 'massTarget'],
      ['max-eval', 'maxEvalPerNode'],
      ['min-node-games', 'minNodeGames'],
      ['max-replies', 'maxOpponentMoves'],
    ]) {
      expect(() => crawlOptions({ [flag]: true })).toThrow(new RegExp(`--${flag} needs a number`))
      expect(crawlOptions({ [flag]: '7' })).toEqual({ [option]: 7 })
    }
  })

  it('rejects a value that is not a number', () => {
    expect(() => crawlOptions({ nodes: 'four million' })).toThrow(/--nodes needs a number/)
  })

  it('leaves a flag out entirely rather than passing undefined', async () => {
    // crawl() merges with `{ ...DEFAULTS, ...config }`, and a spread overwrites
    // with an explicit undefined instead of skipping it. Passing the whole set
    // unconditionally — which this script did — meant a plain run had no depth
    // cap, no floor, no minNodeGames and no trap threshold: an unbounded crawl
    // that terminated nothing, reported as a successful one.
    expect(crawlOptions({})).toEqual({})
    expect(Object.keys(crawlOptions({}))).toHaveLength(0)

    // Not through `run`, which sets its own depths — the point is what reaches
    // crawl() when the command line said nothing at all.
    const r = await crawl({
      ourColor: 'w',
      forcedLine: ['d4', 'd5', 'c4'],
      engine: stubEngine(),
      explorer: stubBook(TRAP_BOOK),
      ...crawlOptions({}),
    })
    expect(r.options.maxPly).toBe(DEFAULTS.maxPly)
    expect(r.options.minPly).toBe(DEFAULTS.minPly)
    expect(r.options.trapThreshold).toBe(DEFAULTS.trapThreshold)
    expect(r.options.minNodeGames).toBe(DEFAULTS.minNodeGames)
  })

  it('turns the tactic gap on only when asked', () => {
    expect(crawlOptions({})).not.toHaveProperty('tacticGap')
    expect(crawlOptions({ 'tactic-gap': true })).toEqual({ tacticGap: true })
  })
})

describe('ratingBuckets — the explorer buckets, not a range', () => {
  it('reads a comma-separated list', () => {
    expect(ratingBuckets({ ratings: '1600,1800' })).toEqual([1600, 1800])
  })

  it('is undefined when absent, so the API default stands', () => {
    expect(ratingBuckets({})).toBeUndefined()
  })

  it("rejects buildBook.mjs's range syntax rather than asking for bucket NaN", () => {
    expect(() => ratingBuckets({ ratings: '1600-1800' })).toThrow(/comma-separated buckets/)
  })

  it('rejects a bare --ratings', () => {
    expect(() => ratingBuckets({ ratings: true })).toThrow(/--ratings needs a value/)
  })
})
