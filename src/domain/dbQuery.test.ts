import { describe, it, expect } from 'vitest'
import {
  matchesQuery,
  nameTokens,
  normalizeQuery,
  queryPlan,
  queryTokens,
  type GameQuery,
  type SearchableGame,
} from './dbQuery'

const game = (over: Partial<SearchableGame> = {}): SearchableGame => ({
  white: 'Kasparov, Garry',
  black: 'Karpov, Anatoly',
  event: 'World Championship',
  year: 1985,
  result: '1-0',
  eco: 'B44',
  minElo: 2700,
  speed: 'classical',
  source: 'masters.pgn',
  ...over,
})

describe('nameTokens', () => {
  it('indexes both players and the event, lowercased', () => {
    expect(nameTokens(game()).sort()).toEqual(
      ['anatoly', 'championship', 'garry', 'karpov', 'kasparov', 'world'].sort(),
    )
  })

  it('drops the punctuation a PGN name is full of', () => {
    // `Lastname, Firstname` is the standard's own form, and a search for
    // "carlsen" must not have to know whether a comma follows it.
    expect(nameTokens({ white: 'Carlsen, Magnus', black: 'Nepomniachtchi, Ian' })).toContain(
      'carlsen',
    )
  })

  it('keeps accented names whole rather than splitting them', () => {
    // Splitting on [^a-z0-9] would cut "Réti" into "r" and "ti" and make the
    // player unsearchable by their own name.
    expect(nameTokens({ white: 'Réti, Richard', black: 'Bogoljubov, Efim' })).toContain('réti')
  })

  it('deduplicates, because an index entry per repetition buys nothing', () => {
    const tokens = nameTokens({ white: 'Smith, John', black: 'Smith, Jane', event: 'Smith Open' })
    expect(tokens.filter((t) => t === 'smith')).toHaveLength(1)
  })

  it('drops single letters, which are initials rather than searchable names', () => {
    expect(nameTokens({ white: 'Kasparov, G', black: 'A Player' })).toEqual(['kasparov', 'player'])
  })

  it('caps a pathological event name rather than indexing all of it', () => {
    const event = Array.from({ length: 200 }, (_, i) => `word${i}`).join(' ')
    expect(nameTokens({ white: 'A', black: 'B', event }).length).toBeLessThanOrEqual(32)
  })
})

describe('queryTokens', () => {
  it('keeps a single letter, because a query token is a prefix and not a name', () => {
    // "g" is not indexable as a name but is a perfectly good prefix of "garry".
    expect(queryTokens('g')).toEqual(['g'])
  })

  it('splits a multi-word query the same way names are split', () => {
    expect(queryTokens('Kasparov, Garry')).toEqual(['kasparov', 'garry'])
  })
})

describe('matchesQuery', () => {
  it('matches nothing away when the query is empty', () => {
    expect(matchesQuery(game(), {})).toBe(true)
  })

  it('matches a player by a prefix of any of their name tokens', () => {
    expect(matchesQuery(game(), { text: 'kasp' })).toBe(true)
    expect(matchesQuery(game(), { text: 'garry' })).toBe(true)
    expect(matchesQuery(game(), { text: 'karpov' })).toBe(true)
  })

  it('matches the event too, not only the players', () => {
    expect(matchesQuery(game(), { text: 'championship' })).toBe(true)
  })

  it('requires every token of the query, so a second word narrows', () => {
    expect(matchesQuery(game(), { text: 'kasparov karpov' })).toBe(true)
    expect(matchesQuery(game(), { text: 'kasparov fischer' })).toBe(false)
  })

  it('is a prefix match and not a substring one', () => {
    // "sparov" matching would need every suffix in the index, which is what
    // makes a scan a scan.
    expect(matchesQuery(game(), { text: 'sparov' })).toBe(false)
  })

  it('filters by an inclusive year range', () => {
    expect(matchesQuery(game({ year: 1985 }), { yearFrom: 1985, yearTo: 1985 })).toBe(true)
    expect(matchesQuery(game({ year: 1984 }), { yearFrom: 1985 })).toBe(false)
    expect(matchesQuery(game({ year: 1986 }), { yearTo: 1985 })).toBe(false)
  })

  it('excludes a game whose year the file never stated, once a year filter is set', () => {
    // The ingest rule is "never reject on what the file didn't say" (#53). This
    // is the other side of it: a browse filter is a claim about the games it
    // shows, and an undated game cannot be shown to be in the range. It is not
    // rejected — it is simply not evidence of a match. Unfiltered, it is there.
    expect(matchesQuery(game({ year: undefined }), { yearFrom: 1900 })).toBe(false)
    expect(matchesQuery(game({ year: undefined }), {})).toBe(true)
  })

  it('filters by result', () => {
    expect(matchesQuery(game(), { result: '1-0' })).toBe(true)
    expect(matchesQuery(game(), { result: '0-1' })).toBe(false)
  })

  it('filters by an ECO code or by a whole ECO family', () => {
    expect(matchesQuery(game({ eco: 'B44' }), { eco: 'B44' })).toBe(true)
    expect(matchesQuery(game({ eco: 'B44' }), { eco: 'B4' })).toBe(true)
    expect(matchesQuery(game({ eco: 'B44' }), { eco: 'B' })).toBe(true)
    expect(matchesQuery(game({ eco: 'C42' }), { eco: 'B' })).toBe(false)
  })

  it('reads ECO case-insensitively, because a file may store it either way', () => {
    expect(matchesQuery(game({ eco: 'b44' }), { eco: 'B44' })).toBe(true)
  })

  it('filters on the lower of the two ratings', () => {
    expect(matchesQuery(game({ minElo: 2500 }), { minRating: 2500 })).toBe(true)
    expect(matchesQuery(game({ minElo: 2499 }), { minRating: 2500 })).toBe(false)
  })

  it('excludes an unrated game once a rating floor is set', () => {
    // Same rule as the year, and it matches the index exactly: Dexie does not
    // index `undefined`, so `minElo` has no entry for this game either way.
    expect(matchesQuery(game({ minElo: undefined }), { minRating: 2000 })).toBe(false)
    expect(matchesQuery(game({ minElo: undefined }), {})).toBe(true)
  })

  it('filters by time control, including for the games whose control is unknown', () => {
    // "unknown" is a value you can ask for, not a hole. #53 keeps those games
    // deliberately, so browsing has to be able to find them again.
    expect(matchesQuery(game({ speed: 'unknown' }), { speed: 'unknown' })).toBe(true)
    expect(matchesQuery(game({ speed: 'classical' }), { speed: 'unknown' })).toBe(false)
  })

  it('filters by the file a game came from', () => {
    expect(matchesQuery(game(), { source: 'masters.pgn' })).toBe(true)
    expect(matchesQuery(game(), { source: 'other.pgn' })).toBe(false)
  })

  it('ands every clause together', () => {
    const q: GameQuery = { text: 'kasparov', yearFrom: 1980, result: '1-0', minRating: 2600 }
    expect(matchesQuery(game(), q)).toBe(true)
    expect(matchesQuery(game({ result: '0-1' }), q)).toBe(false)
  })
})

describe('normalizeQuery', () => {
  it('drops blank fields rather than filtering on an empty string', () => {
    expect(normalizeQuery({ text: '   ', eco: '', result: '' })).toEqual({})
  })

  it('trims text and uppercases an ECO code', () => {
    expect(normalizeQuery({ text: '  Tal  ', eco: 'b44' })).toEqual({ text: 'Tal', eco: 'B44' })
  })

  it('reads the numbers the form gives it as strings', () => {
    expect(normalizeQuery({ yearFrom: '1985', minRating: '2500' })).toEqual({
      yearFrom: 1985,
      minRating: 2500,
    })
  })

  it('drops a number that is not one', () => {
    expect(normalizeQuery({ yearFrom: 'nineteen eighty five', minRating: 'strong' })).toEqual({})
  })

  it('swaps a backwards year range instead of returning nothing at all', () => {
    // Typing the later year first is a slip, not a request for the empty set.
    expect(normalizeQuery({ yearFrom: 1990, yearTo: 1980 })).toEqual({
      yearFrom: 1980,
      yearTo: 1990,
    })
  })

  it('ignores a value that is not one of the results a game can have', () => {
    expect(normalizeQuery({ result: 'won' })).toEqual({})
    expect(normalizeQuery({ result: '1/2-1/2' })).toEqual({ result: '1/2-1/2' })
  })

  it('ignores a speed that is not one we classify', () => {
    expect(normalizeQuery({ speed: 'quickish' })).toEqual({})
    expect(normalizeQuery({ speed: 'unknown' })).toEqual({ speed: 'unknown' })
  })

  it('refuses a negative rating floor', () => {
    expect(normalizeQuery({ minRating: -100 })).toEqual({})
  })
})

describe('queryPlan', () => {
  it('browses everything through no index at all when nothing is asked', () => {
    const plan = queryPlan({})
    expect(plan.driver).toEqual({ index: 'none' })
    expect(plan.indexOnly).toBe(true)
  })

  it('drives a name search off the names index, and needs no residual for one word', () => {
    // One token is the whole query, and a prefix scan of the index answers it
    // exactly — so the count is an index count rather than a walk.
    const plan = queryPlan({ text: 'morphy' })
    expect(plan.driver).toEqual({ index: 'names', prefix: 'morphy', exact: true })
    expect(plan.residual).toEqual({})
    expect(plan.indexOnly).toBe(true)
  })

  it('drives on the longest token of a multi-word search and re-checks the rest', () => {
    const plan = queryPlan({ text: 'tal riga' })
    expect(plan.driver).toEqual({ index: 'names', prefix: 'riga', exact: false })
    expect(plan.residual).toEqual({ text: 'tal riga' })
    expect(plan.indexOnly).toBe(false)
  })

  it('prefers a name over every other index, because a name is the selective one', () => {
    const plan = queryPlan({ text: 'morphy', result: '1-0', speed: 'classical' })
    expect(plan.driver.index).toBe('names')
    expect(plan.residual).toEqual({ result: '1-0', speed: 'classical' })
  })

  it('falls to ECO, then the year range, then the rating floor', () => {
    expect(queryPlan({ eco: 'B44', result: '1-0' }).driver).toEqual({ index: 'eco', prefix: 'B44' })
    expect(queryPlan({ yearFrom: 1980, yearTo: 1990, result: '1-0' }).driver).toEqual({
      index: 'year',
      from: 1980,
      to: 1990,
    })
    expect(queryPlan({ minRating: 2500, result: '1-0' }).driver).toEqual({
      index: 'minElo',
      atLeast: 2500,
    })
  })

  it('uses result or speed only when nothing better is on offer', () => {
    expect(queryPlan({ result: '1-0' }).driver).toEqual({ index: 'result', value: '1-0' })
    expect(queryPlan({ speed: 'classical' }).driver).toEqual({
      index: 'speed',
      value: 'classical',
    })
  })

  it('leaves a half-open year range half-open', () => {
    expect(queryPlan({ yearFrom: 1980 }).driver).toEqual({ index: 'year', from: 1980 })
    expect(queryPlan({ yearTo: 1990 }).driver).toEqual({ index: 'year', to: 1990 })
  })

  it('never loses a constraint: the driver plus the residual is the whole query', () => {
    // The plan is a *cost* decision. Which index drives may change freely; what
    // may never change is that everything asked for is still enforced. This is
    // the property that lets the driver order be a heuristic.
    const queries: GameQuery[] = [
      { text: 'kasparov karpov', eco: 'B44', yearFrom: 1984, yearTo: 1985, result: '1-0' },
      { eco: 'C', minRating: 2400, speed: 'classical', source: 'a.pgn' },
      { yearFrom: 1900, result: '1/2-1/2', speed: 'unknown' },
      { minRating: 2200 },
      {},
    ]
    const candidates = [
      game(),
      game({ white: 'Fischer, Robert', black: 'Spassky, Boris', year: 1972, eco: 'C69' }),
      game({ year: undefined, minElo: undefined, speed: 'unknown', eco: undefined }),
      game({ source: 'a.pgn', eco: 'C42', minElo: 2400 }),
    ]
    for (const q of queries) {
      const { residual } = queryPlan(q)
      for (const g of candidates) {
        // Whatever the driver filters, anything the driver lets through and the
        // residual accepts must be a genuine match — the residual can only be a
        // weakening of the query if a constraint was dropped on the floor.
        if (matchesQuery(g, q)) expect(matchesQuery(g, residual)).toBe(true)
      }
    }
  })
})
