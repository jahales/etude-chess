// Upgrading a database attached before search existed (#53 → #54).
//
// `*names` is a multiEntry index, and IndexedDB indexes only what a row actually
// carries — so games imported by #53, which have no `names` field, are invisible
// to it until something writes one. That failure is silent in the worst way: the
// search box works, returns fewer games than the database holds, and looks
// right. Hence the backfill in db.ts's v4 upgrade, and hence this file.
//
// A separate file from migration.test.ts on purpose: each opens a database from
// a different starting schema, and vitest gives a file its own module registry
// and its own fake-indexeddb.
//
// This import must run before ./db is imported: getDb() decides once, at first
// call, whether IndexedDB exists. Vitest hoists imports in source order.
import 'fake-indexeddb/auto'
import { describe, it, expect } from 'vitest'
import Dexie from 'dexie'

const DB = 'etude-chess'

/** The schema exactly as #53 shipped it — dbGames with no `names` index. */
async function openAsShippedByImport() {
  const old = new Dexie(DB)
  old.version(1).stores({ attempts: '++id, gameId, sessionId, tier, createdAt' })
  old.version(2).stores({ games: '++id, gameId, outcome, level, createdAt' })
  old.version(3).stores({
    dbGames: 'key, white, black, year, eco, result, speed, minElo, source, [white+year], [black+year]',
    dbSources: 'name, importedAt',
  })
  await old.open()
  return old
}

describe('upgrading an attached database written before it could be searched', () => {
  it('backfills the search tokens so old imports are findable', async () => {
    const before = await openAsShippedByImport()
    await before.table('dbGames').bulkPut([
      {
        key: 'morphy',
        white: 'Morphy, Paul',
        black: 'Anderssen, Adolf',
        event: 'Paris',
        year: 1858,
        result: '1-0',
        speed: 'unknown',
        plies: 30,
        movetext: 'e4 e5',
        source: 'old.pgn',
        importedAt: 1,
      },
      {
        key: 'tal',
        white: 'Tal, Mikhail',
        black: 'Botvinnik, Mikhail',
        year: 1960,
        result: '0-1',
        speed: 'classical',
        plies: 40,
        movetext: 'e4 c6',
        source: 'old.pgn',
        importedAt: 1,
      },
    ])
    before.close()

    // Re-open through the app's own module, which is what an update does.
    const { queryDbGames, countDbGames } = await import('./dbGames')

    // Nothing lost by the version bump…
    expect(await countDbGames()).toBe(2)
    // …and the games that were already there answer to a search.
    expect((await queryDbGames({ text: 'morphy' })).rows.map((g) => g.white)).toEqual([
      'Morphy, Paul',
    ])
    expect((await queryDbGames({ text: 'botvinnik' })).rows.map((g) => g.white)).toEqual([
      'Tal, Mikhail',
    ])
    // Including by the event, which is indexed alongside the players.
    expect((await queryDbGames({ text: 'paris' })).rows).toHaveLength(1)
    // A game whose file carried no event is not broken by having none.
    expect((await queryDbGames({ text: 'mikhail' })).rows).toHaveLength(1)
  })
})
