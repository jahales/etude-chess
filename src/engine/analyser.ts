import type { EngineEvaluation, Score } from '../domain/types'

// The engine abstraction (docs/decisions/0010): grading logic depends only on
// this interface, never on the Worker. StockfishAnalyser (stockfish.ts) is the
// v0.1.0 implementation; a native or Maia adapter can drop in later.

export interface AnalyseOptions {
  nodes?: number
  depth?: number
  movetime?: number
}

/** One ranked engine line (for the reveal's alternatives panel, #1). */
export interface AnalysisLine {
  /** MultiPV rank, 1 = best. */
  multipv: number
  /** Score from the side-to-move's perspective. */
  score: Score
  /** Principal variation as UCI moves. */
  pv: string[]
}

export interface Analyser {
  /** Evaluate a position. `score` is from the side-to-move's perspective. */
  evaluate(fen: string, opts?: AnalyseOptions): Promise<EngineEvaluation>
  /** Top-N lines for the position, best first. */
  analyseLines(fen: string, opts?: AnalyseOptions & { multipv?: number }): Promise<AnalysisLine[]>
  dispose(): void
}

// Fixed nodes → reproducible grades across machines (never movetime for grading).
export const DEFAULT_NODES = 700_000
export const DEFAULT_ENGINE_URL = '/engine/stockfish-18-lite-single.js'

/** Build the UCI `go` limit clause. Nodes/depth are reproducible; movetime is not. */
export function limitString(opts: AnalyseOptions): string {
  if (opts.nodes) return `nodes ${opts.nodes}`
  if (opts.depth) return `depth ${opts.depth}`
  if (opts.movetime) return `movetime ${opts.movetime}`
  return `nodes ${DEFAULT_NODES}`
}
