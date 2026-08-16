// Core domain types shared across the grading, fact-bundle, and harness modules.

/** A Stockfish score, always from the side-to-move's perspective. */
export type Score =
  | { type: 'cp'; value: number } // centipawns
  | { type: 'mate'; value: number } // mate in N; sign = side to move; 0 = already mated

/** Move-quality tier. A = as good as best, B = a concession, C = a mistake/blunder. */
export type Tier = 'A' | 'B' | 'C'

/**
 * Win/draw/loss expectancy in permille, from the side to move, as Stockfish
 * reports it when `UCI_ShowWDL` is on. The three always sum to 1000.
 *
 * This answers a different question from the score, and in a decided position it
 * is the better one: +4.9 and +4.3 are indistinguishable results, while
 * `1000/0/0` and `600/400/0` are not the same position at all. That distinction
 * is what the `game-review` skill §4 tells a reader to check before calling a
 * win% swing decisive, and `domain/resultCategory.ts` is where it becomes a rule.
 *
 * In the domain rather than beside the UCI parser that produces it, because the
 * dependency runs domain ← app ← adapters (ADR 0015): `EngineEvaluation` carries
 * one, so the domain has to own the word. `engine/uci.ts` re-exports it for the
 * adapters that only ever see the parser.
 */
export interface Wdl {
  win: number
  draw: number
  loss: number
}

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
  /**
   * Win/draw/loss for the position, from the side to move — the same
   * perspective as `score`.
   *
   * **Optional on the same terms as `pv`**: absent means "the adapter did not
   * report one", never "the result is not in doubt". Only an adapter that has
   * turned `UCI_ShowWDL` on fills it in, so a caller must handle its absence
   * rather than reading a missing value as a decided position — which is the
   * exact inversion of the truth.
   */
  wdl?: Wdl
}
