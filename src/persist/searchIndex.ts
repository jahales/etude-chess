/**
 * Fuzzy player and event search (#54, plan §10, ADR 0018 §6).
 *
 * The reason this exists rather than a prefix match: **chess databases spell the
 * same player several ways, and those are not typos.** Transliteration from
 * Cyrillic varies by publisher and era — Alekhine / Aljechin, Nimzowitsch /
 * Nimzovich, Botvinnik / Botwinnik, Petrosian / Petrosyan — and any real corpus
 * mixes them. `aljechin` and `alekhine` share no prefix at all, so a prefix
 * index cannot connect them and no amount of care with one will.
 *
 * ## What is indexed
 *
 * **The vocabulary, not the games.** Documents are the distinct name tokens of
 * the database — the keys of the `*names` multiEntry index — and a search
 * returns *tokens*, which `dbGames.ts` then looks up through that same index.
 * Measured against a synthetic 100k-game corpus (~33k distinct tokens):
 *
 * | documents are… | serialized | build |
 * |---|---|---|
 * | games (the obvious reading of §10) | **10.1 MB** | 1.4 s **plus reading every row** |
 * | the distinct name tokens | **0.8 MB** | 0.2 s, **index-only** |
 *
 * Twelve times smaller, and the difference in build cost is larger than it
 * looks: the vocabulary comes from `uniqueKeys()` on an index, so building it
 * reads no records at all, while a document-per-game index has to pull ~76 MB of
 * movetext through IndexedDB to get at three header fields. Games keep their
 * own index — this one only has to answer "which spellings did you mean?".
 *
 * ## The options hazard, structurally
 *
 * §10 flags that a persisted MiniSearch index reloaded with different options
 * **misbehaves silently**. Two things make that unreachable rather than merely
 * warned about:
 *
 * - `OPTIONS` is module-private and neither `create()` nor `load()` takes
 *   options, so within one build the two paths cannot differ. The exported
 *   surface has nowhere to pass a wrong object *through*.
 * - Across builds, the stored index carries `INDEX_STAMP` — a fingerprint of
 *   `OPTIONS` that includes the source of its functions — and a stamp mismatch
 *   **discards and rebuilds**. This errs towards rebuilding: minification
 *   changes function source, so an app update can rebuild an index whose options
 *   never changed. That costs a fraction of a second, once, and it is the safe
 *   direction to be wrong in.
 */

import MiniSearch, { type Options } from 'minisearch'
import { tokenize } from '../domain/dbQuery'
import { getDb } from './db'

/** One document: a single distinct name token from the database. */
interface TermDoc {
  term: string
}

/**
 * Fold a term to what it should match as.
 *
 * Diacritics go, because "Réti" and "Reti" are the same player written by two
 * publishers — the same problem as transliteration, one decomposition away from
 * solved. The *document id* stays the original token, so what comes back is
 * still a key the `*names` index holds.
 */
const fold = (term: string): string =>
  term.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()

/**
 * How wrong a word may be and still match: 0.4 of its length, capped at three
 * edits. Measured against the pairs this feature exists for — Alekhine /
 * Aljechin needs three edits over eight characters (0.375), which is the widest
 * of them and what sets the number. Below five characters fuzzy is **off**:
 * one edit on a four-letter name matches a great deal of a 33k-token vocabulary
 * and means nothing.
 */
const FUZZY = 0.4
const FUZZY_MIN_LENGTH = 5
const MAX_EDITS = 3

/**
 * The one options object.
 *
 * Not exported, and not a parameter of anything below: the only way to build or
 * load an index is through `create()` and `load()`, which both close over this.
 */
const OPTIONS: Options<TermDoc> = {
  fields: ['term'],
  idField: 'term',
  tokenize,
  processTerm: fold,
  searchOptions: {
    prefix: true,
    fuzzy: (term) => (term.length >= FUZZY_MIN_LENGTH ? FUZZY : false),
    maxFuzzy: MAX_EDITS,
    // One word is searched at a time, so this only ever governs a single term.
    combineWith: 'OR',
  },
}

/**
 * A fingerprint of `OPTIONS`, stored beside the index it built.
 *
 * Functions are included **by source**, because `tokenize` and `processTerm`
 * decide what is in the index and a change to either invalidates it just as
 * surely as changing `fields` would — and `JSON.stringify` drops functions
 * silently, which would make this look like it worked.
 */
export const INDEX_STAMP: string = JSON.stringify(OPTIONS, (_key, value: unknown) =>
  typeof value === 'function' ? String(value) : value,
)

const create = (): MiniSearch<TermDoc> => new MiniSearch<TermDoc>(OPTIONS)

const load = (json: string): MiniSearch<TermDoc> => MiniSearch.loadJSON<TermDoc>(json, OPTIONS)

/** The stored index. One row; `id` is a constant because there is only ever one. */
export interface StoredSearchIndex {
  id: string
  json: string
  /** `INDEX_STAMP` as it was when this was built. A mismatch means rebuild. */
  stamp: string
  /** Games in the database when it was built. A mismatch means rebuild. */
  games: number
  builtAt: number
}

export const SEARCH_INDEX_ID = 'names'

/**
 * How many tokens a word may resolve to before the caller is told to use a
 * prefix range instead.
 *
 * Beyond this the query is broad — a two-letter word over a real vocabulary —
 * and a prefix range answers it completely and in one walk. The alternative,
 * truncating a ranked list, would drop *exact* matches from the tail while
 * keeping fuzzy ones near the head, which is worse and invisible.
 */
export const MAX_EXPANDED_TOKENS = 400

// The parsed index, kept for the session: reloading is a JSON parse of ~0.8 MB
// at 100k games, which is cheap once and silly per keystroke.
let cached: MiniSearch<TermDoc> | null = null
let building: Promise<MiniSearch<TermDoc> | null> | null = null

/**
 * Drop the in-memory index. The next search reloads or rebuilds it.
 *
 * Called when the corpus changes; also what a test uses to prove the *reload*
 * path, rather than only the freshly-built one.
 */
export function resetSearchIndex(): void {
  cached = null
  building = null
}

/** Forget the persisted index too, so the next search rebuilds it from the games. */
export async function invalidateSearchIndex(): Promise<void> {
  resetSearchIndex()
  const d = getDb()
  if (!d) return
  try {
    await d.dbSearch.delete(SEARCH_INDEX_ID)
  } catch (e) {
    console.warn('etude-chess: could not clear the search index', e)
  }
}

/**
 * Every distinct name token in the database.
 *
 * `uniqueKeys()` walks the `*names` index and reads **no records** — which is
 * what makes rebuilding cheap enough to do on any doubt about staleness.
 */
async function vocabulary(): Promise<string[]> {
  const d = getDb()
  if (!d) return []
  const keys = await d.dbGames.orderBy('names').uniqueKeys()
  return keys as string[]
}

async function build(): Promise<MiniSearch<TermDoc> | null> {
  const d = getDb()
  if (!d) return null
  const terms = await vocabulary()
  const index = create()
  // Chunked and yielding: a rebuild must not hold the main thread while the
  // user is typing into the box that triggered it.
  await index.addAllAsync(
    terms.map((term) => ({ term })),
    { chunkSize: 1000 },
  )
  try {
    await d.dbSearch.put({
      id: SEARCH_INDEX_ID,
      json: JSON.stringify(index),
      stamp: INDEX_STAMP,
      games: await d.dbGames.count(),
      builtAt: Date.now(),
    })
  } catch (e) {
    // A full quota costs us the persistence, not the search: the index we just
    // built is in memory and works for this session.
    console.warn('etude-chess: could not persist the search index', e)
  }
  return index
}

/**
 * The search index, built or reloaded as needed.
 *
 * A stored index is used when its stamp matches the options in this build *and*
 * the database still holds the number of games it was built over. Otherwise it
 * is rebuilt — including the case that matters most, a database attached before
 * this feature existed, which has no stored index at all and must not quietly
 * return nothing.
 */
async function ensureIndex(): Promise<MiniSearch<TermDoc> | null> {
  if (cached) return cached
  if (building) return building
  building = (async () => {
    const d = getDb()
    if (!d) return null
    try {
      const stored = await d.dbSearch.get(SEARCH_INDEX_ID)
      const games = await d.dbGames.count()
      if (stored && stored.stamp === INDEX_STAMP && stored.games === games) {
        try {
          cached = load(stored.json)
          return cached
        } catch (e) {
          // Truncated by a quota, or written by a MiniSearch whose serialization
          // format has moved on. Rebuilding replaces it; leaving it would mean
          // failing this way on every search from now on.
          console.warn('etude-chess: the stored search index could not be read', e)
        }
      }
      cached = await build()
      return cached
    } catch (e) {
      console.warn('etude-chess: could not open the search index', e)
      return null
    } finally {
      building = null
    }
  })()
  return building
}

/** Build the index now, so the first search after an import is not the one that waits. */
export async function warmSearchIndex(): Promise<void> {
  await invalidateSearchIndex()
  await ensureIndex()
}

/**
 * Resolve each word of a query to the index tokens that satisfy it.
 *
 * `null` for a word means "more matches than are worth enumerating" — the caller
 * walks a prefix range for it instead. `null` is also what an unavailable index
 * yields, so a browser with no IndexedDB, a failed build and an over-broad word
 * all degrade the same way: to prefix matching, which still works.
 */
export async function expandTerms(terms: string[]): Promise<(string[] | null)[]> {
  if (terms.length === 0) return []
  const index = await ensureIndex()
  if (!index) return terms.map(() => null)
  return terms.map((term) => {
    const hits = index.search(term)
    // Too broad to enumerate → a prefix range. And **no hits is also `null`**,
    // not `[]`: the index is rebuilt when the corpus changes rather than inside
    // the write, so it can be a moment behind, and a prefix range over the live
    // `*names` index is both the forgiving answer and the correctly empty one
    // when the name genuinely isn't there.
    if (hits.length === 0 || hits.length > MAX_EXPANDED_TOKENS) return null
    return hits.map((hit) => hit.id as string)
  })
}
