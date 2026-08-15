import { describe, it, expect } from 'vitest'
import {
  acceptGame,
  archiveIndexUrl,
  chesscomSourceName,
  chesscomUserOfSource,
  gamesOfMonth,
  isSettled,
  isUsableUser,
  mergeSyncedMonth,
  monthEndMs,
  monthsToFetch,
  normalizeClasses,
  parseArchiveIndex,
  type ArchiveMonth,
  type SyncedMonth,
  type TimeClass,
} from './chesscom'

/**
 * A handle that is deliberately **not** the owner's (CLAUDE.md: it is his to
 * publish, and it is already in this repo's history once from a mistake). Every
 * fixture in the suite uses this one.
 */
const USER = 'test-player'

const at = (iso: string) => Date.parse(iso)

const month = (month: string): ArchiveMonth => ({
  url: `https://api.chess.com/pub/player/${USER}/games/${month.replace('-', '/')}`,
  month,
})

const synced = (month: string, classes: TimeClass[], syncedAt: string): SyncedMonth => ({
  month,
  classes,
  syncedAt: at(syncedAt),
})

describe('the account', () => {
  it('lowercases the handle, because chess.com handles are case-insensitive', () => {
    expect(archiveIndexUrl('  Test-Player  ')).toBe(
      `https://api.chess.com/pub/player/${USER}/games/archives`,
    )
  })

  it('rejects anything that would change which URL is requested', () => {
    expect(isUsableUser(USER)).toBe(true)
    expect(isUsableUser('Magnus_1990')).toBe(true)
    expect(isUsableUser('')).toBe(false)
    expect(isUsableUser('two words')).toBe(false)
    expect(isUsableUser('../../games')).toBe(false)
    expect(isUsableUser('who?q=1')).toBe(false)
  })

  it('names a source per account, so two accounts do not overwrite each other', () => {
    expect(chesscomSourceName('Test-Player')).toBe(`chess.com/${USER}`)
    expect(chesscomUserOfSource(`chess.com/${USER}`)).toBe(USER)
    // An attached file is not a synced account and must not be mistaken for one.
    expect(chesscomUserOfSource('masters.pgn')).toBeUndefined()
  })
})

describe('parseArchiveIndex', () => {
  it('reads the month out of each URL and sorts oldest first', () => {
    expect(
      parseArchiveIndex({
        archives: [
          `https://api.chess.com/pub/player/${USER}/games/2026/08`,
          `https://api.chess.com/pub/player/${USER}/games/2025/12`,
        ],
      }),
    ).toEqual([month('2025-12'), month('2026-08')])
  })

  it('drops a URL it cannot name a month from, rather than guessing at one', () => {
    // We record months as done by name; a month we cannot name could never be
    // recorded, so it would be re-fetched forever or filed under the wrong label.
    const parsed = parseArchiveIndex({
      archives: [
        `https://api.chess.com/pub/player/${USER}/games/2026/08`,
        `https://api.chess.com/pub/player/${USER}/games/latest`,
        42,
      ],
    })
    expect(parsed).toEqual([month('2026-08')])
  })

  it('is empty rather than fatal when the payload is not what we expect', () => {
    expect(parseArchiveIndex(null)).toEqual([])
    expect(parseArchiveIndex({})).toEqual([])
    expect(parseArchiveIndex({ archives: 'nope' })).toEqual([])
  })
})

describe('monthEndMs', () => {
  it('is midnight UTC on the first of the following month', () => {
    expect(monthEndMs('2026-07')).toBe(at('2026-08-01T00:00:00Z'))
    // December has to roll the year, which is the one case a hand-rolled
    // month+1 gets wrong.
    expect(monthEndMs('2026-12')).toBe(at('2027-01-01T00:00:00Z'))
  })
})

describe('monthsToFetch', () => {
  const now = at('2026-08-15T12:00:00Z')
  const archives = [month('2026-06'), month('2026-07'), month('2026-08')]

  it('fetches everything when nothing has been synced', () => {
    expect(monthsToFetch(archives, [], ['rapid'], now)).toEqual(archives)
  })

  it('skips a settled month already covered — the whole point of being polite', () => {
    const record = [
      synced('2026-06', ['rapid'], '2026-07-02T00:00:00Z'),
      synced('2026-07', ['rapid'], '2026-08-02T00:00:00Z'),
    ]
    expect(monthsToFetch(archives, record, ['rapid'], now)).toEqual([month('2026-08')])
  })

  it('always re-fetches the month we are still in, however recently it was synced', () => {
    // Recording the current month as done would mean every game played for the
    // rest of it never arrives.
    const record = [synced('2026-08', ['rapid'], '2026-08-15T11:59:00Z')]
    expect(monthsToFetch(archives, record, ['rapid'], now)).toContainEqual(month('2026-08'))
  })

  it('re-fetches a month synced before it ended', () => {
    const record = [synced('2026-07', ['rapid'], '2026-07-20T00:00:00Z')]
    expect(isSettled(record[0]!)).toBe(false)
    expect(monthsToFetch(archives, record, ['rapid'], now)).toContainEqual(month('2026-07'))
  })

  it('re-fetches a month when a class it never covered is now wanted', () => {
    // Sync rapid, then come back for blitz: a plain "done" flag would skip the
    // month and return nothing at all.
    const record = [synced('2026-06', ['rapid'], '2026-07-02T00:00:00Z')]
    expect(monthsToFetch(archives, record, ['rapid', 'blitz'], now)).toContainEqual(month('2026-06'))
  })

  it('does not re-fetch when the wanted classes narrow', () => {
    const record = [synced('2026-06', ['rapid', 'blitz'], '2026-07-02T00:00:00Z')]
    expect(monthsToFetch(archives, record, ['rapid'], now)).not.toContainEqual(month('2026-06'))
  })
})

describe('mergeSyncedMonth', () => {
  it('widens the classes a month covers instead of replacing them', () => {
    const before = [synced('2026-06', ['rapid'], '2026-07-02T00:00:00Z')]
    const after = mergeSyncedMonth(before, synced('2026-06', ['blitz'], '2026-08-01T00:00:00Z'))
    expect(after).toEqual([
      { month: '2026-06', classes: ['blitz', 'rapid'], syncedAt: at('2026-08-01T00:00:00Z') },
    ])
  })

  it('keeps the record sorted and does not duplicate a month', () => {
    let record: SyncedMonth[] = []
    record = mergeSyncedMonth(record, synced('2026-07', ['rapid'], '2026-08-02T00:00:00Z'))
    record = mergeSyncedMonth(record, synced('2026-06', ['rapid'], '2026-08-02T00:00:00Z'))
    record = mergeSyncedMonth(record, synced('2026-06', ['rapid'], '2026-08-03T00:00:00Z'))
    expect(record.map((r) => r.month)).toEqual(['2026-06', '2026-07'])
  })
})

describe('normalizeClasses', () => {
  it('puts a stored set in one fixed order and drops what it does not know', () => {
    expect(normalizeClasses(['rapid', 'bullet', 'rapid', 'ultrabullet'])).toEqual([
      'bullet',
      'rapid',
    ])
  })
})

describe('gamesOfMonth', () => {
  it('reads the games array and survives anything else', () => {
    expect(gamesOfMonth({ games: [{ pgn: 'x' }, null, 7] })).toEqual([{ pgn: 'x' }])
    expect(gamesOfMonth({})).toEqual([])
    expect(gamesOfMonth(undefined)).toEqual([])
  })
})

describe('acceptGame', () => {
  const game = { pgn: '[Event "Live Chess"]\n\n1. e4 e5 *', time_class: 'rapid', rules: 'chess' }

  it('keeps a game in a class the user picked', () => {
    expect(acceptGame(game, ['rapid', 'daily'])).toEqual({ keep: true, pgn: game.pgn })
  })

  it('skips a class the user did not pick, and says that is why', () => {
    expect(acceptGame(game, ['daily'])).toEqual({ keep: false, reason: 'time-class' })
  })

  it('treats a class it has never heard of as one the user did not pick', () => {
    // A class invented after this was written is by definition not one that was
    // chosen, so it must not slip through as "unknown, keep it".
    expect(acceptGame({ ...game, time_class: 'ultrabullet' }, ['rapid'])).toEqual({
      keep: false,
      reason: 'time-class',
    })
    expect(acceptGame({ ...game, time_class: undefined }, ['rapid'])).toEqual({
      keep: false,
      reason: 'time-class',
    })
  })

  it('skips a variant on `rules`, which is more reliable than the PGN tag', () => {
    expect(acceptGame({ ...game, rules: 'chess960' }, ['rapid'])).toEqual({
      keep: false,
      reason: 'variant',
    })
  })

  it('skips a game with no movetext without calling it unreadable', () => {
    expect(acceptGame({ ...game, pgn: '  ' }, ['rapid'])).toEqual({ keep: false, reason: 'no-moves' })
    expect(acceptGame({ ...game, pgn: undefined }, ['rapid'])).toEqual({
      keep: false,
      reason: 'no-moves',
    })
  })
})
