// Core domain types shared across the grading, fact-bundle, and harness modules.

/** A Stockfish score, always from the side-to-move's perspective. */
export type Score =
  | { type: 'cp'; value: number } // centipawns
  | { type: 'mate'; value: number } // mate in N; sign = side to move; 0 = already mated

/** Move-quality tier. A = as good as best, B = a concession, C = a mistake/blunder. */
export type Tier = 'A' | 'B' | 'C'

export type Color = 'w' | 'b'

/** One engine evaluation of a position. `bestMove` is UCI/LAN (e.g. "e2e4", "e7e8q"). */
export interface EngineEvaluation {
  score: Score
  bestMove: string | null
}
