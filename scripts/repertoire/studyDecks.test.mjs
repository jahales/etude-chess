import { describe, it, expect } from 'vitest'
import {
  assignTiers,
  confirmedTraps,
  mergeByRoot,
  mergeGames,
  prunePgn,
  tierNames,
  trapRefutations,
} from './studyDecks.mjs'
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

  // Pinned lines enter tier 0 over budget, deliberately. What must not happen is
  // the overflow being handed back as free space: `used` was reset to the
  // nominal boundary on each advance, so six pins under `--sizes 3,5` produced
  // tiers of 6/2/2 — eight decisions inside a cumulative budget of five.
  it('carries a pin overflow into the later budgets instead of forgiving it', () => {
    const rows = Array.from({ length: 10 }, (_, i) => row(`m${i}`, 10 - i))
    const pin = new Set(['m0', 'm1', 'm2', 'm3', 'm4', 'm5'])
    const tier = assignTiers(rows, [3, 5], pin)
    const upTo = (n) => [...tier].filter(([, t]) => t <= n).length
    expect(upTo(0)).toBe(6)
    // Tier 0 alone already exceeds the cumulative budget of 5, so tier 1 has
    // nothing to give and everything else belongs to the unbounded last tier.
    expect(upTo(1)).toBe(6)
    expect(upTo(2)).toBe(10)
  })

  it('still fills tiers normally when nothing is pinned', () => {
    const rows = Array.from({ length: 10 }, (_, i) => row(`m${i}`, 10 - i))
    const tier = assignTiers(rows, [3, 5])
    expect([...tier].filter(([, t]) => t <= 0).length).toBe(3)
    expect([...tier].filter(([, t]) => t <= 1).length).toBe(5)
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

  // Grafting is only safe because branch ownership guarantees no two branches
  // answer one position differently. That guarantee was asserted in the
  // docstring and never checked: `conflicts` was returned always empty, so a
  // violation produced a deck offering two answers and said nothing.
  it('reports two branches prescribing different moves in one position', () => {
    const { conflicts } = mergeGames(
      parse(H('white') + '1. d4 d5 2. c4 *\n' + H('white') + '1. d4 d5 2. Nf3 *\n'),
      'w',
    )
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]).toMatchObject({ line: 'd4 d5', a: 'c4', b: 'Nf3' })
  })

  it('does not mistake the opponent\'s alternatives for a conflict', () => {
    // Two replies to 1.d4 is the repertoire doing its job — we answer both.
    const { conflicts } = mergeGames(
      parse(H('white') + '1. d4 d5 *\n' + H('white') + '1. d4 Nf6 *\n'),
      'w',
    )
    expect(conflicts).toEqual([])
  })

  it('reads the parity from the deck\'s own colour', () => {
    // In a Black deck the root holds White's first moves, so ours are one ply
    // deeper — the same tree shape means the opposite thing.
    const black = parse(H('black') + '1. e4 c6 *\n' + H('black') + '1. e4 e5 *\n')
    expect(mergeGames(black, 'b').conflicts).toHaveLength(1)
    expect(mergeGames(black, 'w').conflicts).toEqual([])
  })

  it('does not flag the two first moves a White deck deliberately holds', () => {
    // 1.d4 and 1.e4 are alternatives you choose between at the board, so the
    // White deck ships both. Flagging it would fire on every run (issue #114).
    const { conflicts } = mergeGames(parse(H('white') + '1. d4 *\n' + H('white') + '1. e4 *\n'), 'w')
    expect(conflicts).toEqual([])
  })

  it('skips the check rather than guessing when no orientation is given', () => {
    const { conflicts } = mergeGames(parse(H('white') + '1. d4 d5 2. c4 *\n' + H('white') + '1. d4 d5 2. Nf3 *\n'))
    expect(conflicts).toEqual([])
  })
})

describe('mergeByRoot', () => {
  const headers = new Map([['Event', 'deck'], ['Orientation', 'white'], ['Result', '*']])

  it('emits one game per opening move', () => {
    const text =
      '[Event "a"]\n[Orientation "white"]\n[Result "*"]\n\n1. d4 d5 *\n\n' +
      '[Event "b"]\n[Orientation "white"]\n[Result "*"]\n\n1. d4 Nf6 *\n\n' +
      '[Event "c"]\n[Orientation "white"]\n[Result "*"]\n\n1. e4 e5 *\n'
    const { pgn } = mergeByRoot(text, headers)
    expect((pgn.match(/\[Event /g) ?? [])).toHaveLength(2)
    expect(pgn).toMatch(/1\.d4/)
    expect(pgn).toMatch(/1\.e4/)
  })

  it('round-trips through the reader with every line intact', () => {
    const text =
      '[Event "a"]\n[Orientation "white"]\n[Result "*"]\n\n1. d4 d5 2. c4 e6 *\n\n' +
      '[Event "b"]\n[Orientation "white"]\n[Result "*"]\n\n1. d4 Nf6 2. c4 g6 *\n'
    const lines = [...walkRepertoire(mergeByRoot(text, headers).pgn)].map((n) => n.line.join(' '))
    for (const want of ['d4 d5 c4 e6', 'd4 Nf6 c4 g6']) expect(lines).toContain(want)
  })

  it('passes a conflict up to the caller', () => {
    const text =
      '[Event "a"]\n[Orientation "white"]\n[Result "*"]\n\n1. d4 d5 2. c4 *\n\n' +
      '[Event "b"]\n[Orientation "white"]\n[Result "*"]\n\n1. d4 d5 2. Nf3 *\n'
    expect(mergeByRoot(text, headers, 'w').conflicts).toHaveLength(1)
  })
})

describe('tierNames', () => {
  it('always ends at complete, so the whole repertoire is never called something else', () => {
    for (const n of [1, 2, 3, 5]) expect(tierNames(n).at(-1)).toBe('complete')
  })

  it('drops the core label when there are only two tiers', () => {
    // Labelling a two-way split core/standard would leave the *complete*
    // repertoire named "standard" — the names are what you pick at drilling
    // time, so they have to mean what they say.
    expect(tierNames(2)).toEqual(['standard', 'complete'])
    expect(tierNames(3)).toEqual(['core', 'standard', 'complete'])
  })

  it('gives one name per tier', () => {
    for (const n of [1, 2, 3, 4, 6]) expect(tierNames(n)).toHaveLength(n)
  })
})

describe('confirmed traps in the decks', () => {
  it('takes only the replicated list, not everything the crawl flagged', () => {
    const reps = [
      { confirmed: [{ line: 'd4 e5 dxe5' }], shaky: [{ line: 'x' }], unseen: [{ line: 'y' }] },
      { confirmed: [{ line: 'e4 d5 exd5' }] },
    ]
    expect([...confirmedTraps(reps)].sort()).toEqual(['d4 e5 dxe5', 'e4 d5 exd5'])
  })

  it('pins the reply to a trap, since the trap itself is never a decision', () => {
    // A trap is the opponent's move, so it never ranks. Our refutation is the
    // ply after it, and without pinning it the whole subtree is pruned away —
    // the standard White deck had 2 trap comments out of 282 confirmed.
    const ranked = [
      { line: 'd4', value: 5 },
      { line: 'd4 e5 dxe5', value: 0.01 },
      { line: 'd4 e5 dxe5 f6 e4', value: 0.001 },
    ]
    const pinned = trapRefutations(ranked, new Set(['d4 e5']))
    expect(pinned.get('d4 e5 dxe5')).toBe('d4 e5')
  })

  it('measures depth in plies, not characters', () => {
    // The immediate reply has a long SAN and the deeper continuation two short
    // ones, so by string length `d4 e5 dxe5 f6 e4` (16) beats `d4 e5 Qxd8+`
    // (11)... but by plies the reply wins, which is the whole point. Ranking by
    // characters pins a continuation and leaves the refutation itself unpinned,
    // free to be pruned out of the first tier.
    const ranked = [
      { line: 'd4 e5 Qxd8+', value: 0.01 },
      { line: 'd4 e5 dxe5 f6 e4', value: 0.02 },
    ]
    const pinned = trapRefutations(ranked, new Set(['d4 e5']))
    expect([...pinned.keys()]).toEqual(['d4 e5 Qxd8+'])
  })

  it('puts a pinned line in the first tier however badly it ranks', () => {
    const ranked = [
      { line: 'e4', value: 9 },
      { line: 'd4', value: 8 },
      { line: 'd4 e5 dxe5', value: 0.0001 },
    ]
    const tier = assignTiers(ranked, [1], new Set(['d4 e5 dxe5']))
    expect(tier.get('d4 e5 dxe5')).toBe(0)
    expect(tier.get('d4')).toBe(0) // its ancestry comes with it
  })

  it('downgrades a trap label the second month did not confirm', () => {
    const pgn =
      '[Event "t"]\n[Orientation "white"]\n[Result "*"]\n\n' +
      '1. d4 e5 { [%eval 0.8] · trap · 5% play this · n=900 } 2. dxe5 *\n'
    const out = prunePgn(pgn, new Set(['d4', 'd4 e5 dxe5']), new Set(['nothing matches']))
    expect(out).toContain('one month only')
    expect(out).not.toContain('· trap ·')
  })

  it('leaves a confirmed trap label alone', () => {
    const pgn =
      '[Event "t"]\n[Orientation "white"]\n[Result "*"]\n\n' +
      '1. d4 e5 { [%eval 0.8] · trap · 5% play this · n=900 } 2. dxe5 *\n'
    const out = prunePgn(pgn, new Set(['d4', 'd4 e5 dxe5']), new Set(['d4 e5']))
    expect(out).toContain('· trap ·')
    expect(out).not.toContain('one month only')
  })
})
