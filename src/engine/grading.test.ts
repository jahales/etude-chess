import { describe, it, expect } from 'vitest'
import { Chess } from 'chess.js'
import { evaluateAndGrade } from './grading'
import { limitString, DEFAULT_NODES, type Analyser } from './analyser'
import type { EngineEvaluation } from '../domain/types'

/** Scripted analyser: returns a canned evaluation per FEN, counting the searches. */
class FakeAnalyser implements Analyser {
  searches: string[] = []
  constructor(private byFen: Record<string, EngineEvaluation>) {}
  evaluate(fen: string): Promise<EngineEvaluation> {
    this.searches.push(fen)
    return Promise.resolve(this.byFen[fen] ?? { score: { type: 'cp', value: 0 }, bestMove: null })
  }
  analyseLines(): Promise<[]> {
    return Promise.resolve([])
  }
  dispose(): void {}
}

function afterFen(fen: string, san: string): string {
  const c = new Chess(fen)
  c.move(san)
  return c.fen()
}

const START = new Chess().fen()

describe('limitString', () => {
  it('prefers nodes, then depth, then movetime', () => {
    expect(limitString({ nodes: 500 })).toBe('nodes 500')
    expect(limitString({ depth: 18 })).toBe('depth 18')
    expect(limitString({ movetime: 1000 })).toBe('movetime 1000')
  })
  it('falls back to a fixed node budget (reproducible)', () => {
    expect(limitString({})).toBe(`nodes ${DEFAULT_NODES}`)
  })
})

describe('evaluateAndGrade', () => {
  it('gives Tier A to an engine-equal move (perspective handled correctly)', async () => {
    const fen = START
    const analyser = new FakeAnalyser({
      [fen]: { score: { type: 'cp', value: 30 }, bestMove: 'g1f3' },
      // After 1.Nf3 it is Black to move; +30 for White reads as -30 to Black.
      [afterFen(fen, 'Nf3')]: { score: { type: 'cp', value: -30 }, bestMove: null },
    })
    const g = await evaluateAndGrade(analyser, fen, 'Nf3')
    expect(g.grade.tier).toBe('A')
    expect(g.bestMoveUci).toBe('g1f3')
  })

  it('gives Tier C to a move that swings the eval away', async () => {
    const fen = START
    const analyser = new FakeAnalyser({
      [fen]: { score: { type: 'cp', value: 30 }, bestMove: 'g1f3' },
      // After the poor move it is Black to move and clearly better (+280 for Black).
      [afterFen(fen, 'a3')]: { score: { type: 'cp', value: 280 }, bestMove: null },
    })
    const g = await evaluateAndGrade(analyser, fen, 'a3')
    expect(g.grade.tier).toBe('C')
    expect(g.playedScoreMover).toEqual({ type: 'cp', value: -280 })
  })

  it('scores a checkmating move without consulting the engine, as Tier A', async () => {
    // Position before Qxf7# in Scholar's Mate.
    const chess = new Chess()
    for (const m of ['e4', 'e5', 'Qh5', 'Nc6', 'Bc4', 'Nf6']) chess.move(m)
    const fen = chess.fen()
    // Engine only asked about the pre-move position; the post-move is terminal.
    const analyser = new FakeAnalyser({
      [fen]: { score: { type: 'cp', value: 900 }, bestMove: 'h5f7' },
    })
    const g = await evaluateAndGrade(analyser, fen, 'Qxf7#')
    expect(g.playedScoreMover).toEqual({ type: 'mate', value: 1 })
    expect(g.grade.tier).toBe('A')
    expect(g.grade.swing).toBe(0)
  })
})

// ---------- the continuation after your move (#151) ----------

describe('the line after the move you played', () => {
  it('keeps the second search’s pv instead of dropping it, and adds no third search', async () => {
    const fen = START
    const after = afterFen(fen, 'a3')
    const analyser = new FakeAnalyser({
      [fen]: { score: { type: 'cp', value: 30 }, bestMove: 'g1f3', pv: ['g1f3', 'd7d5'] },
      // Black to move after 1.a3, and the engine says how it punishes it.
      [after]: { score: { type: 'cp', value: 280 }, bestMove: 'e7e5', pv: ['e7e5', 'e2e4', 'g8f6'] },
    })
    const g = await evaluateAndGrade(analyser, fen, 'a3')

    expect(g.afterPv).toEqual(['e7e5', 'e2e4', 'g8f6'])
    // The whole point of #151: the continuation is already paid for. Two
    // searches — the position, then the position after the move — and a third
    // would be a 50% cost increase on every committed move.
    expect(analyser.searches).toEqual([fen, after])
  })

  it('falls back to the best move alone when the adapter reports no pv', async () => {
    const fen = START
    const analyser = new FakeAnalyser({
      [fen]: { score: { type: 'cp', value: 30 }, bestMove: 'g1f3' },
      [afterFen(fen, 'a3')]: { score: { type: 'cp', value: 280 }, bestMove: 'e7e5' },
    })
    const g = await evaluateAndGrade(analyser, fen, 'a3')
    expect(g.afterPv).toEqual(['e7e5'])
  })

  it('has no continuation after a move that ended the game', async () => {
    const chess = new Chess()
    for (const m of ['e4', 'e5', 'Qh5', 'Nc6', 'Bc4', 'Nf6']) chess.move(m)
    const fen = chess.fen()
    const analyser = new FakeAnalyser({
      [fen]: { score: { type: 'cp', value: 900 }, bestMove: 'h5f7', pv: ['h5f7'] },
    })
    const g = await evaluateAndGrade(analyser, fen, 'Qxf7#')
    expect(g.afterPv).toEqual([])
    expect(analyser.searches).toEqual([fen]) // terminal: never asked at all
  })
})
