import { describe, it, expect } from 'vitest'
import type { Color, Tier } from './types'
import type { KeyMoment, KeyMoments } from './keyMoments'
import type { StudyGame } from './studyGame'
import {
  CRITICAL_START_PLY,
  criticalOffer,
  orderForReview,
  reviewPriority,
  type ReviewCandidate,
} from './reviewPlan'

// ---------- ordering ----------

const row = (over: Partial<ReviewCandidate> = {}): ReviewCandidate => ({
  key: 'k',
  result: '1-0',
  yours: 'w',
  analysed: false,
  ...over,
})

describe('reviewPriority — whose result it was', () => {
  it('reads the result from your side, both colours', () => {
    expect(reviewPriority({ result: '1-0', yours: 'w' })).toBe('won')
    expect(reviewPriority({ result: '1-0', yours: 'b' })).toBe('lost')
    expect(reviewPriority({ result: '0-1', yours: 'b' })).toBe('won')
    expect(reviewPriority({ result: '0-1', yours: 'w' })).toBe('lost')
  })

  it('puts a draw and an unfinished game together — neither is a loss or a win', () => {
    expect(reviewPriority({ result: '1/2-1/2', yours: 'w' })).toBe('undecided')
    expect(reviewPriority({ result: '*', yours: 'b' })).toBe('undecided')
  })

  // The point of the bucket: with no side known, calling a result a loss would
  // be inventing the one fact the ordering rests on.
  it('says nothing about a game it cannot tell is yours', () => {
    expect(reviewPriority({ result: '1-0', yours: null })).toBe('not-yours')
    expect(reviewPriority({ result: '0-1', yours: null })).toBe('not-yours')
  })
})

describe('orderForReview', () => {
  it('puts your losses first, then draws, then wins, then games that are not yours', () => {
    const ordered = orderForReview([
      row({ key: 'won', result: '1-0', yours: 'w' }),
      row({ key: 'theirs', yours: null }),
      row({ key: 'lost', result: '0-1', yours: 'w' }),
      row({ key: 'drawn', result: '1/2-1/2', yours: 'w' }),
    ])
    expect(ordered.map((g) => g.key)).toEqual(['lost', 'drawn', 'won', 'theirs'])
  })

  it('breaks a tie with the work not yet done', () => {
    const ordered = orderForReview([
      row({ key: 'done', result: '0-1', yours: 'w', analysed: true }),
      row({ key: 'todo', result: '0-1', yours: 'w', analysed: false }),
    ])
    expect(ordered.map((g) => g.key)).toEqual(['todo', 'done'])
  })

  // The result answers "has this game something to teach"; "analysed" only
  // answers "has the work been done". A won game is still a won game.
  it('lets the result outrank the analysis state', () => {
    const ordered = orderForReview([
      row({ key: 'won-todo', result: '1-0', yours: 'w', analysed: false }),
      row({ key: 'lost-done', result: '0-1', yours: 'w', analysed: true }),
    ])
    expect(ordered.map((g) => g.key)).toEqual(['lost-done', 'won-todo'])
  })

  it('is stable, so equal games keep the order the index returned them in', () => {
    const ordered = orderForReview([
      row({ key: 'a', result: '0-1', yours: 'w' }),
      row({ key: 'b', result: '0-1', yours: 'w' }),
      row({ key: 'c', result: '0-1', yours: 'w' }),
    ])
    expect(ordered.map((g) => g.key)).toEqual(['a', 'b', 'c'])
  })

  it('collapses to unanalysed-first when no game can be told to be yours', () => {
    const ordered = orderForReview([
      row({ key: 'done', yours: null, analysed: true }),
      row({ key: 'todo', yours: null, analysed: false }),
    ])
    expect(ordered.map((g) => g.key)).toEqual(['todo', 'done'])
  })

  it('does not mutate what it was given', () => {
    const input = [row({ key: 'won' }), row({ key: 'lost', result: '0-1' })]
    orderForReview(input)
    expect(input.map((g) => g.key)).toEqual(['won', 'lost'])
  })
})

// ---------- the critical-positions offer ----------

/**
 * A real game, because `criticalOffer` replays it: Morphy's Opera game. The
 * plies used below are White's, so they are even.
 */
const OPERA_PGN = `[Event "Paris Opera"]
[White "Paul Morphy"]
[Black "Duke Karl / Count Isouard"]
[Result "1-0"]

1. e4 e5 2. Nf3 d6 3. d4 Bg4 4. dxe5 Bxf3 5. Qxf3 dxe5 6. Bc4 Nf6 7. Qb3 Qe7
8. Nc3 c6 9. Bg5 b5 10. Nxb5 cxb5 11. Bxb5+ Nbd7 12. O-O-O Rd8 13. Rxd7 Rxd7
14. Rd1 Qe6 15. Bxd7+ Nxd7 16. Qb8+ Nxb8 17. Rd8# 1-0`

const studyGame = (over: Partial<StudyGame> = {}): StudyGame => ({
  id: 'db:opera',
  title: 'Paul Morphy vs Duke Karl',
  blurb: 'White won',
  pgn: OPERA_PGN,
  heroColor: 'w',
  ...over,
})

const moment = (ply: number, tier: Tier = 'C', swing = 20): KeyMoment => ({
  ply,
  san: 'x',
  reason: tier === 'C' ? 'blunder' : 'mistake',
  swing,
  tier,
})

const found = (over: Partial<KeyMoments> = {}): KeyMoments => ({
  moments: [],
  measured: 20,
  total: 20,
  complete: true,
  ...over,
})

describe('criticalOffer — coverage before list', () => {
  // The failure the whole module exists to prevent: six positions chosen out of
  // a game whose actual blunder was never scored.
  it('refuses when nothing was measured, and calls it not-analysed', () => {
    const offer = criticalOffer(studyGame(), found({ measured: 0, total: 20, complete: false }))
    expect(offer).toMatchObject({ ok: false, reason: 'not-analysed', measured: 0, total: 20 })
  })

  it('refuses a partial pass even when it did find moments, and hands them back anyway', () => {
    const moments = [moment(10)]
    const offer = criticalOffer(
      studyGame(),
      found({ moments, measured: 8, total: 20, complete: false }),
    )
    expect(offer).toMatchObject({ ok: false, reason: 'partial', measured: 8, total: 20 })
    // Real findings, so they are not thrown away — they are just not "the
    // positions that decided this game".
    expect(offer.ok === false && offer.moments).toEqual(moments)
  })

  it('separates "measured everything and you played clean" from "not measured"', () => {
    const offer = criticalOffer(studyGame(), found({ moments: [], measured: 20, total: 20 }))
    expect(offer).toMatchObject({ ok: false, reason: 'clean', measured: 20, total: 20 })
  })
})

describe('criticalOffer — which positions can be asked', () => {
  it('offers the moment plies in playing order, keeping the ranking on the moments', () => {
    // Worst first is how `selectKeyMoments` returns them; the session runs forwards.
    const moments = [moment(20, 'C', 30), moment(10, 'B', 8)]
    const offer = criticalOffer(studyGame(), found({ moments }))
    expect(offer.ok).toBe(true)
    if (!offer.ok) return
    expect(offer.plies).toEqual([10, 20])
    expect(offer.moments.map((m) => m.ply)).toEqual([20, 10])
    expect(offer.positions).toBe(2)
    expect(offer.unaskable).toBe(0)
  })

  // A blunder on move three is exactly what a review is for; the opening cutoff
  // is a rule about moves nobody asked you to choose.
  it('keeps a moment inside the opening cutoff', () => {
    expect(CRITICAL_START_PLY).toBe(0)
    const offer = criticalOffer(studyGame(), found({ moments: [moment(4)] }))
    expect(offer.ok).toBe(true)
    if (!offer.ok) return
    expect(offer.plies).toEqual([4])
  })

  it('drops a ply that is not the hero side and counts it as unaskable', () => {
    // Ply 11 is Black's; the hero here is White.
    const offer = criticalOffer(studyGame(), found({ moments: [moment(10), moment(11)] }))
    expect(offer.ok).toBe(true)
    if (!offer.ok) return
    expect(offer.plies).toEqual([10])
    expect(offer.unaskable).toBe(1)
  })

  it('refuses when no moment survives as a question at all', () => {
    const offer = criticalOffer(studyGame(), found({ moments: [moment(11)] }))
    expect(offer).toMatchObject({ ok: false, reason: 'unquizzable' })
  })

  it('refuses rather than throwing on movetext that does not replay', () => {
    const offer = criticalOffer(
      studyGame({ pgn: '[Result "*"]\n\n1. e4 e5 2. Ke2 Qh4 3. Nonsense' }),
      found({ moments: [moment(4)] }),
    )
    expect(offer).toMatchObject({ ok: false, reason: 'unquizzable' })
  })

  it('carries the coverage through onto an offer that succeeds', () => {
    const offer = criticalOffer(
      studyGame(),
      found({ moments: [moment(10)], measured: 17, total: 17 }),
    )
    expect(offer).toMatchObject({ ok: true, measured: 17, total: 17 })
  })
})

describe('criticalOffer — whose side', () => {
  it('reads the hero side off the study game rather than the result', () => {
    // Same game, Black's side: ply 11 is now askable and ply 10 is not.
    const black: Color = 'b'
    const offer = criticalOffer(
      studyGame({ heroColor: black }),
      found({ moments: [moment(10), moment(11)] }),
    )
    expect(offer.ok).toBe(true)
    if (!offer.ok) return
    expect(offer.plies).toEqual([11])
  })
})
