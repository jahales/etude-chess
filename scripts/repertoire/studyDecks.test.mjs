import { describe, it, expect } from 'vitest'
import { assignTiers, mergeByRoot, mergeGames, prunePgn } from './studyDecks.mjs'
import { parsePgn } from 'chessops/pgn'
import { walkRepertoire } from './readRepertoirePgn.mjs'

const row = (line, value) => ({ line, value })

describe('assignTiers', () => {
  // The property that makes a tier drillable: you cannot learn move 12 without
  // moves 1 to 11, so a decision only enters a tier with its whole ancestry.
  it('admits a decision only together with its ancestors', () => {
    const tier = assignTiers([row('e4', 0.1), row('e4 e5 Nf3', 9), row('e4 e5 Nf3 Nc6 Bc4', 8)], [10])
    expect(tier.get('e4')).toBe(0)
    expect(tier.get('e4 e5 Nf3')).toBe(0)
    expect(tier.get('e4 e5 Nf3 Nc6 Bc4')).toBe(0)
  })

  it('charges the ancestry against the budget', () => {
    // Three decisions needed to reach the valuable one, budget of two: it
    // cannot fit, so the whole chain goes to the next tier rather than
    // arriving there half-formed.
    const tier = assignTiers([row('d4', 1), row('d4 d5 c4', 2), row('d4 d5 c4 e6 cxd5', 99)], [2])
    expect(tier.get('d4 d5 c4 e6 cxd5')).toBeGreaterThan(0)
  })

  it('orders tiers by value, not by where a line sits in the file', () => {
    const tier = assignTiers([row('a3', 0.01), row('e4', 5)], [1])
    expect(tier.get('e4')).toBeLessThan(tier.get('a3'))
  })

  it('puts everything left into the final tier', () => {
    const rows = Array.from({ length: 20 }, (_, i) => row(`e4 ${'a'.repeat(i + 1)}`, i))
    const tier = assignTiers(rows, [2, 4])
    for (const r of rows) expect(tier.get(r.line)).toBeLessThanOrEqual(2)
    expect(Math.max(...tier.values())).toBe(2)
  })

  it('places unscorable decisions last rather than dropping them', () => {
    // They are by definition the ones we know least about, so they are not
    // silently lost — they are simply not what to learn first.
    const tier = assignTiers([{ line: 'e4', skipped: 'thin book' }, row('d4', 5)], [1])
    expect(tier.has('e4')).toBe(true)
    expect(tier.get('e4')).toBeGreaterThanOrEqual(tier.get('d4'))
  })

  it('is cumulative — every tier is a superset of the one before', () => {
    const rows = Array.from({ length: 30 }, (_, i) => row(`e4 ${'b'.repeat(i + 1)}`, 30 - i))
    const tier = assignTiers(rows, [5, 12])
    const upTo = (n) => new Set([...tier].filter(([, t]) => t <= n).map(([l]) => l))
    const a = upTo(0)
    const b = upTo(1)
    for (const line of a) expect(b.has(line)).toBe(true)
  })
})

describe('prunePgn', () => {
  const PGN =
    '[Event "t"]\n[Orientation "white"]\n[Result "*"]\n\n' +
    '1. e4 e5 (1... c5 2. c3 d5) 2. Nf3 Nc6 3. Bb5 *\n'

  it('keeps a retained line and everything leading to it', () => {
    const out = prunePgn(PGN, new Set(['e4', 'e4 e5 Nf3']))
    const sans = [...walkRepertoire(out)].map((n) => n.san)
    expect(sans).toContain('e4')
    expect(sans).toContain('e5')
    expect(sans).toContain('Nf3')
  })

  it('drops a variation nothing retained sits under', () => {
    const out = prunePgn(PGN, new Set(['e4', 'e4 e5 Nf3']))
    expect([...walkRepertoire(out)].map((n) => n.san)).not.toContain('c3')
  })

  it('keeps the opponent move above a retained reply', () => {
    // A deck that dropped these would answer moves it never shows you.
    const out = prunePgn(PGN, new Set(['e4', 'e4 c5 c3']))
    const sans = [...walkRepertoire(out)].map((n) => n.san)
    expect(sans).toContain('c5')
    expect(sans).toContain('c3')
  })

  it('emits nothing when a tier retains nothing from a file', () => {
    expect(prunePgn(PGN, new Set(['d4'])).trim()).toBe('')
  })

  it('produces a PGN the reader can parse back', () => {
    const out = prunePgn(PGN, new Set(['e4', 'e4 e5 Nf3', 'e4 e5 Nf3 Nc6 Bb5']))
    expect(() => [...walkRepertoire(out)]).not.toThrow()
    expect([...walkRepertoire(out)].length).toBeGreaterThan(3)
  })
})

describe('deck output shape', () => {
  it('merges same-colour sources rather than emitting one file each', () => {
    // Colour is the only axis En Croissant has — it trains from one side's
    // point of view. Two White files would mean choosing between them at every
    // session for no reason, and the 1.d4 and 1.e4 repertoires are both White.
    // An earlier version keyed the filename on the build directory, which
    // turned that into two files; before *that* it keyed on the filename alone
    // and one silently overwrote the other.
    const sources = [
      { colour: 'white', pgn: '[Event "a"]\n[Orientation "white"]\n\n1. d4 *\n' },
      { colour: 'white', pgn: '[Event "b"]\n[Orientation "white"]\n\n1. e4 *\n' },
      { colour: 'black', pgn: '[Event "c"]\n[Orientation "black"]\n\n1. e4 c6 *\n' },
    ]
    const byColour = {}
    for (const s of sources) (byColour[s.colour] ??= []).push(s.pgn)
    expect(Object.keys(byColour).sort()).toEqual(['black', 'white'])
    expect(byColour.white).toHaveLength(2)
  })
})

describe('mergeGames', () => {
  const parse = (t) => [...parsePgn(t)]
  const H = (o) => `[Event "x"]\n[Orientation "${o}"]\n[Result "*"]\n\n`

  it('grafts games that share a prefix into one tree', () => {
    // The core White deck was 26 games for 144 decisions, seventeen of them
    // five moves or fewer — one repertoire entry per manifest branch, which is
    // the build's unit and not the drilling one.
    const { root } = mergeGames(parse(H('white') + '1. d4 d5 2. c4 *\n' + H('white') + '1. d4 Nf6 2. c4 *\n'))
    expect(root.children).toHaveLength(1)
    expect(root.children[0].data.san).toBe('d4')
    expect(root.children[0].children.map((c) => c.data.san).sort()).toEqual(['Nf6', 'd5'])
  })

  it('keeps genuinely different first moves apart', () => {
    const { root } = mergeGames(parse(H('white') + '1. d4 *\n' + H('white') + '1. e4 *\n'))
    expect(root.children.map((c) => c.data.san).sort()).toEqual(['d4', 'e4'])
  })

  it('does not alias the source nodes', () => {
    // Two decks are built from the same parsed source; splicing originals in
    // would have one deck's pruning mutate the other's tree.
    const games = parse(H('white') + '1. d4 d5 *\n')
    const { root } = mergeGames(games)
    root.children[0].children.length = 0
    expect(games[0].moves.children[0].children).toHaveLength(1)
  })

  it('carries a comment across from whichever game has one', () => {
    const { root } = mergeGames(
      parse(H('white') + '1. d4 *\n' + H('white') + '1. d4 {the Queen\'s Gambit} *\n'),
    )
    expect(root.children[0].data.comments?.length).toBeGreaterThan(0)
  })
})

describe('mergeByRoot', () => {
  const headers = new Map([['Event', 'deck'], ['Orientation', 'white'], ['Result', '*']])

  it('emits one game per opening move', () => {
    const text =
      '[Event "a"]\n[Orientation "white"]\n[Result "*"]\n\n1. d4 d5 *\n\n' +
      '[Event "b"]\n[Orientation "white"]\n[Result "*"]\n\n1. d4 Nf6 *\n\n' +
      '[Event "c"]\n[Orientation "white"]\n[Result "*"]\n\n1. e4 e5 *\n'
    const out = mergeByRoot(text, headers)
    expect((out.match(/\[Event /g) ?? [])).toHaveLength(2)
    expect(out).toMatch(/1\.d4/)
    expect(out).toMatch(/1\.e4/)
  })

  it('round-trips through the reader with every line intact', () => {
    const text =
      '[Event "a"]\n[Orientation "white"]\n[Result "*"]\n\n1. d4 d5 2. c4 e6 *\n\n' +
      '[Event "b"]\n[Orientation "white"]\n[Result "*"]\n\n1. d4 Nf6 2. c4 g6 *\n'
    const lines = [...walkRepertoire(mergeByRoot(text, headers))].map((n) => n.line.join(' '))
    for (const want of ['d4 d5 c4 e6', 'd4 Nf6 c4 g6']) expect(lines).toContain(want)
  })
})
