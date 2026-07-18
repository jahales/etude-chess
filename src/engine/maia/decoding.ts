// Maia-1 / Lc0 policy output → ranked legal moves.
//
// Part of the GPL-licensed Maia adapter, kept arm's-length behind the MaiaOpponent
// port. Pure: no engine/IO/React. See public/models/NOTICE.md.
//
// The network emits 1858 logits in POLICY_INDEX order, from the mover's perspective.
// We mask to legal moves, map each to its policy index (flipping ranks for black,
// and treating knight-promotion as the plain 4-char slot), then softmax.

import { Chess } from 'chess.js'
import { POLICY_INDEX_MAP } from './policyIndex'

export interface ScoredMove {
  /** UCI move in real board coordinates (not perspective-flipped). */
  uci: string
  /** Normalized probability among legal moves (softmax of masked logits). */
  prob: number
}

/** Flip a UCI move's ranks (files unchanged), preserving any promotion suffix. */
export function flipUciMove(uci: string): string {
  const flip = (sq: string) => sq[0] + String(9 - Number(sq[1]))
  return flip(uci.slice(0, 2)) + flip(uci.slice(2, 4)) + uci.slice(4)
}

/** The policy index for a legal move given side-to-move, or undefined if unmapped. */
export function policyIndexFor(uci: string, blackToMove: boolean): number | undefined {
  let canonical = blackToMove ? flipUciMove(uci) : uci
  if (canonical.length === 5 && canonical[4] === 'n') canonical = canonical.slice(0, 4) // knight-promo
  return POLICY_INDEX_MAP.get(canonical)
}

/**
 * Decode a policy vector into legal moves ranked by probability (highest first).
 * `temperature` shapes the softmax: 1 = raw policy, <1 sharpens, →0 ≈ argmax.
 */
export function decodePolicy(
  policy: ArrayLike<number>,
  fen: string,
  opts: { temperature?: number } = {},
): ScoredMove[] {
  const temperature = opts.temperature ?? 1
  const blackToMove = fen.split(' ')[1] === 'b'
  const legal = new Chess(fen).moves({ verbose: true })

  const raw: { uci: string; logit: number }[] = []
  for (const mv of legal) {
    const uci = mv.from + mv.to + (mv.promotion ?? '')
    const idx = policyIndexFor(uci, blackToMove)
    if (idx === undefined) continue
    raw.push({ uci, logit: policy[idx] ?? 0 })
  }
  if (raw.length === 0) return []

  const t = Math.max(temperature, 1e-3)
  const maxLogit = Math.max(...raw.map((r) => r.logit))
  let sum = 0
  const exps = raw.map((r) => {
    const e = Math.exp((r.logit - maxLogit) / t)
    sum += e
    return e
  })
  return raw
    .map((r, i) => ({ uci: r.uci, prob: (exps[i] ?? 0) / sum }))
    .sort((a, b) => b.prob - a.prob)
}
