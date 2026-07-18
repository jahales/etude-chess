// Tuneable analysis settings (#6). Kept pure and separate so the presets are
// testable and the hook just holds one of these in state.

export interface AnalysisSettings {
  /** Node budget for grading + the alternatives (reproducible; never movetime). */
  nodes: number
  /** Number of engine lines shown on the reveal. */
  multipv: number
}

export interface StrengthPreset {
  id: string
  label: string
  nodes: number
}

export const STRENGTH_PRESETS: StrengthPreset[] = [
  { id: 'fast', label: 'Fast', nodes: 300_000 },
  { id: 'balanced', label: 'Balanced', nodes: 700_000 },
  { id: 'deep', label: 'Deep', nodes: 1_500_000 },
]

export const MULTIPV_OPTIONS = [1, 2, 3, 4, 5] as const

export const DEFAULT_SETTINGS: AnalysisSettings = { nodes: 700_000, multipv: 3 }

/** The preset whose node budget matches, or 'balanced' as the fallback label. */
export function presetIdForNodes(nodes: number): string {
  return STRENGTH_PRESETS.find((p) => p.nodes === nodes)?.id ?? 'balanced'
}

/** Node budget for the fast live "who's ahead" bar — never heavier than a strength preset. */
export function liveEvalNodes(settings: AnalysisSettings): number {
  return Math.min(settings.nodes, 300_000)
}
