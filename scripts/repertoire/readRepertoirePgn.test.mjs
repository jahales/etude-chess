import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import {
  ourDecisions,
  parseDelegation,
  parseEvalComment,
  walkRepertoire,
} from './readRepertoirePgn.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repertoireDir = join(here, '..', '..', 'repertoire')

const HEAD = (event, orientation = 'white') =>
  `[Event "${event}"]\n[Orientation "${orientation}"]\n[Result "*"]\n\n`

describe('parseEvalComment', () => {
  it('reads a centipawn eval into hundredths', () => {
    expect(parseEvalComment(' [%eval 0.60] ')).toEqual({ type: 'cp', value: 60 })
    expect(parseEvalComment(' [%eval -1.25] ')).toEqual({ type: 'cp', value: -125 })
  })

  it('reads a mate eval', () => {
    expect(parseEvalComment('[%eval #-3]')).toEqual({ type: 'mate', value: -3 })
    expect(parseEvalComment('[%eval #5]')).toEqual({ type: 'mate', value: 5 })
  })

  it('is undefined when there is no eval', () => {
    expect(parseEvalComment('quiet: 5 playable moves')).toBeUndefined()
    expect(parseEvalComment(undefined)).toBeUndefined()
  })
})

describe('parseDelegation', () => {
  it('names the branch that owns the subtree', () => {
    expect(parseDelegation('[%eval 0.43] · covered in the "qga" line')).toBe('qga')
  })

  it('is undefined for an ordinary comment', () => {
    expect(parseDelegation('[%eval 0.43]')).toBeUndefined()
  })
})

describe('orientationOf', () => {
  it('refuses to guess when the header is missing', () => {
    const text = '[Event "x"]\n[Result "*"]\n\n1. e4 *\n'
    expect(() => [...walkRepertoire(text)]).toThrow(/no usable \[Orientation\]/)
  })
})

describe('walkRepertoire — the variations chess.js drops', () => {
  const text =
    HEAD('test') +
    '1. e4 e5 (1... c5 2. c3 d5) (1... c6 2. d4) 2. Nf3 Nc6 (2... d6 3. d4) 3. Bb5 *\n'

  it('visits sibling variations, not just the mainline', () => {
    const sans = [...walkRepertoire(text)].map((n) => n.san)
    expect(sans).toContain('c5')
    expect(sans).toContain('c6')
    expect(sans).toContain('d6')
    // The mainline is still there and complete.
    for (const san of ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5']) expect(sans).toContain(san)
  })

  it('recurses into moves that only exist inside a variation', () => {
    const lines = [...walkRepertoire(text)].map((n) => n.line.join(' '))
    expect(lines).toContain('e4 c5 c3 d5')
    expect(lines).toContain('e4 c6 d4')
  })

  it('gives each node the position before its move, and after', () => {
    const first = [...walkRepertoire(text)][0]
    expect(first.san).toBe('e4')
    expect(first.fen).toMatch(/^rnbqkbnr\/pppppppp\/8\/8\/8\/8\/PPPPPPPP\/RNBQKBNR w /)
    expect(first.fenAfter).toMatch(/^rnbqkbnr\/pppppppp\/8\/8\/4P3\/8\/PPPP1PPP\/RNBQKBNR b /)
  })

  it('numbers plies by depth, so a variation shares its sibling\'s ply', () => {
    const byLine = new Map([...walkRepertoire(text)].map((n) => [n.line.join(' '), n]))
    expect(byLine.get('e4 e5').ply).toBe(2)
    expect(byLine.get('e4 c5').ply).toBe(2)
    expect(byLine.get('e4 c5 c3').ply).toBe(3)
  })

  it('marks the first child of each node as the mainline', () => {
    const byLine = new Map([...walkRepertoire(text)].map((n) => [n.line.join(' '), n]))
    expect(byLine.get('e4 e5').mainline).toBe(true)
    expect(byLine.get('e4 c5').mainline).toBe(false)
    expect(byLine.get('e4 c6').mainline).toBe(false)
  })

  it('visits the mainline before the variations', () => {
    const lines = [...walkRepertoire(text)].map((n) => n.line.join(' '))
    expect(lines.indexOf('e4 e5')).toBeLessThan(lines.indexOf('e4 c5'))
  })

  it('visits the mainline first at the root too, not just deeper down', () => {
    // The stack is popped from the end, so the root children need the same
    // reversal the recursive push uses. Without it the root's variations are
    // walked before its mainline and ourDecisions, which keeps the first
    // occurrence, attributes a shared position to a variation.
    const twoFirstMoves = HEAD('roots') + '1. d4 (1. e4 e5 2. Nf3) 1... d5 2. c4 *\n'
    const sans = [...walkRepertoire(twoFirstMoves)].map((n) => n.san)
    expect(sans.indexOf('d4')).toBeLessThan(sans.indexOf('e4'))
    expect(sans[0]).toBe('d4')
  })

  it('marks the root mainline, not a root variation, as the mainline', () => {
    const twoFirstMoves = HEAD('roots') + '1. d4 (1. e4 e5) 1... d5 *\n'
    const byLine = new Map([...walkRepertoire(twoFirstMoves)].map((n) => [n.line.join(' '), n]))
    expect(byLine.get('d4').mainline).toBe(true)
    expect(byLine.get('e4').mainline).toBe(false)
  })

  it('raises on an illegal move instead of truncating the tree', () => {
    // Well-formed SAN, illegal here: no white knight can reach f6. (A malformed
    // token like "Qh9" is dropped by the chessops tokeniser and never becomes a
    // node, so it would not exercise this path.)
    expect(() => [...walkRepertoire(HEAD('bad') + '1. e4 e5 2. Nf6 *\n')]).toThrow(/illegal move/)
  })
})

describe('ourDecisions', () => {
  const text =
    HEAD('test') + '1. e4 e5 (1... c5 2. c3) (1... c6 2. d4) 2. Nf3 Nc6 3. Bb5 *\n'

  it('takes our moves and not the opponent\'s', () => {
    const { decisions } = ourDecisions(text)
    expect(decisions.map((n) => n.san)).toEqual(['e4', 'Nf3', 'Bb5', 'c3', 'd4'])
    expect(decisions.every((n) => n.sideToMove === 'w')).toBe(true)
  })

  it('includes our replies inside variations — that is where most of them are', () => {
    expect(ourDecisions(text).decisions.map((n) => n.line.join(' '))).toContain('e4 c5 c3')
  })

  it('follows [Orientation "black"] rather than assuming White', () => {
    const black = HEAD('caro', 'black') + '1. e4 c6 2. d4 d5 *\n'
    const { decisions } = ourDecisions(black)
    expect(decisions.map((n) => n.san)).toEqual(['c6', 'd5'])
    expect(decisions.every((n) => n.sideToMove === 'b')).toBe(true)
  })

  it('counts a position two branches share only once', () => {
    // Every branch of the 1.e4 deck opens 1.e4, so the shared prefix would
    // otherwise be counted once per branch and inflate the denominator.
    const two =
      HEAD('a') + '1. e4 e5 2. Nf3 *\n\n' + HEAD('b') + '1. e4 c5 2. Nf3 *\n'
    const { decisions, conflicts } = ourDecisions(two)
    expect(decisions.filter((n) => n.san === 'e4')).toHaveLength(1)
    expect(conflicts).toEqual([])
  })

  it('reports two branches that answer the same position differently', () => {
    // The one property a repertoire must have is that you know which move you
    // play. A disagreement is a finding, not something for dedup to swallow.
    const clashing =
      HEAD('a') + '1. d4 d5 2. c4 e6 3. cxd5 *\n\n' + HEAD('b') + '1. d4 d5 2. c4 e6 3. Nc3 *\n'
    const { conflicts } = ourDecisions(clashing)
    expect(conflicts).toHaveLength(1)
    expect([conflicts[0].a.san, conflicts[0].b.san].sort()).toEqual(['Nc3', 'cxd5'])
  })
})

describe('the shipped repertoire files', () => {
  const files = [
    'etude-repertoire-v1-white.pgn',
    'etude-repertoire-v1-white-e4.pgn',
    'etude-repertoire-v1-black.pgn',
  ]

  it.each(files)('%s parses, and every move is legal', (name) => {
    const text = readFileSync(join(repertoireDir, name), 'utf8')
    const nodes = [...walkRepertoire(text)]
    expect(nodes.length).toBeGreaterThan(100)
    expect(nodes.every((n) => n.fen && n.san)).toBe(true)
  })

  it.each(files)('%s yields our decisions on the right side', (name) => {
    const text = readFileSync(join(repertoireDir, name), 'utf8')
    const { decisions } = ourDecisions(text)
    expect(decisions.length).toBeGreaterThan(20)
    const orientation = decisions[0].orientation
    expect(decisions.every((n) => n.sideToMove === orientation)).toBe(true)
  })

  it('finds the variations that make this file worth a real parser', () => {
    const text = readFileSync(join(repertoireDir, 'etude-repertoire-v1-white-e4.pgn'), 'utf8')
    const nodes = [...walkRepertoire(text)]
    // The e4 deck opens with five sibling replies to 1.e4 alone.
    const repliesToE4 = nodes.filter((n) => n.ply === 2)
    expect(repliesToE4.length).toBeGreaterThan(3)
    expect(nodes.some((n) => n.delegatedTo)).toBe(true)
    expect(nodes.some((n) => n.eval)).toBe(true)
  })
})
