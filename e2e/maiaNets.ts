import { existsSync } from 'node:fs'

/**
 * The Maia nets are too large to commit, so specs that play a game skip when
 * they're absent — convenient locally, and a trap in CI.
 *
 * It was a trap: with no nets in CI, **4 of 7 e2e specs skipped there** while
 * merges were gated on the resulting green check. Every Maia path, the
 * library/replay path and the whole-game analysis path went unverified.
 *
 * So the skip is now conditional on *not* being required. `REQUIRE_MAIA_NETS=1`
 * (set in CI) turns a missing net into a loud failure at global setup, before a
 * single test runs.
 */
export const MAIA_LEVELS = [1100, 1300, 1500, 1700, 1900] as const

export const maiaNetPaths = MAIA_LEVELS.map((level) => `public/models/maia-${level}.onnx`)

export const missingMaiaNets = maiaNetPaths.filter((path) => !existsSync(path))

export const hasMaiaNets = missingMaiaNets.length === 0

/** Skip reason for specs that need a net. Empty string when they can run. */
export const MAIA_SKIP_REASON = hasMaiaNets
  ? ''
  : 'run `node scripts/setup-maia.mjs` to fetch the Maia nets'
