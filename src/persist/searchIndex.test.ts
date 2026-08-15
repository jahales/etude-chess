// The fuzzy search index (#54, ADR 0018 §6).
//
// Two things are worth testing here and MiniSearch itself is not one of them:
//
//  1. **The behaviour that justifies the dependency.** Chess databases spell the
//     same player several ways and those are not typos — Alekhine / Aljechin
//     share no prefix at all. If that stops working the dependency has stopped
//     earning its place, so it is pinned rather than assumed.
//  2. **The reload path.** §10 warns that an index reloaded with options
//     different from the ones it was built with misbehaves *silently*. A test
//     that only ever searches a freshly-built index would miss exactly that, so
//     these assert against an index that has been through storage — and prove
//     it went through the load path rather than being rebuilt.
//
// This import must run before ./db is imported: getDb() decides once, at first
// call, whether IndexedDB exists. Vitest hoists imports in source order.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import Dexie from 'dexie'
import MiniSearch from 'minisearch'
import { describeGame, type ImportedGame } from '../domain/pgnImport'
import {
  INDEX_STAMP,
  SEARCH_INDEX_ID,
  expandTerms,
  invalidateSearchIndex,
  resetSearchIndex,
  warmSearchIndex,
  type StoredSearchIndex,
} from './searchIndex'
import { putDbGames, toDbGame } from './dbGames'
import { getDb } from './db'

const MOVES = ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Ba4', 'Nf6', 'O-O', 'Be7', 'Re1', 'b5']

function row(white: string, black: string, event = 'Candidates') {
  const game: ImportedGame = {
    headers: { White: white, Black: black, Event: event, Date: '1930.01.01', Result: '1-0' },
    sanMoves: MOVES,
  }
  return toDbGame(game, describeGame(game), { source: 'a.pgn', importedAt: 1 })
}

/** Both spellings of two players a real OTB corpus genuinely mixes. */
const CORPUS = [
  row('Alekhine, Alexander', 'Capablanca, Jose Raul', 'Buenos Aires'),
  row('Aljechin, A.', 'Bogoljubow, Efim', 'Wiesbaden'),
  row('Nimzowitsch, Aron', 'Rubinstein, Akiba', 'Karlsbad'),
  row('Nimzovich, A.', 'Saemisch, Friedrich', 'Kopenhagen'),
  row('Réti, Richard', 'Tartakower, Savielly', 'Wien'),
  row('Morphy, Paul', 'Anderssen, Adolf', 'Paris'),
]

beforeEach(async () => {
  resetSearchIndex()
  const d = new Dexie('etude-chess')
  try {
    await d.open()
    await Promise.all([d.table('dbGames').clear(), d.table('dbSearch').clear()])
  } catch {
    // First run: db.ts hasn't created the database yet.
  } finally {
    d.close()
  }
  resetSearchIndex()
  await putDbGames(CORPUS)
})

const expand = async (term: string): Promise<string[] | null> => (await expandTerms([term]))[0]!

describe('fuzzy name matching', () => {
  it('connects two transliterations of the same player', async () => {
    // The case the dependency exists for: three edits over eight characters.
    expect(await expand('alekhine')).toContain('aljechin')
    expect(await expand('aljechin')).toContain('alekhine')
  })

  it('connects the other spellings a corpus actually mixes', async () => {
    expect(await expand('nimzowitsch')).toContain('nimzovich')
    expect(await expand('nimzovich')).toContain('nimzowitsch')
  })

  it('finds an accented name typed without its accents', async () => {
    // Same family of problem, one decomposition away: "Réti" and "Reti" are one
    // player written by two publishers.
    expect(await expand('reti')).toContain('réti')
  })

  it('still matches a name spelled exactly right', async () => {
    expect(await expand('morphy')).toContain('morphy')
  })

  it('matches a prefix, so a half-typed name still finds the player', async () => {
    expect(await expand('anders')).toContain('anderssen')
  })

  it('does not fuzzy-match a short word into everything', async () => {
    // One edit on a four-letter name matches a great deal of a real vocabulary
    // and means nothing, so fuzzy is off below five characters. "wien" must not
    // drag in "wiesbaden"'s neighbours — only its own prefix matches.
    const hits = (await expand('wien')) ?? []
    expect(hits).toContain('wien')
    expect(hits).not.toContain('paris')
  })

  it('falls back to a prefix range for a word it cannot resolve', async () => {
    // `null` is "walk the index yourself", not "no games" — a name absent from
    // the vocabulary and an index that is a moment stale must behave the same.
    expect(await expand('nobodyhere')).toBeNull()
  })
})

describe('the persisted index', () => {
  it('is written to storage, stamped with the options that built it', async () => {
    await warmSearchIndex()
    const stored = await getDb()!.dbSearch.get(SEARCH_INDEX_ID)
    expect(stored?.stamp).toBe(INDEX_STAMP)
    expect(stored?.games).toBe(CORPUS.length)
    expect(stored!.json.length).toBeGreaterThan(0)
  })

  it('answers identically after a reload as it did when freshly built', async () => {
    // The failure §10 warns about is silent, so this compares the two indexes
    // rather than merely exercising the reload.
    const terms = ['alekhine', 'nimzovich', 'reti', 'morphy', 'anders', 'nobodyhere']
    const fresh = await expandTerms(terms)

    const loadJSON = vi.spyOn(MiniSearch, 'loadJSON')
    resetSearchIndex()
    const reloaded = await expandTerms(terms)

    // Proof that this went through the load path rather than quietly rebuilding,
    // which is what would make the comparison above vacuous.
    expect(loadJSON).toHaveBeenCalledTimes(1)
    expect(reloaded).toEqual(fresh)
    loadJSON.mockRestore()
  })

  it('discards an index built with different options instead of trusting it', async () => {
    await warmSearchIndex()
    const d = getDb()!
    const stored = (await d.dbSearch.get(SEARCH_INDEX_ID))!
    // An index from a build whose tokenizer or fields differed. Loading it would
    // misbehave without complaining, which is the whole hazard.
    await d.dbSearch.put({ ...stored, stamp: 'built-by-some-earlier-version' })
    resetSearchIndex()

    const loadJSON = vi.spyOn(MiniSearch, 'loadJSON')
    expect(await expand('alekhine')).toContain('aljechin')
    expect(loadJSON).not.toHaveBeenCalled()
    expect((await d.dbSearch.get(SEARCH_INDEX_ID))?.stamp).toBe(INDEX_STAMP)
    loadJSON.mockRestore()
  })

  it('stamps the *source* of its function options, which JSON alone would drop', async () => {
    // `tokenize` and `processTerm` decide what is in the index, and
    // JSON.stringify discards functions without a word — a fingerprint that did
    // that would look like it worked and detect nothing.
    expect(INDEX_STAMP).toMatch(/normalize|NFD/)
    expect(INDEX_STAMP).not.toBe(JSON.stringify({ fields: ['term'], idField: 'term' }))
  })

  it('rebuilds when the database has games the index has never seen', async () => {
    // A backstop for the explicit invalidation on import and detach: if those
    // ever miss, a search must not answer from a vocabulary that is short.
    await warmSearchIndex()
    await putDbGames([row('Tal, Mikhail', 'Botvinnik, Mikhail')])
    resetSearchIndex()

    expect(await expand('botvinnik')).toContain('botvinnik')
  })
})

describe('a database attached before the search index existed', () => {
  it('builds one on first use rather than returning nothing', async () => {
    // The same class of failure as #53's rows having no `names`: silent, and it
    // looks exactly like "you have no games by that player".
    await invalidateSearchIndex()
    expect(await getDb()!.dbSearch.get(SEARCH_INDEX_ID)).toBeUndefined()

    expect(await expand('alekhine')).toContain('aljechin')
    expect(await getDb()!.dbSearch.get(SEARCH_INDEX_ID)).toBeDefined()
  })

  it('rebuilds over a stored index that cannot be read at all', async () => {
    // Truncated by a quota, or written by a MiniSearch whose serialization
    // format has since moved on. Falling back would mean failing this way on
    // every search from now on, so it is replaced rather than worked around.
    const d = getDb()!
    await d.dbSearch.put({
      id: SEARCH_INDEX_ID,
      json: 'not json',
      stamp: INDEX_STAMP,
      games: CORPUS.length,
      builtAt: 1,
    } satisfies StoredSearchIndex)
    resetSearchIndex()

    expect(await expand('alekhine')).toContain('aljechin')
    expect((await d.dbSearch.get(SEARCH_INDEX_ID))?.json).not.toBe('not json')
  })
})
