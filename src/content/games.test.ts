import { describe, it, expect } from 'vitest'
import { GAMES } from './games'
import { parseGame, heroColorFromResult, buildQuiz } from '../domain/harness'

describe('game pack', () => {
  it('has a stable, unique id for every game', () => {
    const ids = GAMES.map((g) => g.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(GAMES.length).toBeGreaterThanOrEqual(3)
  })

  // Each PGN must be legal (chess.js throws on bad moves), decisive, and produce
  // real quiz positions for the winner. This is the content's correctness net.
  for (const game of GAMES) {
    describe(game.title, () => {
      const parsed = parseGame(game.pgn)

      it('parses to a legal, decisive game', () => {
        expect(parsed.sanMoves.length).toBeGreaterThan(10)
        expect(['1-0', '0-1']).toContain(parsed.result)
      })

      it('produces quiz positions for the winning side', () => {
        const hero = heroColorFromResult(parsed.result)
        expect(hero).not.toBeNull()
        const quiz = buildQuiz(parsed.sanMoves, { heroColor: hero!, startPly: 8 })
        expect(quiz.length).toBeGreaterThan(0)
        expect(quiz.every((q) => q.sideToMove === hero)).toBe(true)
      })
    })
  }
})
