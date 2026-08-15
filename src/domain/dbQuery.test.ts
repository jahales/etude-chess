import { describe, it, expect } from 'vitest'
import {
  BY_PREFIX,
  matchesQuery,
  nameTokens,
  normalizeQuery,
  queryPlan,
  queryTokens,
  resolveQuery,
  tokenize,
  type GameQuery,
  type ResolvedQuery,
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

/** A query resolved the way it is when there is no search index: every word a prefix. */
const byPrefix = (query: GameQuery): ResolvedQuery => resolveQuery(query, BY_PREFIX)

/** A query resolved against a stubbed index. The fuzzy matcher is injected as data. */
const resolvedWith = (query: GameQuery, index: Record<string, string[] | null>): ResolvedQuery =>
  resolveQuery(query, (term) => (term in index ? index[term]! : null))

describe('tokenize', () => {
  it('splits on everything that is not a letter or a digit', () => {
    expect(tokenize('Kasparov, Garry')).toEqual(['kasparov', 'garry'])
    expect(tokenize('Vachier-Lagrave, M.')).toEqual(['vachier', 'lagrave', 'm'])
  })

  it('keeps accented letters whole rather than splitting them', () => {
    // Splitting on [^a-z0-9] would cut "Réti" into "r" and "ti" and make the
    // player unsearchable by his own name.
    expect(tokenize('Réti, Richard')).toEqual(['réti', 'richard'])
  })
})

describe('nameTokens', () => {
  it('indexes both players and the event, lowercased', () => {
    expect(nameTokens(game()).sort()).toEqual(
      ['anatoly', 'championship', 'garry', 'karpov', 'kasparov', 'world'].sort(),
    )
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
  it('keeps a single letter, because a query word is matched as a prefix', () => {
    expect(queryTokens('g')).toEqual(['g'])
  })

  it('splits a multi-word query the same way names are split', () => {
    expect(queryTokens('Kasparov, Garry')).toEqual(['kasparov', 'garry'])
  })
})

describe('resolveQuery', () => {
  it('separates the free text from the structured filters', () => {
    const resolved = byPrefix({ text: 'tal', result: '1-0', minRating: 2500 })
    expect(resolved.filters).toEqual({ result: '1-0', minRating: 2500 })
    expect(resolved.terms).toEqual([{ term: 'tal', tokens: null }])
  })

  it('asks the expander once per word', () => {
    const asked: string[] = []
    resolveQuery({ text: 'Kasparov Karpov' }, (t) => {
      asked.push(t)
      return [t]
    })
    expect(asked).toEqual(['kasparov', 'karpov'])
  })

  it('has no terms at all when nothing was typed', () => {
    expect(byPrefix({ result: '1-0' }).terms).toEqual([])
  })
})

describe('matchesQuery', () => {
  it('matches nothing away when the query is empty', () => {
    expect(matchesQuery(game(), byPrefix({}))).toBe(true)
  })

  it('matches a player by a prefix of any of their name tokens', () => {
    expect(matchesQuery(game(), byPrefix({ text: 'kasp' }))).toBe(true)
    expect(matchesQuery(game(), byPrefix({ text: 'garry' }))).toBe(true)
    expect(matchesQuery(game(), byPrefix({ text: 'karpov' }))).toBe(true)
  })

  it('matches the event too, not only the players', () => {
    expect(matchesQuery(game(), byPrefix({ text: 'championship' }))).toBe(true)
  })

  it('matches a spelling the search index resolved to, prefix or not', () => {
    // The case the whole dependency exists for. `aljechin` and `alekhine` share
    // no prefix, so nothing this module could do on its own would connect them —
    // the index says they are the same word and this honours that.
    const alekhine = game({ white: 'Aljechin, A.', black: 'Bogoljubow, E.' })
    const resolved = resolvedWith({ text: 'alekhine' }, { alekhine: ['alekhine', 'aljechin'] })
    expect(matchesQuery(alekhine, resolved)).toBe(true)
  })

  it('an enumerated word is exact, not a prefix', () => {
    // Once the index has enumerated the tokens, matching a *prefix* of one of
    // them would let through games the count never counted.
    const resolved = resolvedWith({ text: 'kasp' }, { kasp: ['kasparov'] })
    expect(matchesQuery(game(), resolved)).toBe(true)
    expect(matchesQuery(game({ white: 'Kasparyan, G' }), resolved)).toBe(false)
  })

  it('requires every word of the query, so a second word narrows', () => {
    expect(matchesQuery(game(), byPrefix({ text: 'kasparov karpov' }))).toBe(true)
    expect(matchesQuery(game(), byPrefix({ text: 'kasparov fischer' }))).toBe(false)
  })

  it('is a prefix match and not a substring one', () => {
    expect(matchesQuery(game(), byPrefix({ text: 'sparov' }))).toBe(false)
  })

  it('filters by an inclusive year range', () => {
    expect(matchesQuery(game({ year: 1985 }), byPrefix({ yearFrom: 1985, yearTo: 1985 }))).toBe(true)
    expect(matchesQuery(game({ year: 1984 }), byPrefix({ yearFrom: 1985 }))).toBe(false)
    expect(matchesQuery(game({ year: 1986 }), byPrefix({ yearTo: 1985 }))).toBe(false)
  })

  it('excludes a game whose year the file never stated, once a year filter is set', () => {
    // The ingest rule is "never reject on what the file didn't say" (#53). This
    // is the other side of it: a browse filter is a claim about the games it
    // shows, and an undated game cannot be shown to be in the range. It is not
    // rejected — it is simply not evidence of a match. Unfiltered, it is there.
    expect(matchesQuery(game({ year: undefined }), byPrefix({ yearFrom: 1900 }))).toBe(false)
    expect(matchesQuery(game({ year: undefined }), byPrefix({}))).toBe(true)
  })

  it('filters by result', () => {
    expect(matchesQuery(game(), byPrefix({ result: '1-0' }))).toBe(true)
    expect(matchesQuery(game(), byPrefix({ result: '0-1' }))).toBe(false)
  })

  it('filters by an ECO code or by a whole ECO family, either case', () => {
    expect(matchesQuery(game({ eco: 'B44' }), byPrefix({ eco: 'B44' }))).toBe(true)
    expect(matchesQuery(game({ eco: 'B44' }), byPrefix({ eco: 'B' }))).toBe(true)
    expect(matchesQuery(game({ eco: 'C42' }), byPrefix({ eco: 'B' }))).toBe(false)
    expect(matchesQuery(game({ eco: 'b44' }), byPrefix({ eco: 'B44' }))).toBe(true)
  })

  it('filters on the lower of the two ratings', () => {
    expect(matchesQuery(game({ minElo: 2500 }), byPrefix({ minRating: 2500 }))).toBe(true)
    expect(matchesQuery(game({ minElo: 2499 }), byPrefix({ minRating: 2500 }))).toBe(false)
  })

  it('excludes an unrated game once a rating floor is set', () => {
    // Same rule as the year, and it matches the index exactly: Dexie does not
    // index `undefined`, so `minElo` has no entry for this game either way.
    expect(matchesQuery(game({ minElo: undefined }), byPrefix({ minRating: 2000 }))).toBe(false)
    expect(matchesQuery(game({ minElo: undefined }), byPrefix({}))).toBe(true)
  })

  it('filters by time control, including for the games whose control is unknown', () => {
    // "unknown" is a value you can ask for, not a hole. #53 keeps those games
    // deliberately, so browsing has to be able to find them again.
    expect(matchesQuery(game({ speed: 'unknown' }), byPrefix({ speed: 'unknown' }))).toBe(true)
    expect(matchesQuery(game({ speed: 'classical' }), byPrefix({ speed: 'unknown' }))).toBe(false)
  })

  it('filters by the file a game came from', () => {
    expect(matchesQuery(game(), byPrefix({ source: 'masters.pgn' }))).toBe(true)
    expect(matchesQuery(game(), byPrefix({ source: 'other.pgn' }))).toBe(false)
  })

  it('ands every clause together', () => {
    const q: GameQuery = { text: 'kasparov', yearFrom: 1980, result: '1-0', minRating: 2600 }
    expect(matchesQuery(game(), byPrefix(q))).toBe(true)
    expect(matchesQuery(game({ result: '0-1' }), byPrefix(q))).toBe(false)
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
    const plan = queryPlan(byPrefix({}))
    expect(plan.driver).toEqual({ index: 'none' })
    expect(plan.indexOnly).toBe(true)
  })

  it('looks up the resolved tokens of a single word directly', () => {
    const plan = queryPlan(resolvedWith({ text: 'alekhine' }, { alekhine: ['alekhine', 'aljechin'] }))
    expect(plan.driver).toEqual({ index: 'names', tokens: ['alekhine', 'aljechin'] })
    expect(plan.indexOnly).toBe(true)
  })

  it('drives on the word with the fewest tokens, which is the selective one', () => {
    // Not a guess: the index counted them. This is the one place the planner
    // knows more than a heuristic.
    const plan = queryPlan(
      resolvedWith({ text: 'tal riga' }, { tal: ['tal', 'talj'], riga: ['riga'] }),
    )
    expect(plan.driver).toEqual({ index: 'names', tokens: ['riga'] })
    expect(plan.residual.terms).toEqual([{ term: 'tal', tokens: ['tal', 'talj'] }])
    expect(plan.indexOnly).toBe(false)
  })

  it('walks a prefix range for a word the index would not enumerate', () => {
    const plan = queryPlan(byPrefix({ text: 'ka' }))
    expect(plan.driver).toEqual({ index: 'namePrefix', prefix: 'ka' })
  })

  it('prefers an enumerated word over one that has to be a prefix range', () => {
    const plan = queryPlan(resolvedWith({ text: 'ka morphy' }, { morphy: ['morphy'] }))
    expect(plan.driver).toEqual({ index: 'names', tokens: ['morphy'] })
    expect(plan.residual.terms).toEqual([{ term: 'ka', tokens: null }])
  })

  it('falls back to the longest word when none could be enumerated', () => {
    const plan = queryPlan(byPrefix({ text: 'tal riga' }))
    expect(plan.driver).toEqual({ index: 'namePrefix', prefix: 'riga' })
  })

  it('prefers a name over every other index', () => {
    const plan = queryPlan(byPrefix({ text: 'morphy', result: '1-0', speed: 'classical' }))
    expect(plan.driver.index).toBe('namePrefix')
    expect(plan.residual.filters).toEqual({ result: '1-0', speed: 'classical' })
  })

  it('falls to ECO, then the year range, then the rating floor', () => {
    expect(queryPlan(byPrefix({ eco: 'B44', result: '1-0' })).driver).toEqual({
      index: 'eco',
      prefix: 'B44',
    })
    expect(queryPlan(byPrefix({ yearFrom: 1980, yearTo: 1990, result: '1-0' })).driver).toEqual({
      index: 'year',
      from: 1980,
      to: 1990,
    })
    expect(queryPlan(byPrefix({ minRating: 2500, result: '1-0' })).driver).toEqual({
      index: 'minElo',
      atLeast: 2500,
    })
  })

  it('uses result or speed only when nothing better is on offer', () => {
    expect(queryPlan(byPrefix({ result: '1-0' })).driver).toEqual({ index: 'result', value: '1-0' })
    expect(queryPlan(byPrefix({ speed: 'classical' })).driver).toEqual({
      index: 'speed',
      value: 'classical',
    })
  })

  it('leaves a half-open year range half-open', () => {
    expect(queryPlan(byPrefix({ yearFrom: 1980 })).driver).toEqual({ index: 'year', from: 1980 })
    expect(queryPlan(byPrefix({ yearTo: 1990 })).driver).toEqual({ index: 'year', to: 1990 })
  })

  it('never loses a constraint: the driver plus the residual is the whole query', () => {
    // The plan is a *cost* decision. Which index drives may change freely; what
    // may never change is that everything asked for is still enforced. This is
    // the property that lets the driver order be a heuristic.
    const queries: GameQuery[] = [
      { text: 'kasparov karpov', eco: 'B44', yearFrom: 1984, yearTo: 1985, result: '1-0' },
      { text: 'alekhine world', minRating: 2400 },
      { eco: 'C', minRating: 2400, speed: 'classical', source: 'a.pgn' },
      { yearFrom: 1900, result: '1/2-1/2', speed: 'unknown' },
      { minRating: 2200 },
      {},
    ]
    const index = { alekhine: ['alekhine', 'aljechin'], kasparov: ['kasparov'], world: null }
    const candidates = [
      game(),
      game({ white: 'Fischer, Robert', black: 'Spassky, Boris', year: 1972, eco: 'C69' }),
      game({ white: 'Aljechin, A.', event: 'World Championship', year: 1927 }),
      game({ year: undefined, minElo: undefined, speed: 'unknown', eco: undefined }),
      game({ source: 'a.pgn', eco: 'C42', minElo: 2400 }),
    ]
    for (const q of queries) {
      for (const resolve of [byPrefix, (x: GameQuery) => resolvedWith(x, index)]) {
        const whole = resolve(q)
        const { residual } = queryPlan(whole)
        for (const g of candidates) {
          // Anything the driver lets through and the residual accepts must be a
          // genuine match — a residual weaker than the query means a constraint
          // was dropped on the floor.
          if (matchesQuery(g, whole)) expect(matchesQuery(g, residual)).toBe(true)
        }
      }
    }
  })
})
