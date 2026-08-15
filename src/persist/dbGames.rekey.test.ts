// Rewriting the primary key when the dedup key changed shape (#53 follow-up).
//
// The key used to end at the first ten plies. That collapsed distinct games in
// an undated corpus, so it now hashes the whole game — and because it is the
// *primary* key, every row written under the old shape has to be rewritten.
//
// Skipping the rewrite would lose nothing today. It would go wrong later: the
// next time that file was attached, every game in it would land under a new key
// beside the old copy instead of on top of it, silently doubling the database.
// That is the one property §9 leans on, so it is tested rather than assumed.
//
// This import must run before ./db is imported: getDb() decides once, at first
// call, whether IndexedDB exists. Vitest hoists imports in source order.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import Dexie from 'dexie'
import { describeGame, dedupKey, type ImportedGame } from '../domain/pgnImport'
import { toDbGame } from './dbGames'

const DB = 'etude-chess'
const MOVES = ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Ba4', 'Nf6', 'O-O', 'Be7', 'Re1', 'b5']

/** The key exactly as it was computed before the change: ten plies, no event. */
const oldKey = (g: ImportedGame): string =>
  [
    g.headers.White?.toLowerCase() ?? '',
    g.headers.Black?.toLowerCase() ?? '',
    g.headers.Date?.toLowerCase() ?? '',
    g.headers.Result?.toLowerCase() ?? '',
    g.sanMoves.slice(0, 10).join(' '),
  ].join('')

function imported(white: string, tail: string[]): ImportedGame {
  return {
    headers: { White: white, Black: 'Zukertort', Event: 'London', Result: '1-0' },
    sanMoves: [...MOVES, ...tail],
  }
}

/** The schema as #54 shipped it, with rows keyed the old way. */
async function seedAtV5(games: ImportedGame[]) {
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
  await old.open()
  await old.table('dbGames').bulkPut(
    games.map((g) => ({
      ...toDbGame(g, describeGame(g), { source: 'a.pgn', importedAt: 1 }),
      key: oldKey(g),
    })),
  )
  old.close()
}

// Each test seeds at v5 and opens at v6, so the whole database has to go
// between them — clearing the table alone would leave the version at v6 and the
// upgrade would never run a second time.
beforeEach(async () => {
  await Dexie.delete(DB)
})

describe('upgrading a database keyed before the dedup key changed', () => {
  it('rewrites every row under the new key, losing none', async () => {
    const games = [imported('Steinitz', ['Bb7']), imported('Blackburne', ['Rb8'])]
    await seedAtV5(games)

    const { EtudeDb } = await import('./db')
    const db = new EtudeDb()
    await db.open()

    expect(await db.dbGames.count()).toBe(2)
    for (const g of games) {
      const row = await db.dbGames.get(dedupKey(g))
      expect(row).toBeDefined()
      // Not just present under the new key — the same row, intact.
      expect(row?.white).toBe(g.headers.White)
      expect(row?.movetext).toBe(g.sanMoves.join(' '))
    }
    // And nothing is still sitting under an old key.
    expect(await db.dbGames.get(oldKey(games[0]!))).toBeUndefined()
    db.close()
  })

  it('leaves a re-import overwriting rather than duplicating', async () => {
    // The point of the rewrite. Attaching the same file again computes the new
    // key; if the stored row were still under the old one, this would be two.
    const game = imported('Steinitz', ['Bb7'])
    await seedAtV5([game])

    const { EtudeDb } = await import('./db')
    const db = new EtudeDb()
    await db.open()
    await db.dbGames.put(toDbGame(game, describeGame(game), { source: 'a.pgn', importedAt: 2 }))

    expect(await db.dbGames.count()).toBe(1)
    db.close()
  })
})
