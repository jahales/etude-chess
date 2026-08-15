// Upgrading a library written before an imported game could be analysed (#133).
//
// v7 adds one table and touches nothing else — no rows are read, rewritten or
// deleted, so there is no half-applied state an interrupted upgrade could leave
// behind. That is the whole reason the evaluations went into a table of their
// own rather than onto the `dbGames` rows (db.ts's v7 comment), and it is worth
// asserting rather than assuming: the worst failure this app has is the owner
// opening it after an update to find their library gone, which is silent and
// unrecoverable — an empty library looks exactly like a new install.
//
// Each case seeds at v6 and opens at v7, so the whole database has to go between
// them: clearing the tables would leave the version at v7 and the upgrade would
// never run a second time.
//
// This import must run before ./db is imported: getDb() decides once, at first
// call, whether IndexedDB exists. Vitest hoists imports in source order.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import Dexie from 'dexie'

const DB = 'etude-chess'

/** The schema exactly as #128 shipped it, one version before this one. */
async function openAsShippedBefore() {
  const old = new Dexie(DB)
  old.version(1).stores({ attempts: '++id, gameId, sessionId, tier, createdAt' })
  old.version(2).stores({ games: '++id, gameId, outcome, level, createdAt' })
  old.version(3).stores({
    dbGames: 'key, white, black, year, eco, result, speed, minElo, source, [white+year], [black+year]',
    dbSources: 'name, importedAt',
  })
  old.version(4).stores({
    dbGames:
      'key, white, black, year, eco, result, speed, minElo, source, *names, [white+year], [black+year]',
    dbSources: 'name, importedAt',
  })
  old.version(5).stores({ dbSearch: 'id' })
  // The rekey. No index list — it changed values, not the schema.
  old.version(6).stores({})
  await old.open()
  return old
}

beforeEach(async () => {
  await Dexie.delete(DB)
})

describe('upgrading a library written before imported games could be analysed', () => {
  it('adds the table without disturbing a single stored row', async () => {
    const before = await openAsShippedBefore()
    await before.table('games').add({
      gameId: 'g-1',
      yourColor: 'w',
      level: 1500,
      sanHistory: ['e4', 'e5'],
      outcome: 'you',
      reason: 'checkmate',
      accuracy: 87.5,
      takebacks: 0,
      createdAt: 1,
      analysedAt: 99,
      analysisNodes: 150_000,
    })
    await before.table('attempts').add({ gameId: 'g-1', sessionId: 's-1', tier: 'B', createdAt: 1 })
    await before.table('dbGames').put({
      key: 'morphy',
      white: 'Morphy, Paul',
      black: 'Anderssen, Adolf',
      result: '1-0',
      speed: 'classical',
      plies: 4,
      movetext: 'e4 e5 Nf3 Nc6',
      source: 'a.pgn',
      importedAt: 1,
      names: ['morphy', 'paul', 'anderssen', 'adolf'],
    })
    await before.table('dbSources').put({ name: 'a.pgn', importedAt: 1, games: 1, parsed: 1, skipped: 0 })
    await before.table('dbSearch').put({ id: 'names', stamp: 's', index: '{}' })
    before.close()

    // Re-open through the app's own class, which is what an update does.
    const { EtudeDb } = await import('./db')
    const db = new EtudeDb()
    await db.open()

    expect(await db.games.count()).toBe(1)
    expect(await db.attempts.count()).toBe(1)
    expect(await db.dbGames.count()).toBe(1)
    expect(await db.dbSources.count()).toBe(1)
    expect(await db.dbSearch.count()).toBe(1)

    // Not just the row counts — the fields each screen reads back, including the
    // played game's *own* analysis, which stays where it always was.
    const played = await db.games.toCollection().first()
    expect(played?.sanHistory).toEqual(['e4', 'e5'])
    expect(played?.analysedAt).toBe(99)
    const imported = await db.dbGames.get('morphy')
    expect(imported?.movetext).toBe('e4 e5 Nf3 Nc6')
    expect(imported?.names).toEqual(['morphy', 'paul', 'anderssen', 'adolf'])

    // And the new table is live in the same connection, empty rather than absent
    // — which is what "not analysed" looks like for every game already stored.
    expect(await db.dbAnalysis.count()).toBe(0)
    db.close()
  })

  it('stores an analysis through the upgraded connection', async () => {
    // The upgrade is only worth anything if the table it adds is usable by the
    // module that owns it, not just present in the schema.
    ;(await openAsShippedBefore()).close()

    const { getDbAnalysis, saveDbAnalysis } = await import('./dbGames')
    await saveDbAnalysis({
      key: 'morphy',
      evalByPly: [{ whitePct: 52, label: '+0.1' }],
      analysedAt: 7,
      analysisNodes: 150_000,
    })

    expect(await getDbAnalysis({ key: 'morphy' })).toMatchObject({ analysedAt: 7 })
  })
})
