import { describe, it, expect } from 'vitest'
import { parseScore, parseBestMove } from './uci'

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
