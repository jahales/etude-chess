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

// Reveal-arrow colours: the move played in the game (green), engine best (blue),
// your move (amber). The green one is only a *master's* move when the game came
// from the curated pack — `domain/moveSource.ts` is what says which, and it says
// it in words rather than in colours. `ARROW_MASTER` keeps its v0.1.0 name
// because renaming a constant is not what #158 was about; the colours did not
// move and neither did which arrow is which.
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
