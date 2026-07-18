import { describe, it, expect } from 'vitest'
import { parseScore, parseBestMove, parseInfoLine } from './uci'

describe('parseScore', () => {
  it('reads a centipawn score from an info line', () => {
    expect(parseScore('info depth 12 seldepth 15 score cp 34 nodes 1000 pv e2e4')).toEqual({
      type: 'cp',
      value: 34,
    })
  })
  it('reads a negative centipawn score', () => {
    expect(parseScore('info depth 8 score cp -152 pv d7d5')).toEqual({ type: 'cp', value: -152 })
  })
  it('reads a mate score with sign', () => {
    expect(parseScore('info depth 20 score mate 3 pv h5f7')).toEqual({ type: 'mate', value: 3 })
    expect(parseScore('info score mate -2 pv a1a2')).toEqual({ type: 'mate', value: -2 })
  })
  it('returns null for lines without a score', () => {
    expect(parseScore('info string NNUE evaluation using ...')).toBeNull()
    expect(parseScore('bestmove e2e4')).toBeNull()
  })
  it('ignores lowerbound/upperbound lines (keep the last complete score)', () => {
    expect(parseScore('info depth 19 score cp -33 lowerbound nodes 400133 pv e7e5')).toBeNull()
    expect(parseScore('info depth 12 score cp 40 upperbound pv d2d4')).toBeNull()
  })
})

describe('parseBestMove', () => {
  it('reads the move, ignoring ponder', () => {
    expect(parseBestMove('bestmove e2e4 ponder e7e5')).toEqual({ move: 'e2e4' })
  })
  it('reads a promotion move', () => {
    expect(parseBestMove('bestmove a7a8q')).toEqual({ move: 'a7a8q' })
  })
  it('treats (none) as a terminal position', () => {
    expect(parseBestMove('bestmove (none)')).toEqual({ move: null })
  })
  it('returns null for non-bestmove lines', () => {
    expect(parseBestMove('info depth 1 score cp 20')).toBeNull()
  })
})

describe('parseInfoLine', () => {
  it('parses multipv rank, score, and the pv moves', () => {
    const r = parseInfoLine('info depth 18 seldepth 24 multipv 2 score cp 21 nodes 5 pv d2d4 d7d5 c2c4')
    expect(r).toEqual({ multipv: 2, score: { type: 'cp', value: 21 }, pv: ['d2d4', 'd7d5', 'c2c4'] })
  })
  it('defaults multipv to 1 when the field is absent', () => {
    expect(parseInfoLine('info depth 10 score cp 34 pv e2e4')!.multipv).toBe(1)
  })
  it('parses a mate line', () => {
    const r = parseInfoLine('info depth 20 multipv 1 score mate 2 pv h5f7 e8f7')
    expect(r!.score).toEqual({ type: 'mate', value: 2 })
    expect(r!.pv).toEqual(['h5f7', 'e8f7'])
  })
  it('rejects lines without a pv, bound lines, and non-info lines', () => {
    expect(parseInfoLine('info depth 1 score cp 20')).toBeNull()
    expect(parseInfoLine('info depth 19 score cp 33 lowerbound pv e7e5')).toBeNull()
    expect(parseInfoLine('bestmove e2e4')).toBeNull()
  })
})
