// Round-trip tests for the history archive (#152), against a real IndexedDB
// implementation (fake-indexeddb).
//
// The import below must run before ./db is imported, because getDb() decides
// once, at first call, whether IndexedDB exists. Vitest hoists imports in source
// order, so keep this first.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import Dexie from 'dexie'
import { readBodyLine, type ArchiveRecord } from '../domain/historyArchive'
import { getDb, saveGame, type StoredAttempt, type StoredGame } from './db'
import type { DbGame, DbGameAnalysis, DbSource } from './dbGames'
import { applyArchive, archiveLines, estimateArchive } from './historyArchive'

// ---------- fixtures ----------

const attempt = (over: Partial<StoredAttempt> = {}): StoredAttempt => ({
  gameId: 'opera',
  sessionId: 's1',
  createdAt: 1000,
  itemIndex: 0,
  moveNumber: 8,
  sideToMove: 'w',
  fen: 'rnbqkb1r/pp2pppp/3p1n2/8/3NP3/2N5/PPP2PPP/R1BQKB1R w KQkq - 0 6',
  userMoveSan: 'Bc4',
  masterMoveSan: 'Bg5',
  reason: 'the light squares are where the play is',
  tier: 'B',
  swing: 3.5,
  ...over,
})

const game = (over: Partial<StoredGame> = {}): StoredGame => ({
  gameId: 'm1000',
  yourColor: 'w',
  level: 1500,
  sanHistory: ['e4', 'e5', 'Nf3'],
  outcome: 'you',
  reason: 'checkmate',
  accuracy: 87.5,
  takebacks: 1,
  createdAt: 1000,
  ...over,
})

const dbGame = (over: Partial<DbGame> = {}): DbGame => ({
  key: 'Morphy|Duke|1858|Paris|1-0|abc',
  white: 'Morphy, Paul',
  black: 'Duke of Brunswick',
  event: 'Paris',
  year: 1858,
  result: '1-0',
  speed: 'classical',
  plies: 33,
  movetext: 'e4 e5 Nf3 d6 d4 Bg4',
  source: 'classics.pgn',
  importedAt: 500,
  names: ['morphy', 'paul', 'duke', 'of', 'brunswick', 'paris'],
  ...over,
})

const analysis = (over: Partial<DbGameAnalysis> = {}): DbGameAnalysis => ({
  key: 'Morphy|Duke|1858|Paris|1-0|abc',
  evalByPly: [{ whitePct: 52, label: '+0.2' }],
  startEval: { whitePct: 50, label: '0.00' },
  analysedAt: 9_000,
  analysisNodes: 400_000,
  ...over,
})

const source = (over: Partial<DbSource> = {}): DbSource => ({
  name: 'classics.pgn',
  importedAt: 500,
  games: 2,
  parsed: 3,
  skipped: 1,
  ...over,
})

// ---------- plumbing ----------

/** Every table empty, through a second connection: db.ts caches its instance. */
beforeEach(async () => {
  const d = new Dexie('etude-chess')
  try {
    await d.open()
    await Promise.all(d.tables.map((t) => t.clear()))
  } catch {
    // First run: db.ts hasn't created the database yet.
  } finally {
    d.close()
  }
})

async function exportToText(includeDatabase = true): Promise<string> {
  const lines: string[] = []
  for await (const line of archiveLines({ includeDatabase }, 1_700_000_000_000, 'test')) {
    lines.push(line)
  }
  return lines.join('\n') + '\n'
}

/** The body of a file as records — what `useHistoryTransfer` feeds the merge. */
async function* recordsOf(text: string): AsyncGenerator<ArchiveRecord> {
  const lines = text.split('\n').filter((l) => l.trim())
  for (const line of lines.slice(1)) {
    const read = readBodyLine(line)
    if (!read.ok) throw new Error(read.error)
    if ('end' in read.value) return
    yield read.value
  }
}

const importText = (text: string) => applyArchive(recordsOf(text))

async function seed(): Promise<void> {
  const d = getDb()!
  await d.attempts.bulkAdd([attempt(), attempt({ itemIndex: 1, userMoveSan: 'Nc3' })])
  await d.games.put(game({ analysedAt: 5, analysisNodes: 400_000, evalByPly: [{ whitePct: 51, label: '+0.1' }] }))
  await d.dbSources.put(source())
  await d.dbGames.bulkPut([dbGame(), dbGame({ key: 'other', movetext: 'd4 d5' })])
  await d.dbAnalysis.put(analysis())
}

const counts = async () => {
  const d = getDb()!
  return {
    attempts: await d.attempts.count(),
    games: await d.games.count(),
    dbSources: await d.dbSources.count(),
    dbGames: await d.dbGames.count(),
    dbAnalysis: await d.dbAnalysis.count(),
  }
}

// ---------- the round trip ----------

describe('exporting and importing a history', () => {
  it('brings back every table it took, into an empty profile', async () => {
    await seed()
    const text = await exportToText()
    const d = getDb()!
    await Promise.all(d.tables.map((t) => t.clear()))

    const { report, error } = await importText(text)

    expect(error).toBeUndefined()
    expect(await counts()).toEqual({
      attempts: 2,
      games: 1,
      dbSources: 1,
      dbGames: 2,
      dbAnalysis: 1,
    })
    expect(report.sections.attempt.added).toBe(2)
    expect(report.sections.game.added).toBe(1)
    expect(report.sections.dbGame.added).toBe(2)
    expect(report.sections.dbAnalysis.added).toBe(1)
  })

  it('keeps the typed reason, the tier and the swing — the part with no other source', async () => {
    await seed()
    const text = await exportToText()
    const d = getDb()!
    await Promise.all(d.tables.map((t) => t.clear()))
    await importText(text)

    const stored = await d.attempts.orderBy('createdAt').toArray()
    expect(stored.map((a) => a.reason)).toContain('the light squares are where the play is')
    expect(stored[0]?.tier).toBe('B')
    expect(stored[0]?.swing).toBe(3.5)
    expect(stored[0]?.fen).toBe(attempt().fen)
  })

  it('keeps the node budget an analysis ran at, and the position it ran from', async () => {
    // #144 decides whether stored work still counts from `analysisNodes`, and
    // #133 discards an analysis whose `startFen` does not match its game. An
    // import that lost either would make a deep pass look shallow, or file
    // minutes of engine time against the wrong game.
    const d = getDb()!
    await d.dbGames.put(dbGame({ key: 'study', startFen: '8/8/8/8/8/8/8/K1k5 w - - 0 1' }))
    await d.dbAnalysis.put(
      analysis({ key: 'study', analysisNodes: 4_000_000, startFen: '8/8/8/8/8/8/8/K1k5 w - - 0 1' }),
    )
    const text = await exportToText()
    await Promise.all(d.tables.map((t) => t.clear()))
    await importText(text)

    const back = await d.dbAnalysis.get('study')
    expect(back?.analysisNodes).toBe(4_000_000)
    expect(back?.startFen).toBe('8/8/8/8/8/8/8/K1k5 w - - 0 1')
    expect(back?.analysedAt).toBe(9_000)
  })

  it('keeps a sparse evalByPly sparse rather than turning its gaps into zeroes', async () => {
    const d = getDb()!
    const sparse: (undefined | { whitePct: number; label: string })[] = []
    sparse[2] = { whitePct: 61, label: '+0.5' }
    await d.games.put(game({ gameId: 'sparse', evalByPly: sparse, analysedAt: 1, analysisNodes: 400_000 }))
    const text = await exportToText()
    await Promise.all(d.tables.map((t) => t.clear()))
    await importText(text)

    const back = await d.games.where('gameId').equals('sparse').first()
    expect(back?.evalByPly).toHaveLength(3)
    expect(back?.evalByPly?.[0]).toBeUndefined()
    expect(back?.evalByPly?.[2]?.whitePct).toBe(61)
  })
})

// ---------- idempotency ----------

describe('importing the same file twice', () => {
  it('leaves one copy of everything, not two', async () => {
    await seed()
    const text = await exportToText()
    const d = getDb()!
    await Promise.all(d.tables.map((t) => t.clear()))

    await importText(text)
    const afterFirst = await counts()
    const { report } = await importText(text)

    expect(await counts()).toEqual(afterFirst)
    // And it says so, rather than reporting the same rows as freshly imported.
    expect(report.sections.attempt).toMatchObject({ added: 0, unchanged: 2 })
    expect(report.sections.game).toMatchObject({ added: 0, updated: 0, unchanged: 1 })
    expect(report.sections.dbGame).toMatchObject({ added: 0, unchanged: 2 })
    expect(report.sections.dbAnalysis).toMatchObject({ added: 0, updated: 0, unchanged: 1 })
  })

  it('is idempotent over the profile it was exported from, too', async () => {
    // Re-importing your own export onto the machine that made it is the accident
    // that would double a training history if identity were per-row rather than
    // per-content.
    await seed()
    const before = await counts()
    const text = await exportToText()

    await importText(text)

    expect(await counts()).toEqual(before)
  })
})

// ---------- merge, never replace ----------

describe('merging into a profile that already has history', () => {
  it('adds the file’s rows without removing any of its own', async () => {
    await seed()
    const text = await exportToText()
    const d = getDb()!
    await Promise.all(d.tables.map((t) => t.clear()))
    // A second machine, with its own history that the file knows nothing about.
    await d.attempts.add(attempt({ sessionId: 'local', reason: 'mine alone' }))
    await d.games.put(game({ gameId: 'local', createdAt: 2000, sanHistory: ['d4'] }))
    await d.dbGames.put(dbGame({ key: 'local-only', source: 'mine.pgn' }))

    await importText(text)

    const attempts = await d.attempts.toArray()
    expect(attempts).toHaveLength(3)
    expect(attempts.map((a) => a.reason)).toContain('mine alone')
    expect(await d.games.count()).toBe(2)
    expect(await d.dbGames.get('local-only')).toBeDefined()
  })

  it('never replaces a completed deep pass with a shallower one', async () => {
    const d = getDb()!
    await d.dbGames.put(dbGame())
    await d.dbAnalysis.put(analysis({ analysisNodes: 400_000 }))
    const shallow = await exportToText()
    // The target has since had a 4M pass run over the same game off-app.
    await d.dbAnalysis.put(analysis({ analysisNodes: 4_000_000, analysedAt: 20_000 }))

    const { report } = await importText(shallow)

    expect((await d.dbAnalysis.get(dbGame().key))?.analysisNodes).toBe(4_000_000)
    expect(report.sections.dbAnalysis).toMatchObject({ updated: 0, unchanged: 1 })
  })

  it('takes a deeper pass from the file when this device only has a shallow one', async () => {
    const d = getDb()!
    await d.dbGames.put(dbGame())
    await d.dbAnalysis.put(analysis({ analysisNodes: 4_000_000, analysedAt: 20_000 }))
    const deep = await exportToText()
    await d.dbAnalysis.put(analysis({ analysisNodes: 250_000 }))

    const { report } = await importText(deep)

    expect((await d.dbAnalysis.get(dbGame().key))?.analysisNodes).toBe(4_000_000)
    expect(report.sections.dbAnalysis.updated).toBe(1)
  })

  it('does not let a played game’s analysis be reverted by a copy without one', async () => {
    const d = getDb()!
    // Through `saveGame`, which upserts by gameId — a bare `put` on an
    // auto-increment table appends a second row instead of correcting the first.
    await saveGame(game())
    const noAnalysis = await exportToText()
    await saveGame(game({ analysedAt: 7, analysisNodes: 800_000, evalByPly: [{ whitePct: 60, label: '+0.4' }] }))

    await importText(noAnalysis)

    const back = await d.games.where('gameId').equals('m1000').first()
    expect(back?.analysedAt).toBe(7)
    expect(back?.analysisNodes).toBe(800_000)
  })

  it('files an analysis of a different starting position as not applicable', async () => {
    // The dedup key hashes movetext but not the [FEN] tag (#133), so an analysis
    // can arrive under a key this device holds a *different* game at. Attaching
    // it would put evaluations against positions the game was never in.
    const d = getDb()!
    await d.dbGames.put(dbGame({ key: 'shared' })) // standard start
    const text = [
      JSON.stringify({ format: 'etude-chess-history', version: 1, createdAt: 1, app: 't' }),
      JSON.stringify({
        t: 'dbAnalysis',
        r: { key: 'shared', startFen: '8/8/8/8/8/8/8/K1k5 w - - 0 1', analysedAt: 1, analysisNodes: 400_000 },
      }),
      '',
    ].join('\n')

    const { report } = await importText(text)

    expect(await d.dbAnalysis.get('shared')).toBeUndefined()
    expect(report.sections.dbAnalysis.skipped).toBe(1)
  })

  it('lands a played game beside one that stole its id, rather than on top of it', async () => {
    // `gameId` is `m${Date.now()}` — unique on one machine, not across two.
    const d = getDb()!
    await d.games.put(game({ gameId: 'm1000', sanHistory: ['d4', 'd5'], accuracy: 40 }))
    const text = [
      JSON.stringify({ format: 'etude-chess-history', version: 1, createdAt: 1, app: 't' }),
      JSON.stringify({ t: 'game', r: game({ accuracy: 91 }) }),
      '',
    ].join('\n')

    const { report } = await importText(text)

    expect(await d.games.count()).toBe(2)
    expect((await d.games.where('gameId').equals('m1000').first())?.accuracy).toBe(40)
    expect((await d.games.where('gameId').equals('m1000~1').first())?.accuracy).toBe(91)
    expect(report.renamed).toBe(1)
    // And the same file again finds its own renamed row rather than making a third.
    await importText(text)
    expect(await d.games.count()).toBe(2)
  })

  it('keeps this machine’s record of an attached source, and recounts its games', async () => {
    const d = getDb()!
    await seed()
    const text = await exportToText()
    await d.dbGames.clear()
    await d.dbSources.put(source({ games: 999, importedAt: 42 }))

    await importText(text)

    const stored = await d.dbSources.get('classics.pgn')
    expect(stored?.importedAt).toBe(42) // this machine's own import record stands
    expect(stored?.games).toBe(2) // but the count is what is actually here
  })
})

// ---------- what travels, and what doesn't ----------

describe('what an export carries', () => {
  it('can leave the attached database behind and still bring the analyses', async () => {
    await seed()
    const text = await exportToText(false)
    const d = getDb()!
    await Promise.all(d.tables.map((t) => t.clear()))

    await importText(text)

    expect(await d.dbGames.count()).toBe(0)
    // The expensive half travels either way: it is small, and it finds its game
    // again by the dedup key whenever the database is re-attached.
    expect(await d.dbAnalysis.count()).toBe(1)
    expect(await d.attempts.count()).toBe(2)
  })

  it('backfills the search tokens of a row that arrives without them', async () => {
    // A multiEntry index can only index a field that is there, and a game with
    // no `names` is stored, searchable by nothing, and silently missing.
    const d = getDb()!
    const text = [
      JSON.stringify({ format: 'etude-chess-history', version: 1, createdAt: 1, app: 't' }),
      JSON.stringify({ t: 'dbGame', r: { ...dbGame({ key: 'bare' }), names: undefined } }),
      '',
    ].join('\n')

    await importText(text)

    expect((await d.dbGames.get('bare'))?.names).toContain('morphy')
  })

  it('exports an empty profile as a header and a footer, and importing it is a no-op', async () => {
    const text = await exportToText()
    expect(text.trim().split('\n')).toHaveLength(2)

    const { report, error } = await importText(text)

    expect(error).toBeUndefined()
    expect(report.renamed).toBe(0)
    expect(await counts()).toMatchObject({ attempts: 0, games: 0, dbGames: 0 })
  })
})

describe('sizing an export before it is built', () => {
  it('separates the part that can be gigabytes from the part that cannot be re-fetched', async () => {
    await seed()
    const estimate = await estimateArchive()

    expect(estimate.sections.attempt.rows).toBe(2)
    expect(estimate.sections.dbGame.rows).toBe(2)
    expect(estimate.databaseBytes).toBeGreaterThan(0)
    expect(estimate.historyBytes).toBeGreaterThan(0)
    // Every row was measured, so these are exact rather than extrapolated.
    expect(estimate.sections.attempt.exact).toBe(true)
  })

  it('is zero over an empty profile rather than a guess', async () => {
    const estimate = await estimateArchive()
    expect(estimate.historyBytes).toBe(0)
    expect(estimate.databaseBytes).toBe(0)
  })
})
