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

// A game that declares its own starting position (#128): there is no move
// before its first one, and no earlier movetext to invent one from.
const FROM_A_SETUP = `[Event "Study"]
[Result "1-0"]
[SetUp "1"]
[FEN "8/8/8/4k3/8/8/4P3/4K3 w - - 0 1"]

1. Kd2 Kd4 2. e3+ Kd5 1-0`

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

  // #160: the position has to say how it got there, and what it says must be
  // the move the game actually played — never a stand-in for one.
  describe('the move played into each position', () => {
    it('records the opponent’s last move in SAN and UCI', () => {
      const items = buildQuiz(sanMoves, { heroColor: 'w', startPly: 0 })
      expect(items.map((i) => i.priorMoveSan)).toEqual([undefined, 'e5', 'Nc6', 'Nf6'])
      expect(items.map((i) => i.priorMoveUci)).toEqual([undefined, 'e7e5', 'b8c6', 'g8f6'])
    })

    it('leaves it absent — not empty — at the game’s first position', () => {
      const first = buildQuiz(sanMoves, { heroColor: 'w', startPly: 0 })[0]!
      expect(first.ply).toBe(0)
      expect('priorMoveSan' in first).toBe(false)
      expect('priorMoveUci' in first).toBe(false)
    })

    it('leaves it absent at the first position of a SetUp/FEN game', () => {
      const parsed = parseGame(FROM_A_SETUP)
      const items = buildQuiz(parsed.sanMoves, {
        heroColor: 'w',
        startPly: 0,
        startFen: parsed.startFen!,
      })
      expect(items[0]!.ply).toBe(0)
      expect('priorMoveSan' in items[0]!).toBe(false)
      // …and the position after it still knows what led into it.
      expect(items[1]!.priorMoveSan).toBe('Kd4')
      expect(items[1]!.priorMoveUci).toBe('e5d4')
    })

    it('gives a quiz that starts mid-game the real move, not a placeholder', () => {
      // startPly 4 skips plies 0–3, which are still replayed — so the first
      // item asked about must carry the move immediately before it (2…Nc6).
      const items = buildQuiz(sanMoves, { heroColor: 'w', startPly: 4 })
      expect(items[0]!.ply).toBe(4)
      expect(items[0]!.priorMoveSan).toBe('Nc6')
      expect(items[0]!.priorMoveUci).toBe('b8c6')
    })
  })
})
