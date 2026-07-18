import type { Color, Tier } from '../domain/types'

export const TIER_TEXT: Record<Tier, string> = {
  A: 'Well played',
  B: 'Inaccuracy',
  C: 'Mistake',
}

export const TIER_CLASS: Record<Tier, string> = {
  A: 'tier-a',
  B: 'tier-b',
  C: 'tier-c',
}

// Reveal-arrow colours: master (green), engine best (blue), your move (amber).
export const ARROW_MASTER = '#3e7d57'
export const ARROW_ENGINE = '#2a6a87'
export const ARROW_USER = '#b0821f'

export function uciSquares(uci: string): { from: string; to: string } {
  return { from: uci.slice(0, 2), to: uci.slice(2, 4) }
}

export function sideName(c: Color): string {
  return c === 'w' ? 'White' : 'Black'
}

export function moveLabel(moveNumber: number, side: Color): string {
  return side === 'w' ? `${moveNumber}.` : `${moveNumber}…`
}
