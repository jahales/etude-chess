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

/** Maia-1 rating levels (each is a separate net). */
export const MAIA_LEVELS = [1100, 1200, 1300, 1400, 1500, 1600, 1700, 1800, 1900] as const
export type MaiaLevel = (typeof MAIA_LEVELS)[number]

/** The levels v0.2 ships (fetched by scripts/setup-maia.mjs) — a bracket around ~1200 USCF. */
export const SHIPPED_LEVELS = [1100, 1300, 1500] as const satisfies readonly MaiaLevel[]
export const DEFAULT_LEVEL: MaiaLevel = 1300

export interface MaiaMoveOpts {
  /** 0 ≈ argmax (strongest human move); higher samples the policy for variety. */
  temperature?: number
  /** Prior positions, most-recent-first, for the net's history planes. */
  history?: readonly string[]
}

export interface MaiaOpponent {
  /** Ready when the model is loaded and a first inference can run. */
  ready(): Promise<void>
  /** The full legal-move policy for a FEN, ranked best-first. */
  policy(fen: string, opts?: MaiaMoveOpts): Promise<MaiaMove[]>
  /** Pick a move for a FEN (argmax by default; sample when temperature > 0). */
  move(fen: string, opts?: MaiaMoveOpts): Promise<MaiaMove>
  dispose(): void
}
