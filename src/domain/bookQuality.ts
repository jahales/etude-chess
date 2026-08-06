// Data-quality audit for a generated opening book (ADR 0021, issue #88).
//
// Why this module exists: of the defects found while building the generator,
// **none** were caught by the unit tests and **every one** produced a
// plausible-looking result rather than an error. A book built from 3% of the
// games looks exactly like a book built from all of them; move statistics split
// across `Bf5` and `Bf5?!` look exactly like two legitimate moves. Logic tests
// cannot see any of that — only assertions against the data itself can.
//
// So these checks run over a finished book and assert the things that must be
// true of *any* real chess database, regardless of rating band or month.
//
// Pure, and runtime-import-free, so scripts/repertoire/ can load it directly.

/** Wins / draws / losses from White's point of view, as the book stores them. */
export type Tally = [number, number, number]
/** fenKey → SAN → tally. */
export type BookPositions = Record<string, Record<string, Tally>>

export interface QualityIssue {
  /** `error` means the book is wrong; `warn` means it looks odd but may be fine. */
  severity: 'error' | 'warn'
  check: string
  detail: string
}

/** The initial position, in the same four-field form the book keys on. */
export const START_KEY = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -'

/**
 * First moves that dominate every real chess database. Shares vary a lot by
 * rating band — club players push e4 far more than masters do — so we assert
 * only what holds everywhere rather than pinning percentages that would make
 * this check band-specific and useless.
 */
export const MAIN_FIRST_MOVES = ['e4', 'd4', 'Nf3', 'c4'] as const
/** Those four together, in any population of real games. */
export const MAIN_FIRST_MOVE_FLOOR = 0.8
/** Each of 1.e4 and 1.d4 individually. */
export const MAJOR_FIRST_MOVE_FLOOR = 0.1

const total = (t: Tally): number => t[0] + t[1] + t[2]

/** Games recorded at one position. */
export function positionGames(node: Record<string, Tally>): number {
  return Object.values(node).reduce((sum, t) => sum + total(t), 0)
}

/**
 * SAN carrying an evaluation glyph. PGN in the wild is full of these, and using
 * the raw token as a key splits one move's record in two — worst on exactly the
 * bad-but-popular moves that `?` and `??` get attached to, which is the trap
 * detector's whole target population.
 */
export function annotatedKeys(positions: BookPositions): string[] {
  const found = new Set<string>()
  for (const node of Object.values(positions)) {
    for (const san of Object.keys(node)) {
      if (/[?!]/.test(san)) found.add(san)
    }
  }
  return [...found]
}

/** Share of each first move, for eyeballing as well as asserting. */
export function firstMoveShares(positions: BookPositions): Record<string, number> {
  const node = positions[START_KEY]
  if (!node) return {}
  const games = positionGames(node)
  if (games === 0) return {}
  const shares: Record<string, number> = {}
  for (const [san, t] of Object.entries(node)) shares[san] = total(t) / games
  return shares
}

/**
 * Audit a finished book. Returns everything wrong with it; an empty array means
 * it passed. Ordered errors first.
 */
export function auditBook(positions: BookPositions): QualityIssue[] {
  const issues: QualityIssue[] = []
  const keys = Object.keys(positions)

  if (keys.length === 0) {
    return [{ severity: 'error', check: 'non-empty', detail: 'book contains no positions' }]
  }

  const annotated = annotatedKeys(positions)
  if (annotated.length) {
    issues.push({
      severity: 'error',
      check: 'canonical-san',
      detail:
        `${annotated.length} move key(s) carry an evaluation glyph, so their statistics are ` +
        `split from the same move's unannotated entry: ${annotated.slice(0, 6).join(', ')}`,
    })
  }

  let emptyNodes = 0
  let badTallies = 0
  for (const node of Object.values(positions)) {
    if (Object.keys(node).length === 0) emptyNodes++
    for (const t of Object.values(node)) {
      if (t.length !== 3 || t.some((n) => !Number.isInteger(n) || n < 0)) badTallies++
    }
  }
  if (emptyNodes) {
    issues.push({
      severity: 'warn',
      check: 'no-empty-positions',
      detail: `${emptyNodes} position(s) have no moves — pruning should have removed them`,
    })
  }
  if (badTallies) {
    issues.push({
      severity: 'error',
      check: 'well-formed-tallies',
      detail: `${badTallies} tally/tallies are not three non-negative integers`,
    })
  }

  // The start position is the one place we know what the answer has to look
  // like, which makes it the cheapest detector of a truncated or mis-parsed
  // scan. A book built from a fraction of a month still gets this right; a book
  // built from garbage does not.
  const shares = firstMoveShares(positions)
  if (Object.keys(shares).length === 0) {
    issues.push({
      severity: 'warn',
      check: 'start-position-present',
      detail: 'the initial position is absent, so first-move sanity could not be checked',
    })
  } else {
    const mainShare = MAIN_FIRST_MOVES.reduce((sum, san) => sum + (shares[san] ?? 0), 0)
    if (mainShare < MAIN_FIRST_MOVE_FLOOR) {
      issues.push({
        severity: 'error',
        check: 'first-move-distribution',
        detail:
          `e4/d4/Nf3/c4 account for only ${(mainShare * 100).toFixed(1)}% of first moves ` +
          `(expected at least ${MAIN_FIRST_MOVE_FLOOR * 100}%) — the scan is probably mis-parsed`,
      })
    }
    // Only a *warning*, unlike the combined check above. A book built from a
    // narrow corpus — a 1.d4-only repertoire export, a Dutch Defence
    // collection — legitimately has almost no 1.e4, and failing that as an
    // error would reject a correct book while blaming a parsing bug that isn't
    // there. The combined e4/d4/Nf3/c4 floor stays an error because it survives
    // any narrowing: a d4-only book still puts ~100% on d4.
    for (const san of ['e4', 'd4']) {
      const share = shares[san] ?? 0
      if (share < MAJOR_FIRST_MOVE_FLOOR) {
        issues.push({
          severity: 'warn',
          check: 'first-move-distribution',
          detail:
            `1.${san} is only ${(share * 100).toFixed(1)}% of first moves ` +
            `(expected ≥ ${MAJOR_FIRST_MOVE_FLOOR * 100}% for a broad corpus; normal for a single-opening database)`,
        })
      }
    }
  }

  return issues.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1))
}

/**
 * Compare the games a scan claims to have used against the games actually
 * recorded at the start position. A large shortfall means games were dropped
 * somewhere between filtering and recording.
 */
export function recordedVsClaimed(
  positions: BookPositions,
  gamesUsed: number,
): { recorded: number; claimed: number; ratio: number } {
  const node = positions[START_KEY]
  const recorded = node ? positionGames(node) : 0
  return { recorded, claimed: gamesUsed, ratio: gamesUsed === 0 ? 0 : recorded / gamesUsed }
}
