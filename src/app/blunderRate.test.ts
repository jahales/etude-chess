import { describe, it, expect } from 'vitest'
import { gameBlunders, blunderRateOf } from './blunderRate'
import { BATCH_NODES } from './gameAnalysis'
import { MIN_GAMES_FOR_SIGNAL } from '../domain/blunderRate'
import type { StoredGame } from '../persist/db'
import type { PositionEval } from '../domain/gameRecord'

const ev = (whitePct: number): PositionEval => ({ whitePct, label: `${whitePct}` })

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

/** A game with a completed pass over it, from the eval after each ply. */
function analysed(pcts: number[], over: Partial<StoredGame> = {}): StoredGame {
  return game({
    sanHistory: pcts.map((_, i) => `m${i}`),
    analysedAt: 1,
    analysisNodes: BATCH_NODES,
    startEval: ev(50),
    evalByPly: pcts.map(ev),
    ...over,
  })
}

describe('gameBlunders — one game, or a reason it cannot be counted', () => {
  it('counts your moves that gave up 30 win% or more', () => {
    // As White: ply 0 50→52 (fine), ply 2 48→10 (−38, a blunder).
    const r = gameBlunders(analysed([52, 48, 10, 12]))
    expect(r).toMatchObject({ counted: true, blunders: 1, yourMoves: 2 })
  })

  it('ignores the opponent’s blunders', () => {
    // Ply 1 collapses for Black (52→90 in White's favour). It is not your move.
    const r = gameBlunders(analysed([52, 90, 88, 89]))
    expect(r).toMatchObject({ counted: true, blunders: 0, yourMoves: 2 })
  })

  it('reads the swing from your own side when you played Black', () => {
    // Plies 1 and 3 are yours. Ply 3 runs 40→85 White, so Black gave up 45.
    const r = gameBlunders(analysed([50, 48, 40, 85], { yourColor: 'b' }))
    expect(r).toMatchObject({ counted: true, blunders: 1, yourMoves: 2 })
  })

  it('refuses a game that was never analysed', () => {
    // The whole point of #65: a rate over the coach log alone counts only the
    // moves the coach finished grading, which are the early ones.
    expect(gameBlunders(game({ coachLog: [] }))).toEqual({
      counted: false,
      reason: 'not analysed',
    })
  })

  it('refuses a game analysed at a different budget', () => {
    const stale = analysed([52, 48, 10, 12], { analysisNodes: 40_000 })
    expect(gameBlunders(stale)).toMatchObject({ counted: false, reason: 'not analysed' })
  })

  it('refuses a completed pass that still left one of your moves unmeasured', () => {
    // A gap, or a missing startEval, means a move of yours has no swing. Counting
    // the rest would report a rate over an unstated subset — the #74 failure.
    const gap = analysed([52, 48, 10, 12], { evalByPly: [ev(52), ev(48), undefined, ev(12)] })
    expect(gameBlunders(gap)).toMatchObject({ counted: false, reason: 'partly measured' })

    const noStart = analysed([52, 48, 10, 12], { startEval: undefined })
    expect(gameBlunders(noStart)).toMatchObject({ counted: false, reason: 'partly measured' })
  })

  it('refuses a play-out, which is not a game you played from move 1', () => {
    // A play-out (#48) starts mid-game, so ply parity no longer tells us who
    // moved — we would be counting the opponent's blunders as yours — and
    // "per game" over a fragment is not the quantity being measured anyway.
    const r = gameBlunders(analysed([52, 48, 10, 12], { kind: 'playout' }))
    expect(r).toMatchObject({ counted: false, reason: 'play-out' })
  })

  it('refuses a game in which you never moved', () => {
    // Zero blunders over zero moves is not a clean game; counting it would pull
    // the rate down with a game that contains no evidence about you.
    const r = gameBlunders(analysed([50], { yourColor: 'b' }))
    expect(r).toMatchObject({ counted: false, reason: 'no moves of yours' })
  })

  it('never throws on a record written before any of these fields existed', () => {
    expect(gameBlunders(game({ evalByPly: undefined, coachLog: undefined }))).toMatchObject({
      counted: false,
    })
  })
})

describe('blunderRateOf — the rate across your library', () => {
  it('averages over the analysed games and counts the rest as uncounted', () => {
    const rate = blunderRateOf([
      analysed([52, 48, 10, 12]), // 1 blunder
      analysed([52, 48, 47, 46]), // 0
      game(), // never analysed
    ])
    expect(rate.games).toBe(2)
    expect(rate.blunders).toBe(1)
    expect(rate.perGame).toBe(0.5)
    expect(rate.uncounted).toBe(1)
  })

  it('reports no rate when nothing has been analysed', () => {
    const rate = blunderRateOf([game(), game(), game()])
    expect(rate.perGame).toBeUndefined()
    expect(rate.uncounted).toBe(3)
  })

  it('reports no rate over an empty library', () => {
    expect(blunderRateOf([]).perGame).toBeUndefined()
  })

  it('flags the thin sample the owner actually has', () => {
    const few = Array.from({ length: 3 }, () => analysed([52, 48, 10, 12]))
    expect(blunderRateOf(few).smallSample).toBe(true)

    const enough = Array.from({ length: MIN_GAMES_FOR_SIGNAL }, () => analysed([52, 48, 10, 12]))
    expect(blunderRateOf(enough).smallSample).toBe(false)
  })
})
