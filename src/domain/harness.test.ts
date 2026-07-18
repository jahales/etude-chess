import { describe, it, expect } from 'vitest'
import {
  parseGame,
  heroColorFromResult,
  shouldQuiz,
  buildQuiz,
} from './harness'

const SCHOLARS_MATE = `[Event "Test"]
[White "Alice"]
[Black "Bob"]
[Result "1-0"]

1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0`

describe('parseGame', () => {
  it('extracts headers, moves, and result', () => {
    const g = parseGame(SCHOLARS_MATE)
    expect(g.white).toBe('Alice')
    expect(g.black).toBe('Bob')
    expect(g.result).toBe('1-0')
    expect(g.sanMoves).toEqual(['e4', 'e5', 'Qh5', 'Nc6', 'Bc4', 'Nf6', 'Qxf7#'])
  })
})

describe('heroColorFromResult', () => {
  it('maps decisive results to the winner', () => {
    expect(heroColorFromResult('1-0')).toBe('w')
    expect(heroColorFromResult('0-1')).toBe('b')
  })
  it('has no hero for a draw or unknown result', () => {
    expect(heroColorFromResult('1/2-1/2')).toBeNull()
    expect(heroColorFromResult('*')).toBeNull()
  })
})

describe('shouldQuiz', () => {
  it('only quizzes the hero side', () => {
    expect(shouldQuiz('w', 'w', 10, 5, 8)).toBe(true)
    expect(shouldQuiz('b', 'w', 10, 5, 8)).toBe(false)
  })
  it('skips the opening before startPly', () => {
    expect(shouldQuiz('w', 'w', 7, 5, 8)).toBe(false)
    expect(shouldQuiz('w', 'w', 8, 5, 8)).toBe(true)
  })
  it('skips trivial (only-move) positions', () => {
    expect(shouldQuiz('w', 'w', 20, 1, 8)).toBe(false)
    expect(shouldQuiz('w', 'w', 20, 2, 8)).toBe(true)
  })
})

describe('buildQuiz', () => {
  const { sanMoves } = parseGame(SCHOLARS_MATE)

  it('quizzes only the hero side, from the right positions', () => {
    const items = buildQuiz(sanMoves, { heroColor: 'w', startPly: 0 })
    // White moves are plies 0,2,4,6 → four quiz items
    expect(items.map((i) => i.ply)).toEqual([0, 2, 4, 6])
    expect(items.every((i) => i.sideToMove === 'w')).toBe(true)
    expect(items.map((i) => i.masterMoveSan)).toEqual(['e4', 'Qh5', 'Bc4', 'Qxf7#'])
  })

  it('captures the master move in both SAN and UCI', () => {
    const first = buildQuiz(sanMoves, { heroColor: 'w', startPly: 0 })[0]!
    expect(first.masterMoveSan).toBe('e4')
    expect(first.masterMoveUci).toBe('e2e4')
    expect(first.fen.startsWith('rnbqkbnr/pppppppp')).toBe(true)
  })

  it('honours the opening cutoff', () => {
    // With the default cutoff (ply 8), this 7-ply game yields nothing.
    expect(buildQuiz(sanMoves, { heroColor: 'w' })).toHaveLength(0)
  })

  it('gives the loser side nothing to guess here except its own moves', () => {
    const items = buildQuiz(sanMoves, { heroColor: 'b', startPly: 0 })
    expect(items.map((i) => i.masterMoveSan)).toEqual(['e5', 'Nc6', 'Nf6'])
  })
})
