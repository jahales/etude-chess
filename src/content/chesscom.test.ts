// Syncing an account: what happens between chess.com and the caller's writer.
//
// `fetch` is injected, so every case here is a real end-to-end run of the module
// — the index, the month loop, the filters and the failures — with nothing
// stubbed but the socket. What is worth pinning down is mostly *restraint*: that
// the index is asked for once, that months go out one at a time and only when
// they are needed, that a write is awaited before the next request, and that a
// wrong handle is a named failure rather than a quiet zero.
import { describe, it, expect, vi } from 'vitest'
import type { ArchiveMonth, SyncedMonth, TimeClass } from '../domain/chesscom'
import type { ImportedRecord } from './pgnImport'
import {
  ChesscomError,
  retryAfterMs,
  syncChesscomGames,
  type FetchLike,
  type SyncOptions,
} from './chesscom'

/** Not the owner's handle, and deliberately so — CLAUDE.md keeps his out of the repo. */
const USER = 'test-player'

const NOW = Date.parse('2026-08-15T12:00:00Z')

const monthUrl = (month: string) =>
  `https://api.chess.com/pub/player/${USER}/games/${month.replace('-', '/')}`

/** A chess.com live-game PGN, clock comments and all — theirs look exactly like this. */
const pgn = (over: Record<string, string> = {}, moves?: string) => {
  const tags: Record<string, string> = {
    Event: 'Live Chess',
    Site: 'Chess.com',
    Date: '2026.08.02',
    White: USER,
    Black: 'other-player',
    Result: '1-0',
    WhiteElo: '1355',
    BlackElo: '1340',
    TimeControl: '600',
    Termination: `${USER} won by resignation`,
    ...over,
  }
  const header = Object.entries(tags)
    .map(([k, v]) => `[${k} "${v}"]`)
    .join('\n')
  const movetext =
    moves ??
    '1. e4 {[%clk 0:09:58]} e5 {[%clk 0:09:57]} 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 1-0'
  return `${header}\n\n${movetext}\n`
}

const game = (over: Record<string, unknown> = {}) => ({
  url: `https://www.chess.com/game/live/1`,
  pgn: pgn(),
  time_class: 'rapid',
  rules: 'chess',
  ...over,
})

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** A fake network. Records every URL asked for, in order. */
function fakeFetch(routes: Record<string, () => Response>) {
  const asked: string[] = []
  const inits: (object | undefined)[] = []
  const impl: FetchLike = (url, init) => {
    asked.push(url)
    inits.push(init)
    const route = routes[url]
    if (!route) return Promise.resolve(new Response(null, { status: 404 }))
    return Promise.resolve(route())
  }
  return { impl, asked, inits }
}

const archives = (months: string[]) => () => json({ archives: months.map(monthUrl) })

const run = (
  fetchImpl: FetchLike,
  over: Partial<SyncOptions> = {},
  collected: ImportedRecord[] = [],
) =>
  syncChesscomGames({
    user: USER,
    classes: ['rapid'] as TimeClass[],
    fetchImpl,
    pauseMs: 0,
    now: () => NOW,
    onBatch: (games) => {
      collected.push(...games)
    },
    ...over,
  })

describe('syncChesscomGames', () => {
  it('fetches the index once, then each month, and imports the games', async () => {
    const kept: ImportedRecord[] = []
    const net = fakeFetch({
      [`https://api.chess.com/pub/player/${USER}/games/archives`]: archives(['2026-07', '2026-08']),
      [monthUrl('2026-07')]: () => json({ games: [game()] }),
      [monthUrl('2026-08')]: () => json({ games: [game(), game({ pgn: pgn({ Date: '2026.08.09' }) })] }),
    })

    const progress = await run(net.impl, {}, kept)

    expect(net.asked).toEqual([
      `https://api.chess.com/pub/player/${USER}/games/archives`,
      monthUrl('2026-07'),
      monthUrl('2026-08'),
    ])
    expect(progress.fetched).toBe(3)
    expect(progress.kept).toBe(3)
    expect(progress.monthsDone).toBe(2)
    expect(kept).toHaveLength(3)
  })

  it('takes the games through the same path a file import does', async () => {
    const kept: ImportedRecord[] = []
    const net = fakeFetch({
      [`https://api.chess.com/pub/player/${USER}/games/archives`]: archives(['2026-08']),
      [monthUrl('2026-08')]: () => json({ games: [game()] }),
    })

    await run(net.impl, {}, kept)

    const [record] = kept
    expect(record?.facts.white).toBe(USER)
    expect(record?.facts.result).toBe('1-0')
    // `600` is rapid on the clock, and `describeGame` is what says so.
    expect(record?.facts.timeControl.speed).toBe('rapid')
    expect(record?.facts.whiteElo).toBe(1355)
    expect(record?.game.sanMoves.slice(0, 3)).toEqual(['e4', 'e5', 'Nf3'])
    // A chess.com export stamps `[%clk]` on every ply and writes nothing else.
    // `normalizeGame` strips those, so the game must arrive with no annotation
    // at all rather than with a comment on every move (#129).
    expect(record?.game.comments).toBeUndefined()
  })

  it('imports only the time classes the user picked', async () => {
    const net = fakeFetch({
      [`https://api.chess.com/pub/player/${USER}/games/archives`]: archives(['2026-08']),
      [monthUrl('2026-08')]: () =>
        json({
          games: [
            game({ time_class: 'rapid' }),
            game({ time_class: 'blitz' }),
            game({ time_class: 'bullet' }),
            game({ time_class: 'daily', pgn: pgn({ TimeControl: '1/259200' }) }),
          ],
        }),
    })

    const progress = await run(net.impl, { classes: ['rapid', 'daily'] })

    expect(progress.kept).toBe(2)
    expect(progress.skippedByReason['time-class']).toBe(2)
  })

  it('asks for nothing at all when no class is picked', async () => {
    const net = fakeFetch({})
    const progress = await run(net.impl, { classes: [] })
    expect(net.asked).toEqual([])
    expect(progress.kept).toBe(0)
  })

  it('skips a variant on `rules`, and a game too short to ask a question about', async () => {
    const net = fakeFetch({
      [`https://api.chess.com/pub/player/${USER}/games/archives`]: archives(['2026-08']),
      [monthUrl('2026-08')]: () =>
        json({
          games: [
            game({ rules: 'chess960' }),
            game({ pgn: pgn({}, '1. e4 e5 2. Nf3 Nc6 1-0') }),
            game(),
          ],
        }),
    })

    const progress = await run(net.impl)

    expect(progress.kept).toBe(1)
    expect(progress.skippedByReason.variant).toBe(1)
    expect(progress.skippedByReason['too-short']).toBe(1)
  })

  it('does not ask again for a settled month it already has', async () => {
    const synced: SyncedMonth[] = [
      { month: '2026-07', classes: ['rapid'], syncedAt: Date.parse('2026-08-02T00:00:00Z') },
    ]
    const net = fakeFetch({
      [`https://api.chess.com/pub/player/${USER}/games/archives`]: archives(['2026-07', '2026-08']),
      [monthUrl('2026-08')]: () => json({ games: [game()] }),
    })

    const progress = await run(net.impl, { synced })

    expect(net.asked).not.toContain(monthUrl('2026-07'))
    expect(progress.months).toBe(1)
    expect(progress.monthsSkipped).toBe(1)
  })

  it('waits for each month to be stored before requesting the next', async () => {
    // The back-pressure contract: without it a fast network queues an account in
    // memory while IndexedDB works through it.
    const order: string[] = []
    const net = fakeFetch({
      [`https://api.chess.com/pub/player/${USER}/games/archives`]: archives(['2026-07', '2026-08']),
      [monthUrl('2026-07')]: () => {
        order.push('fetch 2026-07')
        return json({ games: [game()] })
      },
      [monthUrl('2026-08')]: () => {
        order.push('fetch 2026-08')
        return json({ games: [game()] })
      },
    })

    await run(net.impl, {
      onBatch: async (_games, month: ArchiveMonth) => {
        await Promise.resolve()
        order.push(`stored ${month.month}`)
      },
    })

    expect(order).toEqual([
      'fetch 2026-07',
      'stored 2026-07',
      'fetch 2026-08',
      'stored 2026-08',
    ])
  })

  it('reports a month as done even when it kept nothing, so it is not re-fetched', async () => {
    const done: SyncedMonth[] = []
    const net = fakeFetch({
      [`https://api.chess.com/pub/player/${USER}/games/archives`]: archives(['2026-07']),
      [monthUrl('2026-07')]: () => json({ games: [game({ time_class: 'bullet' })] }),
    })

    await run(net.impl, { onMonth: (record) => void done.push(record) })

    expect(done).toEqual([{ month: '2026-07', classes: ['rapid'], syncedAt: NOW }])
  })

  it('never sets a User-Agent, which browsers forbid anyway', async () => {
    const net = fakeFetch({
      [`https://api.chess.com/pub/player/${USER}/games/archives`]: archives([]),
    })
    await run(net.impl)
    for (const init of net.inits) {
      expect(init).not.toHaveProperty('headers')
    }
  })

  it('stops between months when the sync is cancelled', async () => {
    const controller = new AbortController()
    const net = fakeFetch({
      [`https://api.chess.com/pub/player/${USER}/games/archives`]: archives(['2026-07', '2026-08']),
      [monthUrl('2026-07')]: () => json({ games: [game()] }),
      [monthUrl('2026-08')]: () => json({ games: [game()] }),
    })

    const progress = await run(net.impl, {
      onBatch: () => controller.abort(),
      signal: controller.signal,
    })

    expect(net.asked).not.toContain(monthUrl('2026-08'))
    // Resolves rather than throws: what was stored stays stored, and the caller
    // reports it.
    expect(progress.monthsDone).toBe(1)
  })
})

describe('failures', () => {
  const failing = (status: number, headers: Record<string, string> = {}) =>
    fakeFetch({
      [`https://api.chess.com/pub/player/${USER}/games/archives`]: () =>
        new Response(null, { status, headers }),
    })

  it('says "no such user" on a 404 instead of finishing with zero games', async () => {
    // The failure this test exists for: a 404 that fell through to an empty
    // archive list reported "0 games imported", which reads as success and sends
    // you looking at your filters instead of at your spelling.
    const net = failing(404)
    await expect(run(net.impl)).rejects.toMatchObject({ failure: 'no-such-user' })
  })

  it('obeys a Retry-After once, then gives up rather than hammering', async () => {
    let calls = 0
    const impl: FetchLike = (url) => {
      calls++
      if (url.endsWith('/archives') && calls === 1) {
        return Promise.resolve(new Response(null, { status: 429, headers: { 'retry-after': '0' } }))
      }
      return Promise.resolve(json({ archives: [] }))
    }
    await expect(run(impl)).resolves.toMatchObject({ months: 0 })
    expect(calls).toBe(2)

    const always: FetchLike = () =>
      Promise.resolve(new Response(null, { status: 429, headers: { 'retry-after': '0' } }))
    await expect(run(always)).rejects.toMatchObject({ failure: 'rate-limited' })
  })

  it('separates "the site is down" from "we never reached it"', async () => {
    const down = failing(503)
    await expect(run(down.impl)).rejects.toMatchObject({ failure: 'unavailable' })

    const offline: FetchLike = () => Promise.reject(new TypeError('Failed to fetch'))
    await expect(run(offline)).rejects.toMatchObject({ failure: 'network' })
  })

  it('carries a message a person can act on', async () => {
    const net = failing(404)
    const error = await run(net.impl).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ChesscomError)
    expect((error as Error).message).toContain('404')
  })

  it('keeps a month that is unreadable JSON from being reported as an empty month', async () => {
    const net = fakeFetch({
      [`https://api.chess.com/pub/player/${USER}/games/archives`]: () =>
        new Response('<html>maintenance</html>', { status: 200 }),
    })
    await expect(run(net.impl)).rejects.toMatchObject({ failure: 'unavailable' })
  })
})

describe('retryAfterMs', () => {
  const now = Date.parse('2026-08-15T12:00:00Z')

  it('reads seconds and HTTP dates, and caps both', () => {
    expect(retryAfterMs('5', now)).toBe(5000)
    expect(retryAfterMs('Sat, 15 Aug 2026 12:00:10 GMT', now)).toBe(10_000)
    expect(retryAfterMs('86400', now)).toBe(60_000)
  })

  it('is zero for anything it cannot use, so a bad header cannot hang the button', () => {
    expect(retryAfterMs(null, now)).toBe(0)
    expect(retryAfterMs('soon', now)).toBe(0)
    expect(retryAfterMs('-5', now)).toBe(0)
    expect(retryAfterMs('Sat, 15 Aug 2020 12:00:00 GMT', now)).toBe(0)
  })
})

describe('politeness', () => {
  it('pauses between month requests but not before the first', async () => {
    vi.useFakeTimers()
    try {
      const net = fakeFetch({
        [`https://api.chess.com/pub/player/${USER}/games/archives`]: archives([
          '2026-06',
          '2026-07',
        ]),
        [monthUrl('2026-06')]: () => json({ games: [] }),
        [monthUrl('2026-07')]: () => json({ games: [] }),
      })

      const done = vi.fn()
      void run(net.impl, { pauseMs: 1000 }).then(done)

      // The index and the first month go out with no waiting at all.
      await vi.advanceTimersByTimeAsync(0)
      expect(net.asked).toEqual([
        `https://api.chess.com/pub/player/${USER}/games/archives`,
        monthUrl('2026-06'),
      ])

      await vi.advanceTimersByTimeAsync(999)
      expect(net.asked).toHaveLength(2)

      await vi.advanceTimersByTimeAsync(1)
      expect(net.asked).toContain(monthUrl('2026-07'))
    } finally {
      vi.useRealTimers()
    }
  })
})
