import { hasMaiaNets, missingMaiaNets } from './maiaNets'

/**
 * Fail the whole run, before any test, when the Maia nets are required but
 * absent — rather than letting every spec that needs them quietly skip.
 *
 * A skipped test and a passing test look identical on a green check. That is how
 * 4 of 7 specs went unverified in CI while merges were gated on it.
 */
export default function globalSetup() {
  if (process.env.REQUIRE_MAIA_NETS !== '1' || hasMaiaNets) return

  throw new Error(
    [
      'REQUIRE_MAIA_NETS=1 but the Maia nets are missing:',
      ...missingMaiaNets.map((path) => `  - ${path}`),
      '',
      'Specs that play a game would silently skip, so this run is failed instead.',
      'Fetch them with: node scripts/setup-maia.mjs',
    ].join('\n'),
  )
}
