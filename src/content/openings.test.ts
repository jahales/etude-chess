import { describe, it, expect } from 'vitest'
import { detectOpening } from './openings'
import { GAMES } from './games'
import { parseGame } from '../domain/harness'

describe('detectOpening', () => {
  it('names the pack games correctly (longest prefix wins)', () => {
    const opening = (id: string) =>
      detectOpening(parseGame(GAMES.find((g) => g.id === id)!.pgn).sanMoves)
    expect(opening('opera-1858')).toBe('Philidor Defense')
    expect(opening('evergreen-1852')).toBe('Evans Gambit')
    expect(opening('immortal-1851')).toBe("King's Gambit Accepted, Bishop's Gambit")
  })

  it('prefers the most specific match', () => {
    expect(detectOpening(['e4', 'e5', 'Nf3', 'Nc6', 'Bb5'])).toBe('Ruy Lopez')
    expect(detectOpening(['e4', 'e5', 'Nf3'])).toBe("King's Knight Opening")
    expect(detectOpening(['e4', 'c5', 'Nf3'])).toBe('Sicilian Defense')
  })

  it('returns null when nothing matches', () => {
    expect(detectOpening([])).toBeNull()
    expect(detectOpening(['g4'])).toBeNull()
  })
})
