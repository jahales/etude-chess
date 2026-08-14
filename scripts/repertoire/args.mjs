// Command-line argument handling for the repertoire scripts (issue #115).
//
// One parser, so there is one answer to "is a typo an error?".
//
// These three functions lived in `build.mjs`, and every script that wanted them
// imported them from there — every script except `crawl.mjs`, which is the one
// you invoke by hand and the one that costs hours of Stockfish to get wrong. It
// could not: `build.mjs` imports `crawl.mjs` for `crawl` and `DEFAULTS`, and
// reads `DEFAULTS.minPly` at module scope, so `import … from './build.mjs'`
// inside `crawl.mjs` closes a cycle that kills `node crawl.mjs` before it
// parses a flag:
//
//     ReferenceError: Cannot access 'DEFAULTS' before initialization
//
// So the parser moved down here, below both of them, where nothing has to
// import a crawler to read a flag. `build.mjs` keeps `FLAGS`; every entry point
// keeps its own list and passes it in.

/**
 * Parses `--flag value` pairs, and rejects flags it does not know.
 *
 * A silently-dropped `--trap 0.01` runs the whole build at the default and
 * reports success — the same shape of failure as every other defect this
 * pipeline has produced, and an hour of engine time to discover.
 *
 * `known` is required rather than defaulted. A default list would have to be
 * one entry point's, and quietly validating `crawl.mjs`'s flags against
 * `build.mjs`'s is how the two drifted apart in the first place.
 */
export function parseArgs(argv, known) {
  if (!Array.isArray(known)) {
    throw new Error('parseArgs needs the caller’s list of known flags — see FLAGS in build.mjs or crawl.mjs')
  }
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) throw new Error(`unexpected argument "${a}" — every option takes a --flag`)
    const key = a.slice(2)
    if (!known.includes(key)) {
      throw new Error(`unknown option --${key}. Known: ${known.map((k) => `--${k}`).join(' ')}`)
    }
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) out[key] = true
    else {
      out[key] = next
      i++
    }
  }
  return out
}

/**
 * A flag that takes a number, or nothing at all.
 *
 * `parseArgs` marks a valueless flag `true`, and `Number(true)` is 1 — so
 * `--trap --nodes 120000` silently ran the whole build at a trap threshold of
 * 1, found nothing, and reported success. `Number('abc')` is NaN, which reached
 * Stockfish as `go nodes NaN`. Rejecting flags it does not know was only half
 * the job; this is the other half.
 *
 * Values arrive from argv as strings, so `--trap 0` is `'0'` — truthy, and
 * returned here as 0 rather than falling back to the default. That is the
 * behaviour, and `crawl.test.mjs` pins it.
 */
export function numberFlag(args, key) {
  const raw = args[key]
  if (raw === undefined) return undefined
  const value = Number(raw)
  if (raw === true || !Number.isFinite(value)) {
    throw new Error(`--${key} needs a number${raw === true ? ' — its value is missing' : `, got "${raw}"`}`)
  }
  return value
}

/** A flag that takes a string. A bare `--out` made a directory called "true". */
export function stringFlag(args, key) {
  const raw = args[key]
  if (raw === undefined) return undefined
  if (raw === true) throw new Error(`--${key} needs a value`)
  return String(raw)
}

/**
 * Spread a crawl option only when the flag was given, so defaults still apply.
 *
 * `crawl()` merges with `{ ...DEFAULTS, ...config }`, and a spread does not skip
 * an explicit `undefined` — it overwrites with it. So `{ maxPly: undefined }`
 * does not mean "use the default", it means *no cap*, and `crawl.mjs`'s CLI
 * passed exactly that for every numeric option it was not given: no depth cap,
 * no floor, no `minNodeGames`, no trap threshold. On a stub book that dries up
 * at move 14 it expanded 2,837 nodes with zero terminal positions of any kind,
 * against 223 nodes and 47 quiet targets once the keys are omitted instead.
 */
export const maybe = (key, value) => (value === undefined ? {} : { [key]: value })

/**
 * Every `--flag` named in a HELP string.
 *
 * The help text is the only description of a flag most runs ever see, and on a
 * parser that rejects what it does not know, a flag missing from `--help` reads
 * as a flag that does not exist — while a flag in `--help` that the parser has
 * never heard of turns a correct invocation into a hard error. Both directions
 * are asserted in the tests; this is what they compare.
 */
export function flagsNamedIn(help) {
  return [...new Set([...help.matchAll(/--[a-z][a-z0-9-]*/g)].map((m) => m[0].slice(2)))].sort()
}
