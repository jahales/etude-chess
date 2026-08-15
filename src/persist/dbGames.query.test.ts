// Browsing the attached database against a real IndexedDB (fake-indexeddb).
//
// What is being tested is *our* mapping — the plan in domain/dbQuery.ts turned
// into a Dexie collection — not Dexie. So: that every plan is wired to the index
// it names, that a multiEntry hit is not counted twice, that a page is a page
// and not the whole table, and that a count says when it stopped counting.
//
// This import must run before ./db is imported: getDb() decides once, at first
// call, whether IndexedDB exists. Vitest hoists imports in source order.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import Dexie from 'dexie'
import { describeGame, type ImportedGame } from '../domain/pgnImport'
import { PAGE_SIZE, type GameQuery } from '../domain/dbQuery'
import { invalidateSearchIndex, resetSearchIndex } from './searchIndex'
import {
  COUNT_CAP,
  countMatchingDbGames,
  getDbGame,
  putDbGames,
  queryDbGames,
  toDbGame,
  type DbGame,
} from './dbGames'

const MOVES = ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Ba4', 'Nf6', 'O-O', 'Be7', 'Re1', 'b5']

function row(headers: Record<string, string>, source = 'masters.pgn'): DbGame {
  const game: ImportedGame = {
    headers: {
      Event: 'Candidates',
      Date: '1962.05.02',
      White: 'Keres, Paul',
      Black: 'Fischer, Robert James',
      Result: '1-0',
      WhiteElo: '2600',
      BlackElo: '2650',
      TimeControl: '40/9000:1800',
      ECO: 'C92',
      ...headers,
    },
    sanMoves: MOVES,
  }
  return toDbGame(game, describeGame(game), { source, importedAt: 1000 })
}

beforeEach(async () => {
  const d = new Dexie('etude-chess')
  try {
    await d.open()
    await Promise.all([d.table('dbGames').clear(), d.table('dbSearch').clear()])
  } catch {
    // First run: db.ts hasn't created the database yet.
  } finally {
    d.close()
  }
  // The vocabulary changed under the index; every test seeds its own games.
  resetSearchIndex()
})

const CORPUS = [
  row({ White: 'Morphy, Paul', Black: 'Anderssen, Adolf', Date: '1858.12.20', ECO: 'C41' }),
  row({ White: 'Tal, Mikhail', Black: 'Botvinnik, Mikhail', Date: '1960.03.15', ECO: 'B10' }),
  row({
    White: 'Fischer, Robert James',
    Black: 'Spassky, Boris',
    Date: '1972.07.11',
    Event: 'World Championship',
    ECO: 'B44',
    Result: '0-1',
  }),
  row({
    White: 'Kasparov, Garry',
    Black: 'Karpov, Anatoly',
    Date: '1985.10.15',
    Event: 'World Championship',
    ECO: 'B44',
    WhiteElo: '2700',
    BlackElo: '2720',
  }),
  // No date and no ratings: the "the file didn't say" row every filter has to
  // have an answer about.
  row({ White: 'Unknown, A', Black: 'Unknown, B', Date: '????.??.??', WhiteElo: '?', ECO: '' }, 'club.pgn'),
]

const found = async (query: GameQuery): Promise<string[]> =>
  (await queryDbGames(query)).rows.map((g) => g.white)

describe('querying the attached database', () => {
  beforeEach(async () => {
    await putDbGames(CORPUS)
  })

  it('returns everything, including a game whose file gave no date, when nothing is asked', async () => {
    // The trap this pins: ordering the unfiltered list by `year` would have
    // dropped the undated game from the browse screen without a word.
    expect(await found({})).toHaveLength(CORPUS.length)
    expect(await found({})).toContain('Unknown, A')
  })

  it('finds a player by a prefix of their name, through the names index', async () => {
    expect(await found({ text: 'morph' })).toEqual(['Morphy, Paul'])
  })

  it('finds a player by their first name as well as their surname', async () => {
    // The reason the index is over tokens rather than whole fields: "Garry" is
    // not a prefix of "Kasparov, Garry", and a whole-field index would need you
    // to know which way round the file wrote the name.
    expect(await found({ text: 'garry' })).toEqual(['Kasparov, Garry'])
    expect(await found({ text: 'kasparov' })).toEqual(['Kasparov, Garry'])
  })

  it('finds a game by the event, not only by the players', async () => {
    expect((await found({ text: 'championship' })).sort()).toEqual(
      ['Fischer, Robert James', 'Kasparov, Garry'].sort(),
    )
  })

  it('finds both spellings of a player a database transliterates two ways', async () => {
    // End to end through the search index: the reason MiniSearch is a dependency
    // (ADR 0018 §6). `aljechin` is not a typo and shares no prefix with
    // `alekhine` — a corpus that spans publishers and eras simply contains both,
    // and a player search that returns half their games is worse than useless.
    await putDbGames([
      row({ White: 'Alekhine, Alexander', Black: 'Capablanca, Jose Raul', Date: '1927.11.29' }),
      row({ White: 'Aljechin, A.', Black: 'Bogoljubow, Efim', Date: '1929.09.24' }),
    ])
    await invalidateSearchIndex()

    expect((await found({ text: 'alekhine' })).sort()).toEqual(
      ['Alekhine, Alexander', 'Aljechin, A.'].sort(),
    )
    // And a structured filter still narrows the fuzzy result rather than being
    // dropped by it.
    expect(await found({ text: 'alekhine', yearFrom: 1929 })).toEqual(['Aljechin, A.'])
  })

  it('yields a game once even when two of its names share the prefix searched for', async () => {
    // The multiEntry trap of plan §10. This game holds two distinct tokens
    // beginning "hast", so it sits at two keys inside the range being walked;
    // without `.distinct()` the results table shows it twice and the count says
    // two games. A prefix that hits only one token would never have caught it.
    await putDbGames([
      row({ White: 'Hastings, John', Black: 'Hastie, Jane', Event: 'Hastings Congress' }),
    ])
    expect(await found({ text: 'hast' })).toEqual(['Hastings, John'])
    expect(await countMatchingDbGames({ text: 'hast' })).toEqual({ count: 1, exact: true })
  })

  it('narrows on every word of a multi-word search', async () => {
    expect(await found({ text: 'kasparov karpov' })).toEqual(['Kasparov, Garry'])
    expect(await found({ text: 'kasparov fischer' })).toEqual([])
  })

  it('filters by year range, by result, by ECO family and by rating floor', async () => {
    expect(await found({ yearFrom: 1960, yearTo: 1972 })).toHaveLength(2)
    expect(await found({ result: '0-1' })).toEqual(['Fischer, Robert James'])
    expect((await found({ eco: 'B' })).sort()).toEqual(
      ['Fischer, Robert James', 'Kasparov, Garry', 'Tal, Mikhail'].sort(),
    )
    expect(await found({ minRating: 2700 })).toEqual(['Kasparov, Garry'])
  })

  it('filters by the file a game came from', async () => {
    expect(await found({ source: 'club.pgn' })).toEqual(['Unknown, A'])
  })

  it('applies the clauses the driving index did not, on top of it', async () => {
    // Driver is the name; result and year are re-checked per row.
    expect(await found({ text: 'world championship', result: '1-0' })).toEqual(['Kasparov, Garry'])
    expect(await found({ text: 'world championship', yearTo: 1975 })).toEqual([
      'Fischer, Robert James',
    ])
  })

  it('leaves out the games whose file never stated what is being filtered on', async () => {
    expect(await found({ yearFrom: 1000 })).not.toContain('Unknown, A')
    expect(await found({ minRating: 0 })).not.toContain('Unknown, A')
    expect(await found({ eco: 'C' })).not.toContain('Unknown, A')
  })

  it('opens a game by its key', async () => {
    const key = CORPUS[0]!.key
    expect((await getDbGame(key))?.white).toBe('Morphy, Paul')
    expect(await getDbGame('no such game')).toBeUndefined()
  })

  it('says which index the rows came back through, since that is their order', async () => {
    expect((await queryDbGames({ text: 'tal' })).order).toBe('names')
    expect((await queryDbGames({})).order).toBe('none')
  })
})

describe('paging', () => {
  // Two pages and a bit, so "is there more" is exercised in both directions.
  const MANY = Array.from({ length: PAGE_SIZE * 2 + 3 }, (_, i) =>
    row({ White: 'Player, One', Black: `Opponent, ${i}`, Date: `19${String(i % 90).padStart(2, '0')}.01.01` }),
  )

  beforeEach(async () => {
    await putDbGames(MANY)
  })

  it('reads a page, not a database', async () => {
    const page = await queryDbGames({ text: 'player' })
    expect(page.rows).toHaveLength(PAGE_SIZE)
    expect(page.hasMore).toBe(true)
  })

  it('walks to the last page and stops there', async () => {
    const last = await queryDbGames({ text: 'player' }, 2)
    expect(last.rows).toHaveLength(3)
    expect(last.hasMore).toBe(false)
  })

  it('gives a different page each time rather than the same one', async () => {
    const first = await queryDbGames({ text: 'player' }, 0)
    const second = await queryDbGames({ text: 'player' }, 1)
    const overlap = first.rows.filter((a) => second.rows.some((b) => b.key === a.key))
    expect(overlap).toEqual([])
  })

  it('returns an empty page past the end instead of failing', async () => {
    const page = await queryDbGames({ text: 'player' }, 99)
    expect(page.rows).toEqual([])
    expect(page.hasMore).toBe(false)
  })
})

describe('counting matches', () => {
  beforeEach(async () => {
    await putDbGames(CORPUS)
  })

  it('counts an index-only query exactly, from the index', async () => {
    expect(await countMatchingDbGames({})).toEqual({ count: CORPUS.length, exact: true })
    expect(await countMatchingDbGames({ text: 'championship' })).toEqual({ count: 2, exact: true })
    expect(await countMatchingDbGames({ result: '0-1' })).toEqual({ count: 1, exact: true })
  })

  it('counts a query with a residual exactly while it is small', async () => {
    expect(await countMatchingDbGames({ text: 'world championship', result: '1-0' })).toEqual({
      count: 1,
      exact: true,
    })
  })

  it('stops at the cap and says the total is higher', async () => {
    // The promise is bounded work, not a number: "1,000+" beats reading 100k
    // rows to put an exact total on screen.
    const cap = 3
    const count = await countMatchingDbGames({ text: 'unknown', speed: 'classical' }, cap)
    await putDbGames(
      Array.from({ length: cap + 2 }, (_, i) =>
        row({ White: 'Unknown, A', Black: `Other, ${i}`, Date: '1990.01.01' }, 'club.pgn'),
      ),
    )
    const capped = await countMatchingDbGames({ text: 'unknown', speed: 'classical' }, cap)

    expect(count.exact).toBe(true)
    expect(capped).toEqual({ count: cap, exact: false })
  })

  it('counts nothing as nothing, exactly', async () => {
    expect(await countMatchingDbGames({ text: 'nobodyhere' })).toEqual({ count: 0, exact: true })
  })

  it('has a cap generous enough to be a real total for most searches', () => {
    expect(COUNT_CAP).toBeGreaterThanOrEqual(1000)
  })
})
