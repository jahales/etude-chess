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
  /**
   * The principal variation behind `score`, as UCI moves from the position that
   * was evaluated — `pv[0]` is `bestMove`. It is what the search already knew
   * and used to throw away (#151): the *continuation* is the only thing that
   * explains a score with no material in it.
   *
   * **Optional, and absent means "not reported", never "no line"** — the same
   * rule stored records follow. An adapter that cannot report one (or a fake in
   * a test) leaves it out, so a caller must handle its absence rather than
   * treating an empty line as a claim about the position.
   */
  pv?: string[]
}
