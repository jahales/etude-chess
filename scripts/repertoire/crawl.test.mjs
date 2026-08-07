import { describe, it, expect } from 'vitest'
import { Chess } from 'chess.js'
import { fenKey } from '../../src/domain/repertoirePgn.ts'
import { crawl } from './crawl.mjs'

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
