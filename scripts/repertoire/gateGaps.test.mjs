import { describe, it, expect } from 'vitest'
import { Chess } from 'chess.js'
import { replayDecision } from './gateGaps.mjs'
import { createSoundnessGate } from './soundness.mjs'

const START = new Chess().fen()
const cp = (v) => ({ type: 'cp', value: v })

const fenAfter = (san) => {
  const c = new Chess()
  c.move(san)
  return c.fen()
}

const stats = (san, uci, games) => ({ san, uci, white: games, draws: 0, black: 0 })
const book = (table) => ({ query: async (fen) => table[fen] ?? { moves: [] } })
const indexed = (table) => ({ query: (fen) => table[fen] ?? null })
/** Sorted best-first, as the real index always is — lines[0] is the best move. */
const pos = (lines, depth = 50) => {
  const sorted = [...lines].sort((a, b) => b.score.value - a.score.value)
  return {
    lines: sorted.map((l, i) => ({ multipv: i + 1, score: l.score, pv: [l.uci] })),
    bestMove: sorted[0]?.uci ?? null,
    depth,
    knodes: 1,
  }
}

const OPTS = { maxEval: 20, massTarget: 0.85, maxReplies: 6, minCanonGames: 50 }

/** Two candidates, both sound; e2e4 forces fewer replies so ranking prefers it. */
function scenario({ e4Score = cp(30), d4Score = cp(28), e4Replies = 1, d4Replies = 5 } = {}) {
  const canon = book({
    [START]: { moves: [stats('d4', 'd2d4', 6000), stats('e4', 'e2e4', 4000)] },
  })
  const band = book({
    [fenAfter('e4')]: { moves: Array.from({ length: e4Replies }, (_, i) => stats(`r${i}`, `a7a${6 - i}`, 500)) },
    [fenAfter('d4')]: { moves: Array.from({ length: d4Replies }, (_, i) => stats(`s${i}`, `a7a${6 - i}`, 500)) },
  })
  const gate = createSoundnessGate({
    evalDb: indexed({ [START]: pos([{ uci: 'e2e4', score: e4Score }, { uci: 'd2d4', score: d4Score }]) }),
  })
  return { gate, canon, band, opts: OPTS }
}

describe('replayDecision', () => {
  it('reports no change when the deep gate agrees with what we play', async () => {
    const r = await replayDecision({ fen: START, uci: 'e2e4' }, scenario())
    expect(r.considered).toBe(2)
    expect(r.sound).toBe(2)
    expect(r.ourStillSound).toBe(true)
    expect(r.wouldChoose).toBe('e2e4')
    expect(r.changes).toBe(false)
  })

  it('flags a change when the ranking prefers a different survivor', async () => {
    // Both sound, but d2d4 now forces fewer replies, so branching cost wins.
    const r = await replayDecision({ fen: START, uci: 'e2e4' }, scenario({ e4Replies: 6, d4Replies: 1 }))
    expect(r.ourStillSound).toBe(true)
    expect(r.wouldChoose).toBe('d2d4')
    expect(r.changes).toBe(true)
  })

  it('marks our move unsound when the deep gate rejects it', async () => {
    const r = await replayDecision({ fen: START, uci: 'e2e4' }, scenario({ e4Score: cp(-400) }))
    expect(r.ourStillSound).toBe(false)
    expect(r.sound).toBe(1)
    expect(r.wouldChoose).toBe('d2d4')
    expect(r.changes).toBe(true)
  })

  it('leaves out candidates the index cannot score rather than waving them through', async () => {
    // The gate is handed an infinite fallback, so an unscored candidate must be
    // counted and dropped — not admitted on a number from another source.
    const s = scenario()
    s.gate = createSoundnessGate({ evalDb: indexed({}) })
    const r = await replayDecision({ fen: START, uci: 'e2e4' }, s)
    expect(r.skipped).toMatch(/could score/)
    expect(r.unscored).toBe(2)
  })

  it('skips a position the canon book has never seen', async () => {
    const s = scenario()
    s.canon = book({})
    const r = await replayDecision({ fen: START, uci: 'e2e4' }, s)
    expect(r.skipped).toMatch(/too thin/)
  })

  it('drops a candidate whose child the band book barely knows', async () => {
    // Low branching from sparse data is not low branching — the ranking would
    // otherwise reward obscurity, as MIN_GAMES_TO_TRUST_BRANCHING documents.
    const s = scenario({ e4Replies: 1, d4Replies: 5 })
    s.band = book({
      [fenAfter('e4')]: { moves: [{ san: 'a6', uci: 'a7a6', white: 3, draws: 0, black: 0 }] },
      [fenAfter('d4')]: { moves: Array.from({ length: 5 }, (_, i) => stats(`s${i}`, `a7a${6 - i}`, 500)) },
    })
    const r = await replayDecision({ fen: START, uci: 'd2d4' }, s)
    // e2e4 looked narrowest, on three games. It must not be rankable at all.
    expect(r.untrusted).toBe(1)
    expect(r.skipped).toMatch(/only one rankable/)
  })
})
