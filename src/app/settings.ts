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

// ---------- who you are (#130) ----------

/**
 * The names you play under, so a game out of the database can be recognised as
 * yours and studied from your own side.
 *
 * A list, and one name per line: the name on a game is whatever the file that
 * recorded it wrote down — a site writes your handle, an export you made by hand
 * writes `Lastname, Firstname`. That comma is why lines and not commas separate
 * them. Whether a name matches a game is `domain/studyGame.yourSide`; this is
 * only the list and where it is kept.
 *
 * There is no default and there never will be one: the owner's handle is theirs
 * to publish, so it is typed at runtime and stays on the machine that typed it.
 */
export const PLAYER_NAMES_KEY = 'etude-chess:player-names'

/** The field's text → the list, cleaned. Blank lines and case-repeats are dropped. */
export function parsePlayerNames(input: string): string[] {
  const seen = new Set<string>()
  return input
    .split('\n')
    .map((line) => line.trim())
    .filter((name) => {
      // Matching ignores case, so two spellings of one name are one name — and
      // showing it twice in the field would invite editing one and not the other.
      const key = name.toLowerCase()
      if (!name || seen.has(key)) return false
      seen.add(key)
      return true
    })
}

/** The list → the field's text. */
export function formatPlayerNames(names: readonly string[]): string {
  return names.join('\n')
}

/**
 * Read the names back, best-effort.
 *
 * `localStorage` rather than the IndexedDB adapter the game records live in:
 * this is a two-line preference, and it is read *synchronously* while deciding
 * which side a study control offers — a screen that awaited a database read
 * would have to render the wrong side first and then correct itself. Never
 * throws: an embedded context can refuse storage outright, and a stored value
 * can be anything, so an unreadable one means "no names recorded" rather than a
 * study screen that won't open.
 */
export function loadPlayerNames(): string[] {
  try {
    const raw = localStorage.getItem(PLAYER_NAMES_KEY)
    if (!raw) return []
    const stored: unknown = JSON.parse(raw)
    if (!Array.isArray(stored)) return []
    // Re-cleaned on the way in, not just on the way out, so a value written by
    // hand or by an older version can't put a blank name in front of the matcher.
    return parsePlayerNames(stored.filter((n): n is string => typeof n === 'string').join('\n'))
  } catch {
    return []
  }
}

/** Keep the names for next time. Clearing them removes the key rather than storing nothing. */
export function savePlayerNames(names: readonly string[]): void {
  try {
    if (names.length === 0) localStorage.removeItem(PLAYER_NAMES_KEY)
    else localStorage.setItem(PLAYER_NAMES_KEY, JSON.stringify(names))
  } catch {
    // Storage full or refused (Safari private browsing throws here). The names
    // still work for this session; they just won't outlive it.
  }
}
