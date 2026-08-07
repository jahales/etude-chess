import { describe, it, expect } from 'vitest'
import { Chess } from 'chess.js'
import { TIER_A_MAX_SWING, TIER_B_MAX_SWING } from './grade'
import { BLUNDER_SWING, fenKey, toPgn, type RepertoireNode } from './repertoirePgn'

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
    // The prefix moved to [Variation]; [Opening] is a name, which is what every
    // reader of that tag expects and what a player can act on.
    expect(pgn).toContain('[Variation "d4 d5"]')
  })

  it('writes headers naming the side the repertoire is for', () => {
    const nodes = new Map([[fenKey(START), node([])]])
    const asBlack = toPgn({ ...base, ourColor: 'b', nodes, rootFen: START })
    expect(asBlack).toContain('[Event "Repertoire — Black"]')
    expect(asBlack).toContain('[Date "2026.08.05"]')
    expect(asBlack.trimEnd().endsWith('*')).toBe(true)
  })

  it('leaves the player tags unknown so a trainer falls through to [Event]', () => {
    // Measured against En Croissant, which is what actually consumes these
    // files. Its getGameName is:
    //
    //   if ((headers.white && headers.white !== "?") || (headers.black && ...))
    //       return `${headers.white} - ${headers.black}`
    //   if (headers.event) return headers.event
    //
    // Naming the players therefore *wins over* [Event], and every branch in a
    // file listed identically as "Repertoire - Opponent" — so there was no way
    // to tell which variation you were about to drill. "?" is the PGN standard
    // placeholder for an unknown player and lets the branch name through.
    const nodes = new Map([[fenKey(START), node([])]])
    for (const ourColor of ['w', 'b'] as const) {
      const pgn = toPgn({ ...base, ourColor, nodes, rootFen: START, name: 'Caro-Kann Advance' })
      expect(pgn).toContain('[White "?"]')
      expect(pgn).toContain('[Black "?"]')
      expect(pgn).not.toContain('[White "Repertoire"]')
      expect(pgn).not.toContain('[Black "Opponent"]')
      // The branch name is the thing a game list must show.
      expect(pgn).toMatch(/\[Event "Repertoire — (White|Black): Caro-Kann Advance"\]/)
    }
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

describe('toPgn — output a real parser will accept', () => {
  // Ground truth, not logic. The generator emitted three consecutive `{…}`
  // comments on one move — legal by the spec, rejected by chess.js, which is
  // this project's own parser. The file looked perfect and loaded nowhere.
  const loads = (pgn: string) => {
    const chess = new Chess()
    chess.loadPgn(pgn)
    return chess.history()
  }

  it('folds a move carrying an eval, a fact bundle and a terminal note into one comment', () => {
    const nodes = new Map([
      [fenKey(START), node([{ san: 'd4', fen: AFTER_D4, reason: 'ours' as const }])],
      [
        fenKey(AFTER_D4),
        node([
          {
            san: 'd5',
            fen: AFTER_D5,
            reason: 'mass+trap' as const,
            evalCp: 36,
            frequency: 0.45,
            practical: 0.51,
            expected: 0.42,
            games: 511,
            punished: true,
          },
        ]),
      ],
      [fenKey(AFTER_D5), node([], { terminal: true, terminalReason: 'quiet', quiet: { breadth: 5 } })],
    ])
    const pgn = toPgn({ ...base, nodes, rootFen: START })
    expect(pgn).not.toMatch(/\}\s*\{/)
    expect(pgn).toContain('[%eval 0.36]')
    expect(pgn).toContain('quiet: 5 playable moves')
    expect(loads(pgn)).toEqual(['d4', 'd5'])
  })

  it('emits no adjacent comments inside a variation either', () => {
    const nodes = new Map([
      [fenKey(START), node([{ san: 'd4', fen: AFTER_D4, reason: 'ours' as const }])],
      [
        fenKey(AFTER_D4),
        node([
          { san: 'd5', fen: AFTER_D5, reason: 'mass' as const, evalCp: 36 },
          { san: 'Nf6', fen: AFTER_NF6, reason: 'trap' as const, evalCp: 68, frequency: 0.2, games: 90 },
        ]),
      ],
      [fenKey(AFTER_D5), node([], { terminal: true, terminalReason: 'quiet', quiet: { breadth: 5 } })],
      [fenKey(AFTER_NF6), node([], { terminal: true, terminalReason: 'out-of-book', games: 12 })],
    ])
    const pgn = toPgn({ ...base, nodes, rootFen: START })
    expect(pgn).not.toMatch(/\}\s*\{/)
    expect(loads(pgn)).toEqual(['d4', 'd5'])
  })

  it('keeps the opening prose and the first move loadable together', () => {
    const nodes = new Map([[fenKey(START), node([{ san: 'd4', fen: AFTER_D4, reason: 'ours' as const }])]])
    const pgn = toPgn({ ...base, nodes, rootFen: START, why: 'the Carlsbad', name: 'QGD' })
    expect(loads(pgn)).toEqual(['d4'])
  })
})

describe('toPgn — untrusted strings from the manifest', () => {
  const load = (pgn: string) => {
    const chess = new Chess()
    chess.loadPgn(pgn)
    return chess.history()
  }
  const simple = () =>
    new Map([[fenKey(START), node([{ san: 'd4', fen: AFTER_D4, reason: 'ours' as const }])]])

  it('strips a quote from the branch name, which would end the header early', () => {
    // Stripped rather than escaped: chess.js rejects the spec's `\"` form, so
    // escaping correctly would still produce a file it will not read.
    const pgn = toPgn({ ...base, nodes: simple(), rootFen: START, name: 'Queen"s Gambit' })
    expect(pgn).toContain('[Event "Repertoire — White: Queens Gambit"]')
    expect(load(pgn)).toEqual(['d4'])
  })

  it('strips a backslash, which chess.js also chokes on', () => {
    const pgn = toPgn({ ...base, nodes: simple(), rootFen: START, name: 'a\\b' })
    expect(pgn).toContain('[Event "Repertoire — White: ab"]')
    expect(load(pgn)).toEqual(['d4'])
  })

  it('leaves an ordinary name alone', () => {
    const pgn = toPgn({ ...base, nodes: simple(), rootFen: START, name: "QGD Exchange — the Carlsbad" })
    expect(pgn).toContain('[Event "Repertoire — White: QGD Exchange — the Carlsbad"]')
  })

  it('strips braces from a branch id used in a move comment', () => {
    const nodes = new Map([
      [fenKey(START), node([{ san: 'd4', fen: AFTER_D4, reason: 'ours' as const }])],
      [
        fenKey(AFTER_D4),
        node([{ san: 'd5', fen: AFTER_D5, reason: 'mass' as const, delegatedTo: 'we{ird}' }]),
      ],
      [fenKey(AFTER_D5), node([], { terminal: true, terminalReason: 'quiet', quiet: { breadth: 4 } })],
    ])
    const pgn = toPgn({ ...base, nodes, rootFen: START })
    expect(pgn).toContain('covered in the "weird" line')
    expect(load(pgn)).toEqual(['d4', 'd5'])
  })

  it('strips braces from a branch id in a terminal comment', () => {
    const nodes = new Map([
      [fenKey(START), node([{ san: 'd4', fen: AFTER_D4, reason: 'ours' as const }])],
      [fenKey(AFTER_D4), node([], { terminal: true, terminalReason: 'delegated', delegatedTo: 'x}y' })],
    ])
    const pgn = toPgn({ ...base, nodes, rootFen: START })
    expect(pgn).toContain('covered in the "xy" line')
    expect(load(pgn)).toEqual(['d4'])
  })
})

describe('toPgn — the header the trainer actually reads', () => {
  // En Croissant's practice mode builds its deck with
  // `headers.orientation || "white"`, from the PGN tag [Orientation]. Without
  // it, a Black repertoire drills you as White — it hands you our opponent's
  // side of every line and marks our own moves wrong.
  const simple = () =>
    new Map([[fenKey(START), node([{ san: 'd4', fen: AFTER_D4, reason: 'ours' as const }])]])

  it('says which side the repertoire is for', () => {
    expect(toPgn({ ...base, nodes: simple(), rootFen: START })).toContain('[Orientation "white"]')
  })

  it('says black for a black repertoire', () => {
    const pgn = toPgn({ ...base, ourColor: 'b', nodes: simple(), rootFen: START })
    expect(pgn).toContain('[Orientation "black"]')
  })

  it('agrees with the Event header, so the two cannot drift', () => {
    for (const [colour, word] of [
      ['w', 'White'],
      ['b', 'Black'],
    ] as const) {
      const pgn = toPgn({ ...base, ourColor: colour, nodes: simple(), rootFen: START })
      expect(pgn).toContain(`[Orientation "${word.toLowerCase()}"]`)
      expect(pgn).toContain(`[Event "Repertoire — ${word}"]`)
    }
  })

  it('still loads in a parser with the extra tag', () => {
    const chess = new Chess()
    chess.loadPgn(toPgn({ ...base, ourColor: 'b', nodes: simple(), rootFen: START }))
    expect(chess.history()).toEqual(['d4'])
  })
})

describe('toPgn — move glyphs, anchored to the project’s own tiers', () => {
  // The thresholds were 10/15/25, which left the whole of Tier B between 5 and
  // 10 unmarked — grade.ts calls that "a real concession" and the file said
  // nothing about it. Across the built repertoire that produced 3 glyphs in 450
  // moves, which reads as "nothing here is a mistake".
  const withSwing = (swing: number) =>
    new Map([
      [fenKey(START), node([{ san: 'd4', fen: AFTER_D4, reason: 'ours' as const }])],
      [fenKey(AFTER_D4), node([{ san: 'd5', fen: AFTER_D5, reason: 'mass' as const, swing }])],
    ])
  const glyph = (swing: number) => {
    const m = toPgn({ ...base, nodes: withSwing(swing), rootFen: START }).match(/1\. d4 d5(\S*)/)
    return m?.[1] ?? ''
  }

  it('leaves a Tier A move unmarked — it is as good as best', () => {
    expect(glyph(0)).toBe('')
    expect(glyph(TIER_A_MAX_SWING)).toBe('')
  })

  it('marks a real concession, which starts where Tier A ends', () => {
    expect(glyph(TIER_A_MAX_SWING + 0.1)).toBe('?!')
    expect(glyph(9)).toBe('?!')
    expect(glyph(TIER_B_MAX_SWING)).toBe('?!')
  })

  it('marks a mistake where Tier C begins', () => {
    expect(glyph(TIER_B_MAX_SWING + 0.1)).toBe('?')
    expect(glyph(24)).toBe('?')
  })

  it('keeps ?? for giving up the game outright', () => {
    expect(glyph(BLUNDER_SWING + 0.1)).toBe('??')
    expect(glyph(60)).toBe('??')
  })

  it('never marks our own move — a repertoire does not contain our mistakes', () => {
    const nodes = new Map([
      [fenKey(START), node([{ san: 'd4', fen: AFTER_D4, reason: 'ours' as const, swing: 40 }])],
    ])
    expect(toPgn({ ...base, nodes, rootFen: START })).toContain('1. d4')
    expect(toPgn({ ...base, nodes, rootFen: START })).not.toContain('d4?')
  })

  it('says nothing when the swing was never measured', () => {
    const nodes = new Map([
      [fenKey(START), node([{ san: 'd4', fen: AFTER_D4, reason: 'ours' as const }])],
      [fenKey(AFTER_D4), node([{ san: 'd5', fen: AFTER_D5, reason: 'mass' as const }])],
    ])
    expect(toPgn({ ...base, nodes, rootFen: START })).toContain('1. d4 d5')
  })
})

describe('glyph thresholds stay pinned to grade.ts', () => {
  // repertoirePgn.ts cannot import them at runtime — it must stay
  // runtime-import-free so the .mjs scripts can load it under type stripping —
  // so the copies are pinned here instead, exactly as repertoire.ts does.
  const glyph = (swing: number) => {
    const nodes = new Map([
      [fenKey(START), node([{ san: 'd4', fen: AFTER_D4, reason: 'ours' as const }])],
      [fenKey(AFTER_D4), node([{ san: 'd5', fen: AFTER_D5, reason: 'mass' as const, swing }])],
    ])
    return toPgn({ ...base, nodes, rootFen: START }).match(/1\. d4 d5(\S*)/)?.[1] ?? ''
  }

  it('starts marking exactly where Tier A stops', () => {
    expect(glyph(TIER_A_MAX_SWING)).toBe('')
    expect(glyph(TIER_A_MAX_SWING + 0.01)).toBe('?!')
  })

  it('escalates exactly where Tier B stops', () => {
    expect(glyph(TIER_B_MAX_SWING)).toBe('?!')
    expect(glyph(TIER_B_MAX_SWING + 0.01)).toBe('?')
  })
})

describe('toPgn — glyphs actually appear on a realistic tree', () => {
  // The boundary tests above pin 5.01 and 15.01. Neither would notice if
  // `annotate` stopped being reached for the common path — and the whole change
  // was made because the built repertoire carried 3 glyphs in 450 moves.
  const swings = [0.1, 2, 4, 6, 9, 14, 18, 30]
  const tree = () => {
    const nodes = new Map([
      [fenKey(START), node([{ san: 'd4', fen: AFTER_D4, reason: 'ours' as const }])],
    ])
    // One opponent node with a spread of swings, as a real node has.
    const chess = new Chess(AFTER_D4)
    const replies = chess.moves({ verbose: true }).slice(0, swings.length)
    nodes.set(
      fenKey(AFTER_D4),
      node(
        replies.map((m, i) => ({
          san: m.san,
          fen: m.after,
          reason: 'mass' as const,
          swing: swings[i]!,
        })),
      ),
    )
    return nodes
  }

  it('marks every move outside Tier A and nothing inside it', () => {
    const pgn = toPgn({ ...base, nodes: tree(), rootFen: START })
    // Movetext only. Scanning the whole string counted the `?` in the player
    // tags, which are the PGN placeholder for an unknown player — the headers
    // have never been where move glyphs live.
    const movetext = pgn.slice(pgn.lastIndexOf(']\n') + 2)
    // 0.1, 2 and 4 are Tier A; the other five are not.
    expect((movetext.match(/[?!]+/g) ?? []).length).toBe(5)
  })

  it('uses the whole scale rather than collapsing to one glyph', () => {
    const pgn = toPgn({ ...base, nodes: tree(), rootFen: START })
    expect(pgn).toContain('?!')
    expect(pgn).toMatch(/\?(?!!)/) // a bare ? somewhere
    expect(pgn).toContain('??')
  })

  it('marks far more than the old thresholds would have', () => {
    // Old: >10 for ?!. Of these swings only 14, 18 and 30 qualified.
    const marked = swings.filter((s) => s > 5).length
    const wouldHaveBeen = swings.filter((s) => s > 10).length
    expect(marked).toBeGreaterThan(wouldHaveBeen)
  })
})

describe('toPgn — the variation a move commits to', () => {
  // "I really need to see that target variation somewhere otherwise I'm left
  // guessing among candidate moves." Both 3.cxd5 and 3.Nc3 are sound; what
  // separates them is which variation you are learning.
  const tree = (entersVariation?: string) =>
    new Map([
      [fenKey(START), node([{ san: 'd4', fen: AFTER_D4, reason: 'ours' as const, entersVariation }])],
      [fenKey(AFTER_D4), node([], { terminal: true, terminalReason: 'quiet', quiet: { breadth: 4 } })],
    ])

  it('names the variation on our move', () => {
    const pgn = toPgn({ ...base, nodes: tree('Queen’s Gambit Declined: Exchange Variation'), rootFen: START })
    expect(pgn).toContain('→ Queen’s Gambit Declined: Exchange Variation')
  })

  it('says nothing when the move commits to nothing new', () => {
    expect(toPgn({ ...base, nodes: tree(), rootFen: START })).not.toContain('→')
  })

  it('keeps it in the same comment as everything else the move has to say', () => {
    const nodes = new Map([
      [
        fenKey(START),
        node([
          {
            san: 'd4',
            fen: AFTER_D4,
            reason: 'ours' as const,
            source: 'band' as const,
            entersVariation: 'Some Variation',
          },
        ]),
      ],
      [fenKey(AFTER_D4), node([], { terminal: true, terminalReason: 'quiet', quiet: { breadth: 4 } })],
    ])
    const pgn = toPgn({ ...base, nodes, rootFen: START })
    expect(pgn).not.toMatch(/\}\s*\{/)
    expect(pgn).toContain('beyond master theory')
    expect(pgn).toContain('→ Some Variation')
  })

  it('still loads in a parser', () => {
    const chess = new Chess()
    chess.loadPgn(toPgn({ ...base, nodes: tree('QGD: Exchange'), rootFen: START }))
    expect(chess.history()).toEqual(['d4'])
  })

  it('strips braces from a name, as from every other injected string', () => {
    const pgn = toPgn({ ...base, nodes: tree('We{ir}d'), rootFen: START })
    expect(pgn).toContain('→ Weird')
  })
})

describe('toPgn — the opening headers say what they are supposed to', () => {
  const simple = () =>
    new Map([[fenKey(START), node([{ san: 'd4', fen: AFTER_D4, reason: 'ours' as const }])]])

  it('puts a name in [Opening] and a code in [ECO]', () => {
    const pgn = toPgn({
      ...base,
      nodes: simple(),
      rootFen: START,
      opening: "Queen's Gambit Declined: Exchange Variation",
      eco: 'D35',
    })
    expect(pgn).toContain('[ECO "D35"]')
    expect(pgn).toContain('[Opening "Queen\'s Gambit Declined: Exchange Variation"]')
  })

  it('omits both when the branch heads nowhere named', () => {
    const pgn = toPgn({ ...base, nodes: simple(), rootFen: START })
    expect(pgn).not.toContain('[ECO ')
    expect(pgn).not.toContain('[Opening ')
  })

  it('keeps the curated prefix, under the tag that means a move sequence', () => {
    const pgn = toPgn({ ...base, forcedSans: ['d4', 'd5'], nodes: simple(), rootFen: START })
    expect(pgn).toContain('[Variation "d4 d5"]')
  })
})

describe('toPgn — labels on the curated prefix', () => {
  // The prefix moves are the branch's own decisions — `3.cxd5` in the QGD
  // Exchange is *why* the branch exists — and the trainer makes cards from them
  // like any other. Rendering them bare left the most important forks unlabelled.
  const simple = () =>
    new Map([[fenKey(AFTER_D5), node([], { terminal: true, terminalReason: 'quiet', quiet: { breadth: 4 } })]])

  it('annotates a prefix move', () => {
    const pgn = toPgn({
      ...base,
      forcedSans: ['d4', 'd5'],
      prefixNotes: [null, null],
      nodes: simple(),
      rootFen: AFTER_D5,
    })
    expect(pgn).toContain('1. d4 d5')
  })

  it('puts the variation on the prefix move that commits to it', () => {
    const pgn = toPgn({
      ...base,
      forcedSans: ['d4', 'd5'],
      prefixNotes: [null, 'Queen’s Gambit Declined: Exchange Variation'],
      nodes: simple(),
      rootFen: AFTER_D5,
    })
    // Folded into the move's single comment, as every other note is. Asserted
    // on content, not adjacency — `wrap` breaks the line at 80 characters.
    expect(pgn).toContain('→ Queen’s Gambit Declined: Exchange Variation')
    expect(pgn.replace(/\s+/g, ' ')).toContain('1. d4 d5 {→ Queen’s Gambit Declined')
    expect(pgn).not.toMatch(/\}\s*\{/)
  })

  it('leaves an unlabelled prefix move bare', () => {
    const pgn = toPgn({
      ...base,
      forcedSans: ['d4', 'd5'],
      prefixNotes: ['Queen’s Pawn Game', null],
      nodes: simple(),
      rootFen: AFTER_D5,
    })
    expect(pgn).toContain('→ Queen’s Pawn Game')
    expect(pgn.match(/→/g)).toHaveLength(1)
  })

  it('works with no notes at all, as before', () => {
    const pgn = toPgn({ ...base, forcedSans: ['d4', 'd5'], nodes: simple(), rootFen: AFTER_D5 })
    expect(pgn).toContain('1. d4 d5')
    expect(pgn).not.toContain('→')
  })

  it('still loads in a parser with prefix comments', () => {
    const chess = new Chess()
    chess.loadPgn(
      toPgn({
        ...base,
        forcedSans: ['d4', 'd5'],
        prefixNotes: [null, 'QGD: Exchange'],
        nodes: simple(),
        rootFen: AFTER_D5,
      }),
    )
    expect(chess.history()).toEqual(['d4', 'd5'])
  })
})
