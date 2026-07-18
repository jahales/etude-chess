import { describe, it, expect } from 'vitest'
import { flipUciMove, policyIndexFor, decodePolicy } from './decoding'
import { POLICY_INDEX, POLICY_SIZE } from './policyIndex'

describe('flipUciMove', () => {
  it('mirrors ranks and keeps files', () => {
    expect(flipUciMove('e7e5')).toBe('e2e4')
    expect(flipUciMove('e2e4')).toBe('e7e5')
    expect(flipUciMove('a7a8q')).toBe('a2a1q') // preserves promotion suffix
  })
})

describe('policyIndexFor', () => {
  it('maps white moves directly to the Lc0 index', () => {
    expect(policyIndexFor('e2e4', false)).toBe(POLICY_INDEX.indexOf('e2e4'))
    expect(policyIndexFor('e1g1', false)).toBe(POLICY_INDEX.indexOf('e1g1'))
  })

  it('flips black moves before lookup', () => {
    // e7e5 as black → e2e4 in the mover frame
    expect(policyIndexFor('e7e5', true)).toBe(POLICY_INDEX.indexOf('e2e4'))
  })

  it('maps knight-promotion to the plain 4-char slot', () => {
    expect(policyIndexFor('a7a8n', false)).toBe(POLICY_INDEX.indexOf('a7a8'))
  })

  it('keeps q/r/b promotions as explicit 5-char entries', () => {
    expect(policyIndexFor('a7a8q', false)).toBe(POLICY_INDEX.indexOf('a7a8q'))
    expect(POLICY_INDEX.indexOf('a7a8q')).toBeGreaterThanOrEqual(0)
  })
})

describe('decodePolicy', () => {
  it('ranks legal moves and normalizes probabilities to ~1', () => {
    const fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
    const policy = new Float32Array(POLICY_SIZE) // all zeros → uniform over legal moves
    const ranked = decodePolicy(policy, fen)
    expect(ranked).toHaveLength(20) // 16 pawn + 4 knight moves
    const total = ranked.reduce((s, m) => s + m.prob, 0)
    expect(total).toBeCloseTo(1, 5)
  })

  it('puts the highest-logit legal move first', () => {
    const fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
    const policy = new Float32Array(POLICY_SIZE)
    policy[POLICY_INDEX.indexOf('e2e4')] = 10
    const ranked = decodePolicy(policy, fen, { temperature: 0.1 })
    expect(ranked[0]?.uci).toBe('e2e4')
    expect(ranked[0]?.prob).toBeGreaterThan(0.9)
  })

  it('returns [] when there are no legal moves (checkmate)', () => {
    const mate = 'rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3' // fool's mate
    expect(decodePolicy(new Float32Array(POLICY_SIZE), mate)).toEqual([])
  })
})
