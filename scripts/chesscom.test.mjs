import { describe, it, expect, afterEach, vi } from 'vitest'
import { archiveMonths, eachGame, fetchGame, gameId, monthKey } from './chesscom.mjs'

// The archive scan is shared by `npm run review` and `npm run coach` (#137), so
// a defect here now costs both. Two of these are regressions with a history:
// `gameId` picking up a flag's value as a game id, and pooling time controls.

const ARCHIVES = 'https://api.chess.com/pub/player/someone/games/archives'
const month = (key) => `https://api.chess.com/pub/player/someone/games/${key}`

/** A fake chess.com: a map of URL → body. Anything else is a 404. */
function serve(bodies) {
  const calls = []
  vi.stubGlobal('fetch', async (url) => {
    calls.push(url)
    const body = bodies[url]
    if (!body) return { ok: false, status: 404, statusText: 'Not Found' }
    return { ok: true, json: async () => body }
  })
  return calls
}

const game = (id, timeClass) => ({ url: `https://www.chess.com/game/live/${id}`, time_class: timeClass })

afterEach(() => vi.unstubAllGlobals())

describe('gameId', () => {
  it('takes the id out of a chess.com URL', () => {
    expect(gameId('https://www.chess.com/game/live/141592653')).toBe('141592653')
    expect(gameId('141592653')).toBe('141592653')
  })

  it('is null for anything without a long enough run of digits', () => {
    // Six digits is the floor on purpose — it is what stops `--nodes 800000`
    // reading as a game id and sending the archive scan hunting for a game that
    // does not exist. The caller's job is to not offer it a flag value; this
    // one's is to not invent an id out of a short number.
    expect(gameId('--last')).toBeNull()
    expect(gameId('12345')).toBeNull()
    expect(gameId(null)).toBeNull()
  })
})

describe('monthKey', () => {
  it('reads YYYY/MM off an archive URL, with or without a trailing slash', () => {
    expect(monthKey(month('2026/07'))).toBe('2026/07')
    expect(monthKey(`${month('2026/07')}/`)).toBe('2026/07')
    expect(monthKey('nonsense')).toBe('')
  })
})

describe('archiveMonths', () => {
  it('returns months newest first — chess.com sends them the other way', () => {
    serve({ [ARCHIVES]: { archives: [month('2026/05'), month('2026/06'), month('2026/07')] } })
    return expect(archiveMonths('someone')).resolves.toEqual([
      month('2026/07'),
      month('2026/06'),
      month('2026/05'),
    ])
  })

  it('throws with the status rather than returning nothing on an unknown player', async () => {
    serve({})
    await expect(archiveMonths('someone')).rejects.toThrow(/404/)
  })
})

describe('fetchGame', () => {
  it('finds a game by id, stopping at the first month that has it', async () => {
    const calls = serve({
      [ARCHIVES]: { archives: [month('2026/06'), month('2026/07')] },
      [month('2026/07')]: { games: [game('111111', 'rapid')] },
      [month('2026/06')]: { games: [game('222222', 'blitz')] },
    })
    expect((await fetchGame({ user: 'someone', id: '111111' })).url).toContain('111111')
    expect(calls).toHaveLength(2) // archives + the newest month, and it stopped
  })

  it('takes the last game of the newest non-empty month for --last', async () => {
    serve({
      [ARCHIVES]: { archives: [month('2026/06'), month('2026/07')] },
      [month('2026/07')]: { games: [] },
      [month('2026/06')]: { games: [game('222222', 'blitz'), game('333333', 'rapid')] },
    })
    expect((await fetchGame({ user: 'someone', last: true })).url).toContain('333333')
  })

  it('returns null when the archive does not have it', async () => {
    serve({
      [ARCHIVES]: { archives: [month('2026/07')] },
      [month('2026/07')]: { games: [game('111111', 'rapid')] },
    })
    expect(await fetchGame({ user: 'someone', id: '999999' })).toBeNull()
  })
})

describe('eachGame', () => {
  const archive = {
    [ARCHIVES]: { archives: [month('2026/06'), month('2026/07')] },
    [month('2026/07')]: { games: [game('111111', 'blitz'), game('222222', 'rapid')] },
    [month('2026/06')]: { games: [game('333333', 'daily'), game('444444', 'blitz')] },
  }
  const ids = async (opts) => {
    const out = []
    for await (const g of eachGame(opts)) out.push(gameId(g.url))
    return out
  }

  it('yields only the time classes asked for', async () => {
    serve(archive)
    expect(await ids({ user: 'someone', timeClasses: ['rapid', 'daily'] })).toEqual(['222222', '333333'])
  })

  it('refuses an empty time-class set rather than defaulting to everything', async () => {
    // The pooling bug wearing a default value: "no filter" would hand the coach
    // report a blitz-dominated sample that ranks perfectly happily.
    serve(archive)
    await expect(ids({ user: 'someone', timeClasses: [] })).rejects.toThrow(/at least one time class/)
  })

  it('yields newest first, within the month as well as across months', async () => {
    serve(archive)
    expect(await ids({ user: 'someone', timeClasses: ['blitz'] })).toEqual(['111111', '444444'])
  })

  it('skips a month older than --since without requesting it', async () => {
    const calls = serve(archive)
    expect(await ids({ user: 'someone', timeClasses: ['blitz', 'daily'], since: '2026/07' })).toEqual([
      '111111',
    ])
    expect(calls).not.toContain(month('2026/06'))
  })

  it('does not fetch the second month until the first is consumed', async () => {
    // It is a generator because the caller spends minutes of engine time per
    // game: a --limit run should make one request, not twenty.
    const calls = serve(archive)
    const iterator = eachGame({ user: 'someone', timeClasses: ['blitz', 'rapid', 'daily'] })
    await iterator.next()
    expect(calls).toEqual([ARCHIVES, month('2026/07')])
  })
})
