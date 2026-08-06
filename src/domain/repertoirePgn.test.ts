import { describe, it, expect } from 'vitest'
import { fenKey, toPgn, type RepertoireNode } from './repertoirePgn'

// Real FENs, so the fenKey plumbing is exercised rather than stubbed.
const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
const AFTER_D4 = 'rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq - 0 1'
const AFTER_D5 = 'rnbqkbnr/ppp1pppp/8/3p4/3P4/8/PPP1PPPP/RNBQKBNR w KQkq - 0 2'
const AFTER_NF6 = 'rnbqkb1r/pppppppp/5n2/8/3P4/8/PPP1PPPP/RNBQKBNR w KQkq - 1 2'

const node = (children: RepertoireNode['children'], rest: Partial<RepertoireNode> = {}) =>
  ({ children, ...rest }) as RepertoireNode

const base = { forcedSans: [], ourColor: 'w' as const, date: '2026-08-05' }

describe('fenKey', () => {
  it('ignores clocks so transpositions collapse to one node', () => {
    expect(fenKey('8/8/8/8/8/8/8/K6k w - - 4 30')).toBe(fenKey('8/8/8/8/8/8/8/K6k w - - 0 1'))
  })
})

describe('toPgn', () => {
  it('numbers a simple main line', () => {
    const nodes = new Map([
      [fenKey(START), node([{ san: 'd4', fen: AFTER_D4, reason: 'ours' }])],
      [fenKey(AFTER_D4), node([{ san: 'd5', fen: AFTER_D5, reason: 'mass' }])],
    ])
    const pgn = toPgn({ ...base, nodes, rootFen: START })
    expect(pgn).toContain('1. d4 d5')
  })

  it('parenthesises alternatives and restates the number after them', () => {
    const nodes = new Map([
      [fenKey(START), node([{ san: 'd4', fen: AFTER_D4, reason: 'ours' }])],
      [
        fenKey(AFTER_D4),
        node([
          { san: 'd5', fen: AFTER_D5, reason: 'mass' },
          { san: 'Nf6', fen: AFTER_NF6, reason: 'mass' },
        ]),
      ],
    ])
    const pgn = toPgn({ ...base, nodes, rootFen: START })
    expect(pgn).toContain('1. d4 d5 (1... Nf6)')
  })

  it('annotates an opponent move by how much it gives up', () => {
    const nodes = new Map([
      [fenKey(START), node([{ san: 'd4', fen: AFTER_D4, reason: 'ours' }])],
      [
        fenKey(AFTER_D4),
        node([
          { san: 'd5', fen: AFTER_D5, reason: 'mass', swing: 2 },
          { san: 'Nf6', fen: AFTER_NF6, reason: 'trap', swing: 30 },
        ]),
      ],
    ])
    const pgn = toPgn({ ...base, nodes, rootFen: START })
    expect(pgn).toContain('d5') // sound: no suffix
    expect(pgn).not.toContain('d5?')
    expect(pgn).toContain('Nf6??')
    expect(pgn).toContain('{trap')
  })

  it('states the facts behind a trap, not just the label', () => {
    // What decides whether a line is worth your evening is how often you meet
    // it and how much score you leak — not the word "trap".
    const nodes = new Map([
      [fenKey(START), node([{ san: 'd4', fen: AFTER_D4, reason: 'ours' }])],
      [
        fenKey(AFTER_D4),
        node([
          {
            san: 'Nf6',
            fen: AFTER_NF6,
            reason: 'trap',
            swing: 12,
            frequency: 0.048,
            practical: 0.45,
            expected: 0.33,
            games: 627,
            punished: true,
          },
        ]),
      ],
    ])
    const pgn = toPgn({ ...base, nodes, rootFen: START })
    expect(pgn).toContain('5% play this')
    expect(pgn).toContain('they score 45% where 33% is deserved')
    expect(pgn).toContain('n=627')
  })

  it('warns when a trap’s punishment never materialised', () => {
    // Drilling this as a win and reaching an equal game is worse than not
    // knowing the line at all.
    const nodes = new Map([
      [fenKey(START), node([{ san: 'd4', fen: AFTER_D4, reason: 'ours' }])],
      [
        fenKey(AFTER_D4),
        node([
          {
            san: 'Nf6',
            fen: AFTER_NF6,
            reason: 'trap',
            swing: 12,
            games: 200,
            punished: false,
            afterReplyWinPercent: 52,
          },
        ]),
      ],
    ])
    const pgn = toPgn({ ...base, nodes, rootFen: START })
    expect(pgn).toContain('WARNING: punishment unconfirmed')
    expect(pgn).toContain('only 52% after our reply')
  })

  it('emits [%eval] so the trainer can graph the line', () => {
    const nodes = new Map([
      [fenKey(START), node([{ san: 'd4', fen: AFTER_D4, reason: 'ours', evalCp: 24 }])],
      [fenKey(AFTER_D4), node([{ san: 'd5', fen: AFTER_D5, reason: 'mass', evalCp: -137 }])],
    ])
    const pgn = toPgn({ ...base, nodes, rootFen: START })
    expect(pgn).toContain('[%eval 0.24]')
    expect(pgn).toContain('[%eval -1.37]')
  })

  it('records how the evaluations were produced', () => {
    // An evaluation without its conditions cannot be trusted: multithreaded
    // Stockfish at a fixed node count is not reproducible.
    const nodes = new Map([[fenKey(START), node([])]])
    const pgn = toPgn({
      ...base,
      nodes,
      rootFen: START,
      provenance: { engine: 'Stockfish 17', nodes: 120000, threads: 1, minDepth: 18 },
    })
    expect(pgn).toContain('[Engine "Stockfish 17"]')
    expect(pgn).toContain('[EngineNodes "120000"]')
    expect(pgn).toContain('[EngineThreads "1"]')
    expect(pgn).toContain('[Reproducible "yes"]')
    expect(pgn).toContain('[MinDepth "18"]')
  })

  it('says outright when the numbers are not reproducible', () => {
    const nodes = new Map([[fenKey(START), node([])]])
    const pgn = toPgn({ ...base, nodes, rootFen: START, provenance: { threads: 8 } })
    expect(pgn).toContain('[Reproducible "no — multithreaded search"]')
  })

  it('never annotates our own moves', () => {
    const nodes = new Map([
      [fenKey(START), node([{ san: 'd4', fen: AFTER_D4, reason: 'ours', swing: 40 }])],
    ])
    expect(toPgn({ ...base, nodes, rootFen: START })).not.toContain('d4?')
  })

  it('marks a refutation the explorer was too sparse to supply', () => {
    // After a trap, the punishing move is often unplayed in human games, so the
    // crawler falls back to the engine. The PGN should say so rather than imply
    // it came from human play.
    const nodes = new Map([
      [fenKey(START), node([{ san: 'd4', fen: AFTER_D4, reason: 'ours-engine', swing: 0 }])],
    ])
    const pgn = toPgn({ ...base, nodes, rootFen: START })
    expect(pgn).toContain('1. d4')
    expect(pgn).not.toContain('d4?')
    expect(pgn).toContain('{engine refutation — too rare to appear in human play}')
  })

  it('flags where our move leaves master theory behind', () => {
    const nodes = new Map([
      [fenKey(START), node([{ san: 'd4', fen: AFTER_D4, reason: 'ours', source: 'band' }])],
      [fenKey(AFTER_D4), node([{ san: 'd5', fen: AFTER_D5, reason: 'mass' }])],
    ])
    expect(toPgn({ ...base, nodes, rootFen: START })).toContain(
      '{beyond master theory — chosen from club play}',
    )
  })

  it('stays silent while our move is still backed by master practice', () => {
    const nodes = new Map([
      [fenKey(START), node([{ san: 'd4', fen: AFTER_D4, reason: 'ours', source: 'canon' }])],
    ])
    expect(toPgn({ ...base, nodes, rootFen: START })).not.toContain('beyond master theory')
  })

  it('says nothing about sourcing when no canonical book was configured', () => {
    const nodes = new Map([
      [fenKey(START), node([{ san: 'd4', fen: AFTER_D4, reason: 'ours' }])],
    ])
    expect(toPgn({ ...base, nodes, rootFen: START })).not.toContain('master theory')
  })

  it('reports a dead end distinctly from running out of book', () => {
    const nodes = new Map([
      [fenKey(START), node([{ san: 'd4', fen: AFTER_D4, reason: 'ours' }])],
      [fenKey(AFTER_D4), node([], { terminal: true, terminalReason: 'no-sound-move' })],
    ])
    expect(toPgn({ ...base, nodes, rootFen: START })).toContain('{no sound continuation found}')
  })

  it('comments a quiet terminal so the trainer shows where judgment starts', () => {
    const nodes = new Map([
      [fenKey(START), node([{ san: 'd4', fen: AFTER_D4, reason: 'ours' }])],
      [fenKey(AFTER_D4), node([], { terminal: true, terminalReason: 'quiet', quiet: { breadth: 4 } })],
    ])
    const pgn = toPgn({ ...base, nodes, rootFen: START })
    expect(pgn).toContain('{quiet: 4 playable moves — judgment from here}')
  })

  it('distinguishes the other two terminal reasons', () => {
    const cap = new Map([
      [fenKey(START), node([{ san: 'd4', fen: AFTER_D4, reason: 'ours' }])],
      [fenKey(AFTER_D4), node([], { terminal: true, terminalReason: 'depth-cap' })],
    ])
    expect(toPgn({ ...base, nodes: cap, rootFen: START })).toContain('{depth cap}')

    const book = new Map([
      [fenKey(START), node([{ san: 'd4', fen: AFTER_D4, reason: 'ours' }])],
      [fenKey(AFTER_D4), node([], { terminal: true, terminalReason: 'out-of-book', games: 7 })],
    ])
    expect(toPgn({ ...base, nodes: book, rootFen: START })).toContain('{out of book (7 games)}')
  })

  it('replays the curated prefix before the crawled tree', () => {
    const nodes = new Map([[fenKey(AFTER_D5), node([])]])
    const pgn = toPgn({
      ...base,
      nodes,
      rootFen: AFTER_D5,
      forcedSans: ['d4', 'd5'],
    })
    expect(pgn).toContain('1. d4 d5')
    expect(pgn).toContain('[Opening "d4 d5"]')
  })

  it('writes headers naming the side the repertoire is for', () => {
    const nodes = new Map([[fenKey(START), node([])]])
    const asBlack = toPgn({ ...base, ourColor: 'b', nodes, rootFen: START })
    expect(asBlack).toContain('[Event "Repertoire — Black"]')
    expect(asBlack).toContain('[Black "Repertoire"]')
    expect(asBlack).toContain('[Date "2026.08.05"]')
    expect(asBlack.trimEnd().endsWith('*')).toBe(true)
  })

  it('survives a tree whose root is unknown', () => {
    expect(() => toPgn({ ...base, nodes: new Map(), rootFen: START })).not.toThrow()
  })
})

describe('toPgn — branches another crawl owns', () => {
  const delegatedTree = () =>
    new Map([
      [fenKey(START), node([{ san: 'd4', fen: AFTER_D4, reason: 'ours' as const }])],
      [
        fenKey(AFTER_D4),
        node([
          { san: 'd5', fen: AFTER_D5, reason: 'mass' as const, delegatedTo: 'queens-gambit' },
          { san: 'Nf6', fen: AFTER_NF6, reason: 'mass' as const },
        ]),
      ],
      [
        fenKey(AFTER_D5),
        node([], { terminal: true, terminalReason: 'delegated', delegatedTo: 'queens-gambit' }),
      ],
      [fenKey(AFTER_NF6), node([], { terminal: true, terminalReason: 'quiet', quiet: { breadth: 4 } })],
    ])

  it('says which branch covers a position it stopped at', () => {
    expect(toPgn({ ...base, nodes: delegatedTree(), rootFen: START })).toContain(
      'covered in the "queens-gambit" line',
    )
  })

  it('takes the main line through content this game actually has', () => {
    // Following the most popular reply into a subtree that lives elsewhere would
    // make the main line a single pointer and bury everything crawled here in a
    // variation — unusable as a drill.
    const pgn = toPgn({ ...base, nodes: delegatedTree(), rootFen: START })
    expect(pgn).toContain('1. d4 Nf6')
    expect(pgn).toContain('(1... d5')
  })

  it('still follows the most popular reply when nothing is delegated', () => {
    const nodes = delegatedTree()
    nodes.get(fenKey(AFTER_D4))!.children[0]!.delegatedTo = undefined
    expect(toPgn({ ...base, nodes, rootFen: START })).toContain('1. d4 d5')
  })

  it('falls back to the first child when every reply is delegated', () => {
    const nodes = delegatedTree()
    nodes.get(fenKey(AFTER_D4))!.children[1]!.delegatedTo = 'elsewhere'
    expect(toPgn({ ...base, nodes, rootFen: START })).toContain('1. d4 d5')
  })

  it('points a delegated trap at the branch that covers it, not at a warning', () => {
    // `punished` is undefined here because this crawl never checked — the owning
    // branch did. Printing "punishment not verified" over a line that has in
    // fact been verified trains you to ignore the warning that matters.
    const nodes = new Map([
      [fenKey(START), node([{ san: 'd4', fen: AFTER_D4, reason: 'ours' as const }])],
      [
        fenKey(AFTER_D4),
        node([
          {
            san: 'd5',
            fen: AFTER_D5,
            reason: 'trap' as const,
            frequency: 0.04,
            practical: 0.51,
            expected: 0.42,
            games: 511,
            delegatedTo: 'albin',
          },
        ]),
      ],
      [fenKey(AFTER_D5), node([], { terminal: true, terminalReason: 'delegated', delegatedTo: 'albin' })],
    ])
    const pgn = toPgn({ ...base, nodes, rootFen: START })
    expect(pgn).toContain('covered in the "albin" line')
    expect(pgn).not.toContain('not verified')
    // and the trap's own numbers survive alongside it
    expect(pgn).toContain('they score 51% where 42% is deserved')
  })

  it('says where a move is covered exactly once', () => {
    // The move's comment and the position after it both used to announce the
    // same delegation, which reads as two different facts.
    const pgn = toPgn({ ...base, nodes: delegatedTree(), rootFen: START })
    expect(pgn.match(/covered in the "queens-gambit" line/g)).toHaveLength(1)
  })
})

describe('toPgn — naming a branch', () => {
  const simple = new Map([[fenKey(START), node([{ san: 'd4', fen: AFTER_D4, reason: 'ours' as const }])]])

  it('puts the branch name in the Event header', () => {
    expect(toPgn({ ...base, nodes: simple, rootFen: START, name: 'QGD Exchange' })).toContain(
      '[Event "Repertoire — White: QGD Exchange"]',
    )
  })

  it('keeps the bare header when there is no name', () => {
    expect(toPgn({ ...base, nodes: simple, rootFen: START })).toContain('[Event "Repertoire — White"]')
  })

  it('opens with why the branch is in the repertoire', () => {
    const pgn = toPgn({ ...base, nodes: simple, rootFen: START, why: 'the Carlsbad structure' })
    expect(pgn).toMatch(/\{the Carlsbad structure\}\s*1\. d4/)
  })

  it('strips braces from prose, which would close the comment early', () => {
    const pgn = toPgn({ ...base, nodes: simple, rootFen: START, why: 'a {nested} brace' })
    expect(pgn).toContain('{a nested brace}')
  })
})
