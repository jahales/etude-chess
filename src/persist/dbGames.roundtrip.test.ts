// The attached-database table against a real IndexedDB (fake-indexeddb).
// dbGames.failure.test.ts covers storage that is absent or breaks.
//
// This import must run before ./db is imported: getDb() decides once, at first
// call, whether IndexedDB exists. Vitest hoists imports in source order.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import Dexie from 'dexie'
import { describeGame, dedupKey, type ImportedGame } from '../domain/pgnImport'
import {
  BULK_CHUNK,
  countDbGames,
  deleteDbSource,
  listDbSources,
  putDbGames,
  recordDbSource,
  toDbGame,
  type DbGame,
} from './dbGames'

const MOVES = ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Ba4', 'Nf6', 'O-O', 'Be7', 'Re1', 'b5']

function imported(over: Partial<ImportedGame['headers']> = {}, moves = MOVES): ImportedGame {
  return {
    headers: {
      Event: 'Candidates',
      Site: 'Curacao',
      Date: '1962.05.02',
      White: 'Keres, Paul',
      Black: 'Fischer, Robert James',
      Result: '1-0',
      WhiteElo: '2600',
      BlackElo: '2650',
      TimeControl: '40/9000:1800',
      ECO: 'C92',
      ...over,
    },
    sanMoves: moves,
  }
}

const row = (game: ImportedGame, source = 'masters.pgn', at = 1000): DbGame =>
  toDbGame(game, describeGame(game), { source, importedAt: at })

beforeEach(async () => {
  // db.ts caches its Dexie instance for the module's lifetime, so clear through
  // a second connection rather than deleting the database under it. No declared
  // schema puts Dexie in dynamic mode, keeping the schema in one place — db.ts.
  const d = new Dexie('etude-chess')
  try {
    await d.open()
    await Promise.all([d.table('dbGames').clear(), d.table('dbSources').clear()])
  } catch {
    // First run: db.ts hasn't created the database yet.
  } finally {
    d.close()
  }
})

describe('toDbGame', () => {
  it('stores the movetext as text, not as a move encoding', () => {
    // The spike's reversal (§5): one byte per move is 5× smaller but needs legal
    // move generation at every ply — ~12 games/sec, over two hours for 100k
    // games. CPU is the binding constraint, not storage.
    const r = row(imported())
    expect(r.movetext).toBe(MOVES.join(' '))
    expect(r.plies).toBe(MOVES.length)
  })

  it('carries provenance, because an import must be traceable to its file', () => {
    const r = row(imported(), 'lumbra-2025.pgn', 1723_000_000_000)
    expect(r.source).toBe('lumbra-2025.pgn')
    expect(r.importedAt).toBe(1723_000_000_000)
  })

  it('flattens the facts item 10 will index on', () => {
    const r = row(imported())
    expect(r).toMatchObject({
      white: 'Keres, Paul',
      black: 'Fischer, Robert James',
      year: 1962,
      result: '1-0',
      eco: 'C92',
      minElo: 2600,
      speed: 'classical',
      timeControl: '40/9000:1800',
    })
  })

  it('marks an unknown time control rather than guessing one', () => {
    const { TimeControl: _drop, ...noTc } = imported().headers
    const r = row({ headers: noTc, sanMoves: MOVES })
    expect(r.speed).toBe('unknown')
    expect(r.timeControl).toBeUndefined()
  })

  it('leaves an unknown rating out of the index rather than storing a zero', () => {
    // Dexie does not index `undefined`, so an unrated game simply isn't in the
    // rating index — which is right. A stored 0 would sort below every real game.
    const { WhiteElo: _w, ...noElo } = imported().headers
    const r = row({ headers: noElo, sanMoves: MOVES })
    expect(r.minElo).toBeUndefined()
    expect(Object.prototype.hasOwnProperty.call(r, 'minElo')).toBe(false)
  })

  it('keeps the annotations that came with the file', () => {
    const g: ImportedGame = { ...imported(), comments: { 3: 'A novelty.' }, nags: { 3: [1] } }
    const r = row(g)
    expect(r.comments).toEqual({ 3: 'A novelty.' })
    expect(r.nags).toEqual({ 3: [1] })
  })

  it('omits the annotation maps when a game has none', () => {
    const r = row(imported())
    expect(r.comments).toBeUndefined()
    expect(r.nags).toBeUndefined()
  })
})

describe('putDbGames', () => {
  it('round-trips a game with its annotations', async () => {
    const g: ImportedGame = { ...imported(), comments: { 0: 'The best by test.' } }
    await putDbGames([row(g)])

    const stored = await readAll()
    expect(stored).toHaveLength(1)
    expect(stored[0]!.movetext).toBe(MOVES.join(' '))
    expect(stored[0]!.comments).toEqual({ 0: 'The best by test.' })
  })

  it('writes in chunks rather than one enormous transaction', async () => {
    // §9: 500–1000 per transaction. A single bulkPut of 100k rows is how an
    // import becomes an unresponsive tab with no progress to show.
    const many = Array.from({ length: BULK_CHUNK * 2 + 7 }, (_, i) =>
      row(imported({ Date: `1962.05.${String(i).padStart(2, '0')}` })),
    )

    const result = await putDbGames(many)

    expect(result.written).toBe(many.length)
    expect(result.error).toBeUndefined()
    expect(await countDbGames()).toBe(many.length)
  })

  it('de-duplicates: the same game imported twice is one row', async () => {
    // The dedup key is the primary key, so this is a property of the schema
    // rather than of a check someone has to remember to write.
    const g = imported()
    await putDbGames([row(g)])
    await putDbGames([row(g, 'a-different-file.pgn', 2000)])

    expect(await countDbGames()).toBe(1)
    const stored = await readAll()
    expect(stored[0]!.key).toBe(dedupKey(g))
    expect(stored[0]!.source).toBe('a-different-file.pgn') // last write wins
  })

  it('de-duplicates within a single batch too', async () => {
    const g = imported()
    await putDbGames([row(g), row(g)])
    expect(await countDbGames()).toBe(1)
  })

  it('keeps two genuinely different games apart', async () => {
    await putDbGames([row(imported()), row(imported({ Black: 'Tal, Mikhail' }))])
    expect(await countDbGames()).toBe(2)
  })

  it('writes nothing, and says so, for an empty batch', async () => {
    expect(await putDbGames([])).toEqual({ written: 0 })
  })
})

describe('the indexes item 10 will query', () => {
  beforeEach(async () => {
    await putDbGames([
      row(imported()),
      row(imported({ White: 'Tal, Mikhail', Date: '1962.05.03' })),
      row(imported({ Date: '1971.09.01', ECO: 'B99' })),
    ])
  })

  it('finds games by player', async () => {
    const found = await queryIndex('white', 'Tal, Mikhail')
    expect(found).toHaveLength(1)
  })

  it('finds games by year', async () => {
    expect(await queryIndex('year', 1962)).toHaveLength(2)
    expect(await queryIndex('year', 1971)).toHaveLength(1)
  })

  it('finds games by ECO and by result', async () => {
    expect(await queryIndex('eco', 'B99')).toHaveLength(1)
    expect(await queryIndex('result', '1-0')).toHaveLength(3)
  })

  it('finds games by a player and a year together, from the compound index', async () => {
    const d = new Dexie('etude-chess')
    await d.open()
    try {
      const found = await d.table('dbGames').where('[white+year]').equals(['Keres, Paul', 1962]).toArray()
      expect(found).toHaveLength(1)
    } finally {
      d.close()
    }
  })
})

describe('attached sources', () => {
  it('records what was attached, newest first', async () => {
    await recordDbSource({ name: 'a.pgn', importedAt: 100, games: 10, parsed: 12, skipped: 2 })
    await recordDbSource({ name: 'b.pgn', importedAt: 300, games: 5, parsed: 5, skipped: 0 })

    expect((await listDbSources()).map((s) => s.name)).toEqual(['b.pgn', 'a.pgn'])
  })

  it('re-attaching the same file updates its record rather than adding one', async () => {
    // Safari evicts script-written storage after about a week, so re-importing
    // is a normal thing to do, not an error (§9).
    await recordDbSource({ name: 'a.pgn', importedAt: 100, games: 10, parsed: 12, skipped: 2 })
    await recordDbSource({ name: 'a.pgn', importedAt: 900, games: 11, parsed: 12, skipped: 1 })

    const sources = await listDbSources()
    expect(sources).toHaveLength(1)
    expect(sources[0]).toMatchObject({ importedAt: 900, games: 11 })
  })

  it('detaching a source removes its games and leaves the others alone', async () => {
    await putDbGames([
      row(imported(), 'a.pgn'),
      row(imported({ Date: '1962.05.03' }), 'a.pgn'),
      row(imported({ Date: '1971.09.01' }), 'b.pgn'),
    ])
    await recordDbSource({ name: 'a.pgn', importedAt: 1, games: 2, parsed: 2, skipped: 0 })
    await recordDbSource({ name: 'b.pgn', importedAt: 2, games: 1, parsed: 1, skipped: 0 })

    const removed = await deleteDbSource('a.pgn')

    expect(removed).toBe(2)
    expect(await countDbGames()).toBe(1)
    expect((await listDbSources()).map((s) => s.name)).toEqual(['b.pgn'])
  })

  it('detaching something that was never attached is not an error', async () => {
    await expect(deleteDbSource('never.pgn')).resolves.toBe(0)
  })
})

// ---------- helpers ----------

async function readAll(): Promise<DbGame[]> {
  const d = new Dexie('etude-chess')
  await d.open()
  try {
    return (await d.table('dbGames').toArray()) as DbGame[]
  } finally {
    d.close()
  }
}

async function queryIndex(index: string, value: string | number): Promise<DbGame[]> {
  const d = new Dexie('etude-chess')
  await d.open()
  try {
    return (await d.table('dbGames').where(index).equals(value).toArray()) as DbGame[]
  } finally {
    d.close()
  }
}
