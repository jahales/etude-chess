// Lightweight opening detection (#5): match a game's SAN move prefix against a
// compact table of common named openings, longest match wins. Not a full ECO
// database (that arrives with game import); enough to name the pack + common lines.

interface OpeningEntry {
  name: string
  moves: string[]
}

const OPENINGS: OpeningEntry[] = [
  // 1.e4 e5
  { name: 'Open Game', moves: ['e4', 'e5'] },
  { name: "King's Knight Opening", moves: ['e4', 'e5', 'Nf3'] },
  { name: 'Philidor Defense', moves: ['e4', 'e5', 'Nf3', 'd6'] },
  { name: "Petrov's Defense", moves: ['e4', 'e5', 'Nf3', 'Nf6'] },
  { name: 'Italian Game', moves: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4'] },
  { name: 'Italian Game, Giuoco Piano', moves: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5'] },
  { name: 'Evans Gambit', moves: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'b4'] },
  { name: 'Two Knights Defense', moves: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Nf6'] },
  { name: 'Ruy Lopez', moves: ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5'] },
  { name: 'Scotch Game', moves: ['e4', 'e5', 'Nf3', 'Nc6', 'd4'] },
  { name: 'Vienna Game', moves: ['e4', 'e5', 'Nc3'] },
  { name: "King's Gambit", moves: ['e4', 'e5', 'f4'] },
  { name: "King's Gambit Accepted", moves: ['e4', 'e5', 'f4', 'exf4'] },
  { name: "King's Gambit Accepted, Bishop's Gambit", moves: ['e4', 'e5', 'f4', 'exf4', 'Bc4'] },
  // Other 1.e4
  { name: 'Sicilian Defense', moves: ['e4', 'c5'] },
  { name: 'French Defense', moves: ['e4', 'e6'] },
  { name: 'Caro-Kann Defense', moves: ['e4', 'c6'] },
  { name: 'Scandinavian Defense', moves: ['e4', 'd5'] },
  { name: 'Pirc Defense', moves: ['e4', 'd6'] },
  // 1.d4
  { name: "Queen's Pawn Game", moves: ['d4', 'd5'] },
  { name: "Queen's Gambit", moves: ['d4', 'd5', 'c4'] },
  { name: "Queen's Gambit Declined", moves: ['d4', 'd5', 'c4', 'e6'] },
  { name: "Queen's Gambit Accepted", moves: ['d4', 'd5', 'c4', 'dxc4'] },
  { name: 'Slav Defense', moves: ['d4', 'd5', 'c4', 'c6'] },
  { name: 'London System', moves: ['d4', 'd5', 'Bf4'] },
  { name: 'Indian Defense', moves: ['d4', 'Nf6'] },
  { name: "King's Indian Defense", moves: ['d4', 'Nf6', 'c4', 'g6'] },
  { name: 'Nimzo-Indian Defense', moves: ['d4', 'Nf6', 'c4', 'e6', 'Nc3', 'Bb4'] },
  // Flank
  { name: 'English Opening', moves: ['c4'] },
  { name: 'Réti Opening', moves: ['Nf3'] },
]

/** The most specific named opening whose moves are a prefix of the game, or null. */
export function detectOpening(sanMoves: string[]): string | null {
  let best: OpeningEntry | null = null
  for (const entry of OPENINGS) {
    if (entry.moves.length > sanMoves.length) continue
    if (entry.moves.every((m, i) => m === sanMoves[i])) {
      if (!best || entry.moves.length > best.moves.length) best = entry
    }
  }
  return best?.name ?? null
}
