import { describe, it, expect } from 'vitest'
import { buildReplayMoves, replayRows, coachAtCursor, clampCursor, movesWorthStudying } from './replay'
import type { StoredGame } from '../persist/db'
import type { CoachEntry } from '../domain/gameRecord'

function coach(ply: number, over: Partial<CoachEntry> = {}): CoachEntry {
  return { ply, fen: `fen${ply}`, san: 'x', tier: 'A', swing: 0, bestMoveSan: null, ...over }
}

function game(over: Partial<StoredGame> = {}): StoredGame {
  return {
    gameId: 'g',
    yourColor: 'w',
    level: 1500,
    sanHistory: ['e4', 'e5', 'Nf3', 'Nc6'],
    outcome: 'you',
    reason: 'checkmate',
    accuracy: 90,
    takebacks: 0,
    createdAt: 0,
    ...over,
  }
}

describe('buildReplayMoves', () => {
  it('attaches the coach entry to your moves and leaves the opponent bare', () => {
    const moves = buildReplayMoves(
      game({ coachLog: [coach(0, { tier: 'B', swing: 7.5, bestMoveSan: 'd4' })] }),
    )
    expect(moves[0]).toMatchObject({ ply: 0, san: 'e4', tier: 'B', swing: 7.5, bestMoveSan: 'd4' })
    expect(moves[1]).toMatchObject({ ply: 1, san: 'e5', tier: undefined, swing: undefined })
  })

  it('reads the eval label for the position after each move', () => {
    const moves = buildReplayMoves(
      game({ evalByPly: [{ whitePct: 53, label: '+0.2' }, undefined, { whitePct: 49, label: '-0.1' }] }),
    )
    expect(moves[0]?.score).toBe('+0.2')
    expect(moves[1]?.score).toBeUndefined() // gap in the stored evals, not an error
    expect(moves[2]?.score).toBe('-0.1')
  })

  it('handles a v0.2 record with no coach data at all', () => {
    const moves = buildReplayMoves(game({ coachLog: undefined, evalByPly: undefined }))
    expect(moves).toHaveLength(4)
    expect(moves.every((m) => m.tier === undefined && m.score === undefined)).toBe(true)
  })
})

describe('replayRows', () => {
  it('pairs moves into numbered rows', () => {
    const rows = replayRows(buildReplayMoves(game()))
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ n: 1 })
    expect(rows[0]?.w?.san).toBe('e4')
    expect(rows[0]?.b?.san).toBe('e5')
    expect(rows[1]?.w?.san).toBe('Nf3')
  })

  it('leaves the last Black slot empty on an odd-length game', () => {
    const rows = replayRows(buildReplayMoves(game({ sanHistory: ['e4', 'e5', 'Nf3'] })))
    expect(rows[1]?.w?.san).toBe('Nf3')
    expect(rows[1]?.b).toBeUndefined()
  })

  it('is empty for a game with no moves', () => {
    expect(replayRows(buildReplayMoves(game({ sanHistory: [] })))).toEqual([])
  })
})

describe('coachAtCursor', () => {
  // The cursor counts moves *played*, so cursor N shows the position after N
  // moves and selects move N-1. Cursor 0 is the start position: nothing selected.
  const g = game({ coachLog: [coach(0, { san: 'e4' }), coach(2, { san: 'Nf3' })] })

  it('selects nothing at the start position', () => {
    expect(coachAtCursor(g, 0)).toBeUndefined()
  })

  it('selects the move the cursor sits after', () => {
    expect(coachAtCursor(g, 1)?.san).toBe('e4')
    expect(coachAtCursor(g, 3)?.san).toBe('Nf3')
  })

  it('is undefined on an opponent move, which the coach never graded', () => {
    expect(coachAtCursor(g, 2)).toBeUndefined()
  })
})

describe('clampCursor', () => {
  it('keeps navigation inside the game', () => {
    expect(clampCursor(-1, 4)).toBe(0)
    expect(clampCursor(9, 4)).toBe(4) // 4 moves ⇒ the final position is cursor 4
    expect(clampCursor(2, 4)).toBe(2)
  })
})

describe('annotations derived from the whole-game analysis', () => {
  // evalByPly[p] is the eval after move p, White's perspective.
  const evals = [
    { whitePct: 55, label: '+0.2' }, // after 1.e4  (no prior eval ⇒ no swing)
    { whitePct: 52, label: '+0.1' }, // after 1...e5 : Black gave up 3 ⇒ fine
    { whitePct: 20, label: '−2.0' }, // after 2.Nf3? : White gave up 32 ⇒ blunder
    { whitePct: 28, label: '−1.5' }, // after 2...Nc6: Black gave up 8 ⇒ inaccuracy
  ]

  it('marks every move, not only the ones the coach graded', () => {
    // The coach graded nothing here; the glyphs come purely from the analysis.
    const moves = buildReplayMoves(game({ coachLog: [] }), evals)
    expect(moves[0]?.annotation).toBeUndefined() // no prior eval to measure against
    expect(moves[1]?.annotation).toBeUndefined()
    expect(moves[2]?.annotation).toBe('??')
    expect(moves[3]?.annotation).toBe('?!')
  })

  it('measures each move from its own mover’s side, positive = ground given up', () => {
    const moves = buildReplayMoves(game(), evals)
    // whitePct always reads White's perspective, so the same movement means
    // opposite things depending on who moved.
    expect(moves[2]?.evalSwing).toBeCloseTo(32) // White's move: 52 → 20, White gave up 32
    expect(moves[3]?.evalSwing).toBeCloseTo(8) // Black's move: 20 → 28 favours White by 8
  })

  it('leaves moves unmarked when the game has not been analysed', () => {
    // Absent must read as "not measured", never as "fine".
    const moves = buildReplayMoves(game({ evalByPly: undefined }))
    expect(moves.every((m) => m.annotation === undefined && m.evalSwing === undefined)).toBe(true)
  })
})

describe('movesWorthStudying', () => {
  const evals = [
    { whitePct: 55, label: 'a' },
    { whitePct: 52, label: 'b' },
    { whitePct: 20, label: 'c' }, // 2.Nf3?? — White gave up 32
    { whitePct: 90, label: 'd' }, // 2...Nc6?? — Black gave up 70
  ]

  it('lists only your own moves, worst first', () => {
    const moves = buildReplayMoves(game(), evals)
    const mine = movesWorthStudying(moves, 'w')
    expect(mine.map((m) => m.ply)).toEqual([2]) // ply 3 is Black's, however bad
    expect(mine[0]?.annotation).toBe('??')
  })

  it('is your opponent’s list when you are Black', () => {
    const theirs = movesWorthStudying(buildReplayMoves(game(), evals), 'b')
    expect(theirs.map((m) => m.ply)).toEqual([3])
  })

  it('is empty for a game with nothing worth flagging', () => {
    const flat = [{ whitePct: 50, label: 'x' }, { whitePct: 50, label: 'x' }, { whitePct: 50, label: 'x' }]
    expect(movesWorthStudying(buildReplayMoves(game(), flat), 'w')).toEqual([])
  })

  it('caps the list so it stays a study aid rather than a dump', () => {
    const noisy = Array.from({ length: 12 }, (_, i) => ({ whitePct: i % 2 ? 90 : 10, label: 'x' }))
    const many = buildReplayMoves(game({ sanHistory: Array(12).fill('e4') }), noisy)
    expect(movesWorthStudying(many, 'w', 3)).toHaveLength(3)
  })
})
