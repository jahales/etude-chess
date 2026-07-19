import { describe, it, expect } from 'vitest'
import { Chess } from 'chess.js'
import { GAMES } from '../content/games'
import { replayPositions } from '../domain/replay'
import { buildReplayMoves, replayRows, movesWorthStudying, coachAtCursor } from './replay'
import { accuracyReport, evalSwingAt, BATCH_NODES } from './gameAnalysis'
import type { StoredGame } from '../persist/db'
import type { PositionEval } from '../domain/gameRecord'

// #79: everything else is verified on 2-4 move games. A real game is 40-50 plies,
// and that is where index arithmetic, pairing and "which five moves matter" either
// hold up or quietly don't. The Evergreen Game (47 plies) is the fixture.
const pgn = GAMES.find((g) => g.id === 'evergreen-1852')!.pgn
const sanHistory = (() => {
  const c = new Chess()
  c.loadPgn(pgn)
  return c.history()
})()

/** Deterministic pseudo-evals: a smooth drift with two sharp drops on White's moves. */
function evalsFor(plies: number): (PositionEval | undefined)[] {
  return Array.from({ length: plies }, (_, ply) => {
    let pct = 50 + Math.sin(ply / 5) * 4
    if (ply === 20) pct = 18 // White collapses here
    if (ply === 21) pct = 19
    if (ply === 34) pct = 8 // and again here
    if (ply === 35) pct = 9
    return { whitePct: pct, label: pct.toFixed(1) }
  })
}

function longGame(over: Partial<StoredGame> = {}): StoredGame {
  return {
    gameId: 'long',
    yourColor: 'w',
    level: 1500,
    sanHistory,
    outcome: 'you',
    reason: 'checkmate',
    accuracy: 0,
    takebacks: 0,
    createdAt: 0,
    ...over,
  }
}

describe('a full-length game (47 plies)', () => {
  it('replays every position', () => {
    const positions = replayPositions(sanHistory)
    expect(sanHistory.length).toBeGreaterThan(40) // guard the fixture itself
    expect(positions).toHaveLength(sanHistory.length + 1)
    // The last position must be the real final one, not a truncation.
    const c = new Chess()
    c.loadPgn(pgn)
    expect(positions[positions.length - 1]).toBe(c.fen())
  })

  it('pairs into the right number of numbered rows', () => {
    const rows = replayRows(buildReplayMoves(longGame()))
    expect(rows).toHaveLength(Math.ceil(sanHistory.length / 2))
    expect(rows[rows.length - 1]?.n).toBe(Math.ceil(sanHistory.length / 2))
    // Every row's White move is at an even ply and Black's at an odd one.
    for (const row of rows) {
      if (row.w) expect(row.w.ply % 2).toBe(0)
      if (row.b) expect(row.b.ply % 2).toBe(1)
    }
  })

  it('keeps ply alignment between moves, rows and the cursor across the whole game', () => {
    // The off-by-one that a short game would never reveal.
    const moves = buildReplayMoves(longGame())
    for (const move of moves) expect(move.san).toBe(sanHistory[move.ply])

    const coachLog = [{ ply: 40, fen: 'f', san: sanHistory[40]!, tier: 'C' as const, swing: 30, bestMoveSan: null }]
    expect(coachAtCursor(longGame({ coachLog }), 41)?.san).toBe(sanHistory[40])
    expect(coachAtCursor(longGame({ coachLog }), 40)).toBeUndefined()
  })

  it('surfaces the moves that actually lost the game, not the first bad ones it finds', () => {
    const evals = evalsFor(sanHistory.length)
    const moves = buildReplayMoves(longGame(), evals, { annotated: true })
    const study = movesWorthStudying(moves, 'w')

    expect(study.length).toBeGreaterThan(0)
    expect(study.length).toBeLessThanOrEqual(5) // stays a study aid, not a dump
    // The two engineered collapses are your moves and must lead the list.
    expect(study[0]?.ply).toBe(34)
    expect(study[1]?.ply).toBe(20)
    // Ordered worst-first throughout.
    const swings = study.map((m) => m.evalSwing ?? 0)
    expect([...swings].sort((a, b) => b - a)).toEqual(swings)
  })

  it('computes accuracy over every one of your moves, not a prefix', () => {
    const evals = evalsFor(sanHistory.length)
    const report = accuracyReport(
      longGame({ evalByPly: evals, startEval: { whitePct: 50, label: '0.0' },
                 analysedAt: 1, analysisNodes: BATCH_NODES }),
    )
    expect(report.source).toBe('analysis')
    expect(report.complete).toBe(true)
    expect(report.covered).toBe(Math.ceil(sanHistory.length / 2)) // all of White's moves
    expect(report.accuracy).toBeLessThan(100)
  })

  it('measures the last move of the game', () => {
    // An off-by-one at the tail is invisible in a 3-move game.
    const evals = evalsFor(sanHistory.length)
    const last = sanHistory.length - 1
    expect(evalSwingAt(evals, last, last % 2 === 0 ? 'w' : 'b')).toBeDefined()
  })
})
