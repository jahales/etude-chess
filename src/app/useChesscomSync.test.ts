// Syncing an account: what happens between chess.com and IndexedDB.
//
// `fetch` is stubbed and nothing else is — this runs the real domain rules, the
// real month loop and the real Dexie writes against fake-indexeddb, because the
// claims worth making here are about what ends up *stored*: that a second sync
// lands on the same rows rather than beside them, that a wrong handle is a named
// failure instead of a quiet zero, and that nothing is fetched until a button is
// pressed.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import Dexie from 'dexie'
import { countDbGames, listDbSources, queryDbGames } from '../persist/dbGames'
import { loadPlayerNames, PLAYER_NAMES_KEY } from './settings'
import { CHESSCOM_ACCOUNT_KEY, loadChesscomAccount } from './chesscomAccount'
import { useChesscomSync } from './useChesscomSync'

/** Not the owner's handle — CLAUDE.md keeps his out of the repo entirely. */
const USER = 'test-player'

/**
 * The month we are in, derived rather than written down.
 *
 * A hard-coded month would settle as soon as the calendar passed it, and then
 * `monthsToFetch` would stop asking for it — so the test that proves a re-sync
 * is idempotent would silently start proving nothing instead.
 */
const currentMonth = () => {
  const now = new Date()
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
}

const monthUrl = (month: string) =>
  `https://api.chess.com/pub/player/${USER}/games/${month.replace('-', '/')}`

const ARCHIVES = `https://api.chess.com/pub/player/${USER}/games/archives`

const pgn = (over: Record<string, string> = {}) => {
  const tags = {
    Event: 'Live Chess',
    Site: 'Chess.com',
    Date: '2026.08.02',
    White: USER,
    Black: 'other-player',
    Result: '1-0',
    WhiteElo: '1355',
    BlackElo: '1340',
    TimeControl: '600',
    ...over,
  }
  const header = Object.entries(tags)
    .map(([k, v]) => `[${k} "${v}"]`)
    .join('\n')
  return `${header}\n\n1. e4 {[%clk 0:09:58]} e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 1-0\n`
}

const game = (over: Record<string, unknown> = {}) => ({
  pgn: pgn(),
  time_class: 'rapid',
  rules: 'chess',
  ...over,
})

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })

/** A fake network keyed by URL, recording what was asked for. */
function stubNetwork(routes: Record<string, () => Response>) {
  const asked: string[] = []
  const impl = vi.fn((url: string) => {
    asked.push(url)
    const route = routes[url]
    return Promise.resolve(route ? route() : new Response(null, { status: 404 }))
  })
  vi.stubGlobal('fetch', impl)
  return { asked, impl }
}

/** One month of games, plus the index that lists it. */
const oneMonth = (month: string, games: unknown[]) => ({
  [ARCHIVES]: () => json({ archives: [monthUrl(month)] }),
  [monthUrl(month)]: () => json({ games }),
})

const render = () => renderHook(() => useChesscomSync())

/**
 * An in-memory `Storage`, because the test global has none: vitest copies a
 * jsdom global across only when Node doesn't already define the name, and Node
 * 24 defines `localStorage` itself (as nothing). Same seam `settings.test.ts`
 * uses, for the same reason.
 */
function memoryStorage(): Storage {
  const values = new Map<string, string>()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, String(value)),
    removeItem: (key) => void values.delete(key),
    clear: () => values.clear(),
    key: (i) => [...values.keys()][i] ?? null,
    get length() {
      return values.size
    },
  } as Storage
}

beforeEach(async () => {
  vi.stubGlobal('localStorage', memoryStorage())
  const d = new Dexie('etude-chess')
  try {
    await d.open()
    await Promise.all([d.table('dbGames').clear(), d.table('dbSources').clear()])
  } catch {
    // First run: nothing to clear.
  } finally {
    d.close()
  }
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useChesscomSync', () => {
  it('fetches nothing until a sync is asked for', async () => {
    const net = stubNetwork(oneMonth(currentMonth(), [game()]))
    render()
    await act(async () => {
      await Promise.resolve()
    })
    // Re-syncing on load would be a free public API asked for a decade of PGN
    // because someone refreshed a tab.
    expect(net.asked).toEqual([])
  })

  it('imports an account, one request for the index and one per month', async () => {
    const month = currentMonth()
    const net = stubNetwork(oneMonth(month, [game(), game({ pgn: pgn({ Date: '2026.08.09' }) })]))
    const { result } = render()

    act(() => result.current.sync(USER, ['rapid']))
    await waitFor(() => expect(result.current.state.status).toBe('done'))

    expect(net.asked).toEqual([ARCHIVES, monthUrl(month)])
    expect(result.current.state.written).toBe(2)
    expect(result.current.state.alreadyPresent).toBe(0)
    expect(await countDbGames()).toBe(2)
  })

  it('stores the games under the account as a source you can browse and detach', async () => {
    const net = stubNetwork(oneMonth(currentMonth(), [game()]))
    const { result } = render()

    act(() => result.current.sync('Test-Player', ['rapid']))
    await waitFor(() => expect(result.current.state.status).toBe('done'))

    expect(net.asked[0]).toBe(ARCHIVES)
    const sources = await listDbSources()
    expect(sources).toHaveLength(1)
    expect(sources[0]).toMatchObject({ name: `chess.com/${USER}`, games: 1 })

    const page = await queryDbGames({})
    expect(page.rows[0]).toMatchObject({ white: USER, result: '1-0', speed: 'rapid' })
    // Straight down the file-import path, so `[%clk]` is stripped on the way in.
    expect(page.rows[0]?.comments).toBeUndefined()
  })

  it('is idempotent: syncing twice lands on the same rows, not beside them', async () => {
    // #128's dedup key is what makes this true, and this is the test the issue
    // asks for rather than the assumption it would otherwise be. The month is
    // the current one, so it is re-fetched in full both times — which is exactly
    // the case where duplication would show up.
    const month = currentMonth()
    stubNetwork(oneMonth(month, [game(), game({ pgn: pgn({ Date: '2026.08.09' }) })]))
    const { result } = render()

    act(() => result.current.sync(USER, ['rapid']))
    await waitFor(() => expect(result.current.state.status).toBe('done'))
    const first = await queryDbGames({})
    expect(await countDbGames()).toBe(2)

    act(() => result.current.sync(USER, ['rapid']))
    await waitFor(() => expect(result.current.state.progress.monthsDone).toBe(1))
    await waitFor(() => expect(result.current.state.status).toBe('done'))

    expect(await countDbGames()).toBe(2)
    expect(result.current.state.written).toBe(2)
    // And it says so rather than reporting two fresh imports.
    expect(result.current.state.alreadyPresent).toBe(2)
    const second = await queryDbGames({})
    expect(second.rows.map((r) => r.key)).toEqual(first.rows.map((r) => r.key))
  })

  it('does not ask again for a month that has ended and is already covered', async () => {
    const month = currentMonth()
    const net = stubNetwork({
      [ARCHIVES]: () => json({ archives: [monthUrl('2020-01'), monthUrl(month)] }),
      [monthUrl('2020-01')]: () => json({ games: [game()] }),
      [monthUrl(month)]: () => json({ games: [game({ pgn: pgn({ Date: '2026.08.09' }) })] }),
    })
    const { result } = render()

    act(() => result.current.sync(USER, ['rapid']))
    await waitFor(() => expect(result.current.state.status).toBe('done'))
    expect(net.asked).toContain(monthUrl('2020-01'))

    net.asked.length = 0
    act(() => result.current.sync(USER, ['rapid']))
    await waitFor(() => expect(result.current.state.status).toBe('done'))

    expect(net.asked).not.toContain(monthUrl('2020-01'))
    expect(net.asked).toContain(monthUrl(month))
    expect(result.current.state.progress.monthsSkipped).toBe(1)
  })

  it('re-fetches a settled month when a class it never covered is added', async () => {
    const month = currentMonth()
    const net = stubNetwork({
      [ARCHIVES]: () => json({ archives: [monthUrl('2020-01'), monthUrl(month)] }),
      [monthUrl('2020-01')]: () =>
        json({ games: [game(), game({ time_class: 'blitz', pgn: pgn({ Date: '2020.01.09' }) })] }),
      [monthUrl(month)]: () => json({ games: [] }),
    })
    const { result } = render()

    act(() => result.current.sync(USER, ['rapid']))
    await waitFor(() => expect(result.current.state.status).toBe('done'))
    expect(await countDbGames()).toBe(1)

    net.asked.length = 0
    act(() => result.current.sync(USER, ['rapid', 'blitz']))
    await waitFor(() => expect(result.current.state.status).toBe('done'))

    expect(net.asked).toContain(monthUrl('2020-01'))
    expect(await countDbGames()).toBe(2)
  })

  it("does not carry one account's synced months over to another handle", async () => {
    // The months sit beside the handle, not under it. Writing a new handle over
    // the old one while keeping the list would have the second account skip
    // every settled month the first had already pulled.
    const month = currentMonth()
    const other = 'other-player'
    const net = stubNetwork({
      [ARCHIVES]: () => json({ archives: [monthUrl('2020-01'), monthUrl(month)] }),
      [monthUrl('2020-01')]: () => json({ games: [game()] }),
      [monthUrl(month)]: () => json({ games: [] }),
      [`https://api.chess.com/pub/player/${other}/games/archives`]: () =>
        json({ archives: [`https://api.chess.com/pub/player/${other}/games/2020/01`] }),
      [`https://api.chess.com/pub/player/${other}/games/2020/01`]: () =>
        json({ games: [game({ pgn: pgn({ White: other, Black: USER }) })] }),
    })
    const { result } = render()

    act(() => result.current.sync(USER, ['rapid']))
    await waitFor(() => expect(result.current.state.status).toBe('done'))

    net.asked.length = 0
    act(() => result.current.sync(other, ['rapid']))
    await waitFor(() => expect(result.current.state.status).toBe('done'))

    expect(net.asked).toContain(`https://api.chess.com/pub/player/${other}/games/2020/01`)
    expect(loadChesscomAccount()).toMatchObject({ user: other })
    expect(await countDbGames()).toBe(2)
  })

  it('remembers the handle and the classes, so the form comes back filled in', async () => {
    stubNetwork(oneMonth(currentMonth(), []))
    const { result } = render()

    act(() => result.current.sync('Test-Player', ['rapid', 'daily']))
    await waitFor(() => expect(result.current.state.status).toBe('done'))

    expect(loadChesscomAccount()).toMatchObject({ user: USER, classes: ['rapid', 'daily'] })
    // Stored locally and nowhere else — the handle never leaves the machine.
    expect(localStorage.getItem(CHESSCOM_ACCOUNT_KEY)).toContain(USER)
  })

  it('adds the handle to the names you play under, without disturbing what is there', async () => {
    localStorage.setItem(PLAYER_NAMES_KEY, JSON.stringify(['Lastname, Firstname']))
    stubNetwork(oneMonth(currentMonth(), [game()]))
    const { result } = render()

    act(() => result.current.sync(USER, ['rapid']))
    await waitFor(() => expect(result.current.state.status).toBe('done'))

    // Without this the app has a database of your games and no idea which side
    // of them is you (#130).
    expect(loadPlayerNames()).toEqual(['Lastname, Firstname', USER])

    act(() => result.current.sync(USER, ['rapid']))
    await waitFor(() => expect(result.current.state.status).toBe('done'))
    expect(loadPlayerNames()).toEqual(['Lastname, Firstname', USER])
  })

  it('forgets the synced months when the account is detached', async () => {
    stubNetwork(oneMonth(currentMonth(), [game()]))
    const { result } = render()

    act(() => result.current.sync(USER, ['rapid']))
    await waitFor(() => expect(result.current.state.status).toBe('done'))
    expect(loadChesscomAccount().months).not.toEqual([])

    act(() => result.current.forget(USER))
    // The games are gone, so a record saying those months are done would make
    // the next sync a no-op — "detach and try again" has to work.
    expect(loadChesscomAccount().months).toEqual([])
    expect(loadChesscomAccount().user).toBe(USER)
  })
})

describe('failures the user has to see', () => {
  it('says "no such user" on a 404 rather than finishing with zero games', async () => {
    stubNetwork({})
    const { result } = render()

    act(() => result.current.sync('nobody-here', ['rapid']))
    await waitFor(() => expect(result.current.state.status).toBe('error'))

    expect(result.current.state.failure).toBe('no-such-user')
    expect(result.current.state.error).toContain('No such user')
    // The status is the point: "done, 0 games" reads as success.
    expect(result.current.state.status).not.toBe('done')
  })

  it('refuses a handle that is not one, without asking chess.com about it', async () => {
    const net = stubNetwork({})
    const { result } = render()

    act(() => result.current.sync('two words', ['rapid']))
    expect(result.current.state.status).toBe('error')
    expect(net.asked).toEqual([])
  })

  it('refuses to sync with no time class picked, and asks for one', async () => {
    const net = stubNetwork(oneMonth(currentMonth(), [game()]))
    const { result } = render()

    act(() => result.current.sync(USER, []))
    expect(result.current.state.error).toContain('at least one time control')
    expect(net.asked).toEqual([])
  })

  it('reports a rate limit as itself, so waiting is the obvious next step', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(null, { status: 429, headers: { 'retry-after': '0' } }))),
    )
    const { result } = render()

    act(() => result.current.sync(USER, ['rapid']))
    await waitFor(() => expect(result.current.state.status).toBe('error'))
    expect(result.current.state.failure).toBe('rate-limited')
  })

  it('does not record a month as done when nothing was fetched for it', async () => {
    stubNetwork({})
    const { result } = render()

    act(() => result.current.sync(USER, ['rapid']))
    await waitFor(() => expect(result.current.state.status).toBe('error'))
    expect(loadChesscomAccount().months).toEqual([])
  })
})
