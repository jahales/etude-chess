import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { Chess } from 'chess.js'
import { loadOpenings, parseEcoTsv, positionKeyFor, variationFor } from './openings.mjs'

// Names for positions, so a repertoire can say *which variation* a move enters.
//
// The problem this solves: at `1.d4 d5 2.c4 e6` both 3.cxd5 and 3.Nc3 are
// sound, and the trainer demands one of them. "The engine liked it 0.3 better"
// is not a reason anyone can act on. "This is the Exchange Variation, which is
// what you are learning" is.

const fenOf = (sans) => {
  const c = new Chess()
  for (const s of sans) c.move(s)
  return c.fen()
}

describe('parseEcoTsv', () => {
  const tsv = 'eco\tname\tpgn\nD31\tQGD: Queen’s Knight\t1. d4 d5 2. c4 e6 3. Nc3\nA00\tHmm\t1. a3\n'

  it('reads the rows, skipping the header', () => {
    expect(parseEcoTsv(tsv)).toHaveLength(2)
  })

  it('keeps eco, name and moves', () => {
    expect(parseEcoTsv(tsv)[0]).toMatchObject({
      eco: 'D31',
      name: 'QGD: Queen’s Knight',
      sans: ['d4', 'd5', 'c4', 'e6', 'Nc3'],
    })
  })

  it('strips move numbers from the pgn column', () => {
    expect(parseEcoTsv(tsv)[1].sans).toEqual(['a3'])
  })

  it('ignores blank lines rather than yielding empty rows', () => {
    expect(parseEcoTsv(tsv + '\n\n')).toHaveLength(2)
  })

  it('rejects a file whose header is not what we expect', () => {
    // A silently-changed upstream format would give every position no name and
    // look exactly like "these positions are unnamed".
    expect(() => parseEcoTsv('a\tb\tc\nD31\tx\t1. d4\n')).toThrow(/header/)
  })
})

describe('loadOpenings', () => {
  const openings = loadOpenings()

  it('loads the whole table', () => {
    expect(openings.size).toBeGreaterThan(3000)
  })

  it('names a position the table indexes directly', () => {
    expect(openings.get(positionKeyFor(fenOf(['d4', 'd5', 'c4', 'e6', 'Nc3'])))).toMatchObject({
      eco: 'D31',
      name: "Queen's Gambit Declined: Queen's Knight Variation",
    })
  })

  it('has no name for a position the table skips, which is common', () => {
    // The table indexes named *lines*, not every position: 3.cxd5 in this order
    // is unnamed even though the Exchange Variation is named at three others.
    // A design that annotated only the position after our move would say
    // nothing at exactly the fork that needs it.
    expect(openings.get(positionKeyFor(fenOf(['d4', 'd5', 'c4', 'e6', 'cxd5'])))).toBeUndefined()
  })

  it('names both sides of the Slav fork', () => {
    expect(openings.get(positionKeyFor(fenOf(['d4', 'd5', 'c4', 'c6', 'Nf3'])))?.name).toMatch(
      /Slav/,
    )
  })

  it('is keyed by position, so a transposition finds the same name', () => {
    // 1.d4 e6 2.c4 d5 3.Nc3 is the same board as 1.d4 d5 2.c4 e6 3.Nc3, and a
    // repertoire that names one and not the other would be worse than useless.
    const byOrder = positionKeyFor(fenOf(['d4', 'd5', 'c4', 'e6', 'Nc3']))
    const transposed = positionKeyFor(fenOf(['d4', 'e6', 'c4', 'd5', 'Nc3']))
    expect(transposed).toBe(byOrder)
    expect(openings.get(transposed)?.name).toBe(openings.get(byOrder)?.name)
  })

  it('has no name for a position nobody named', () => {
    expect(openings.get(positionKeyFor(fenOf(['a3', 'h6', 'a4', 'h5'])))).toBeUndefined()
  })

  it('ignores the clocks, as every other position key here does', () => {
    expect(positionKeyFor('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 4 30')).toBe(
      positionKeyFor('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'),
    )
  })

  it('is loaded once and reused', () => {
    expect(loadOpenings()).toBe(openings)
  })
})

describe('variationFor — where a line is heading', () => {
  // The table names lines, not positions, so the name that answers "which
  // variation am I learning" is often several moves *ahead* of the fork. Our
  // own tree knows where the line goes, so the label comes from there.
  const node = (line, children = []) => ({ line, children })

  /** A tiny tree keyed the way the crawler keys one. */
  const treeOf = (paths) => {
    const nodes = new Map()
    for (const path of paths) {
      const sans = path.split(' ').filter(Boolean)
      const board = new Chess()
      for (let i = 0; i <= sans.length; i++) {
        const key = positionKeyFor(board.fen())
        if (!nodes.has(key)) nodes.set(key, node(sans.slice(0, i), []))
        if (i === sans.length) break
        const mv = board.move(sans[i])
        nodes.get(key).children.push({ san: mv.san, fen: board.fen() })
      }
    }
    return nodes
  }

  it('reaches forward past unnamed positions to the variation the line enters', () => {
    const nodes = treeOf(['d4 d5 c4 e6 cxd5 exd5 Nc3 Nf6 Bg5'])
    const start = new Chess()
    for (const s of ['d4', 'd5', 'c4', 'e6']) start.move(s)
    const found = variationFor(nodes, start.fen())
    expect(found?.name).toMatch(/Exchange Variation/)
  })

  it('is null when nothing downstream is named', () => {
    // Injected empty, because almost every early position genuinely has a name
    // — even 1.a3 is Anderssen's Opening. The "unnamed" path is real but rare.
    const nodes = treeOf(['d4 d5 c4 e6'])
    expect(variationFor(nodes, new Chess().fen(), new Map())).toBeNull()
  })

  it('prefers the deepest name, which is the most specific', () => {
    const nodes = treeOf(['d4 d5 c4 e6 cxd5 exd5 Nc3 Nf6 Bg5'])
    const start = new Chess()
    for (const s of ['d4', 'd5']) start.move(s)
    // "Queen's Gambit" sits at ply 3; the Exchange Variation is deeper.
    expect(variationFor(nodes, start.fen())?.name).toMatch(/Exchange Variation/)
  })

  it('does not walk off the end of a tree it does not have', () => {
    expect(variationFor(new Map(), new Chess().fen())).toBeNull()
  })

  it('terminates on a tree with a transposition back into itself', () => {
    // Nodes are keyed by position, so a cycle is representable; the walk must
    // not follow it forever.
    const nodes = treeOf(['Nf3 Nf6 Ng1 Ng8'])
    expect(() => variationFor(nodes, new Chess().fen())).not.toThrow()
  })
})

describe('the ECO table has to actually be there', () => {
  // It was not, for one commit: .gitignore's blanket `data/` rule for chess
  // datasets swallowed the directory, `git add -A` reported nothing, and every
  // local test passed because the files were on disk. CI caught it.
  it('ships the five files the build reads', () => {
    // Repo-relative: vitest's transform leaves import.meta.url as a non-file
    // URL, and its root is the repo root.
    const files = readdirSync('scripts/repertoire/data').filter((f) => f.endsWith('.tsv'))
    expect(files.sort()).toEqual(['eco-a.tsv', 'eco-b.tsv', 'eco-c.tsv', 'eco-d.tsv', 'eco-e.tsv'])
  })

  it('records where they came from and under what licence', () => {
    const readme = readFileSync('scripts/repertoire/data/README.md', 'utf8')
    expect(readme).toMatch(/CC0/)
    expect(readme).toMatch(/lichess-org\/chess-openings/)
  })
})
