// The MaiaOpponent port — the human-like opponent behind an interface, exactly as
// grading depends only on the Analyser port (docs/architecture.md, ADR 0010/0015).
// The onnxruntime-web + Web Worker implementation (maiaOpponent.ts) is the adapter;
// app/domain code depends only on this interface, never on onnxruntime or the Worker.

export interface MaiaMove {
  /** UCI move in real board coordinates. */
  uci: string
  /** Policy probability among legal moves. */
  prob: number
}

/** Maia-1 rating levels (each is a separate net). The spike ships 1900 only. */
export const MAIA_LEVELS = [1100, 1200, 1300, 1400, 1500, 1600, 1700, 1800, 1900] as const
export type MaiaLevel = (typeof MAIA_LEVELS)[number]

export interface MaiaOpponent {
  /** Ready when the model is loaded and a first inference can run. */
  ready(): Promise<void>
  /** The full legal-move policy for a FEN, ranked best-first. */
  policy(fen: string): Promise<MaiaMove[]>
  /**
   * Pick a move for a FEN. `temperature` 0 ≈ argmax (strongest human move);
   * higher samples from the policy for natural variety.
   */
  move(fen: string, opts?: { temperature?: number }): Promise<MaiaMove>
  dispose(): void
}
