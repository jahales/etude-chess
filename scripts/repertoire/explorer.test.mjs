import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createExplorer } from './explorer.mjs'

// The API path. Unreachable from the network this was built on, which is
// precisely why it needs tests: it is the fallback a user without a local book
// lands on, and nothing else exercises it.

const FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
const realFetch = globalThis.fetch

let dir
let calls
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'explorer-'))
  calls = []
})
afterEach(() => {
  globalThis.fetch = realFetch
})

const payload = (moves = [{ uci: 'e2e4', san: 'e4', white: 10, draws: 2, black: 8 }]) => ({
  white: 100,
  draws: 20,
  black: 80,
  opening: { eco: 'A00', name: 'Start' },
  moves,
})

/**
 * Queue of replies, consumed in order (the last one repeats). An entry is
 * either a Response-like (it has `status`) or a JSON payload to wrap in a 200.
 */
function respondWith(...responses) {
  let i = 0
  globalThis.fetch = async (url) => {
    calls.push(String(url))
    const r = responses[Math.min(i++, responses.length - 1)]
    const resolved = typeof r === 'function' ? r() : r
    if (resolved && typeof resolved.status === 'number') return resolved
    return { ok: true, status: 200, json: async () => resolved }
  }
}

const explorer = (opts = {}) => createExplorer({ cacheDir: dir, minDelayMs: 0, ...opts })

describe('explorer — querying', () => {
  it('returns the slimmed shape the crawler expects', async () => {
    respondWith(payload())
    const r = await explorer().query(FEN)
    expect(r).toMatchObject({ white: 100, draws: 20, black: 80 })
    expect(r.moves[0]).toMatchObject({ san: 'e4', uci: 'e2e4', white: 10, draws: 2, black: 8 })
    expect(r.opening).toMatchObject({ name: 'Start' })
  })

  it('defaults missing counts to zero rather than undefined', async () => {
    respondWith({ moves: [{ uci: 'e2e4', san: 'e4' }] })
    const r = await explorer().query(FEN)
    expect(r.moves[0]).toMatchObject({ white: 0, draws: 0, black: 0 })
    expect(r.white).toBe(0)
  })

  it('sends the rating band and speeds for the amateur endpoint', async () => {
    respondWith(payload())
    await explorer({ ratings: [1600, 1800], speeds: ['blitz'] }).query(FEN)
    expect(calls[0]).toContain('explorer.lichess.ovh/lichess')
    expect(calls[0]).toContain('ratings=1600%2C1800')
    expect(calls[0]).toContain('speeds=blitz')
  })

  it('omits band filters for the masters endpoint, which has no ratings', async () => {
    respondWith(payload())
    await explorer({ source: 'masters' }).query(FEN)
    expect(calls[0]).toContain('explorer.lichess.ovh/masters')
    expect(calls[0]).not.toContain('ratings=')
    expect(calls[0]).not.toContain('speeds=')
  })

  it('rejects an unknown source instead of silently querying the wrong one', () => {
    expect(() => createExplorer({ cacheDir: dir, source: 'nonsense' })).toThrow(/unknown/)
  })
})

describe('explorer — caching', () => {
  it('serves a repeat query from disk without touching the network', async () => {
    respondWith(payload())
    const e = explorer()
    await e.query(FEN)
    const first = await e.query(FEN)
    expect(calls).toHaveLength(1)
    expect(first.moves[0].san).toBe('e4')
    expect(e.stats()).toMatchObject({ hits: 1, misses: 1 })
  })

  it('a fresh client reuses what an earlier run cached', async () => {
    respondWith(payload())
    await explorer().query(FEN)
    await explorer().query(FEN)
    expect(calls).toHaveLength(1)
  })

  it('keys the cache by the query, so a different band is a different entry', async () => {
    // Otherwise a 1600-1800 book would be served for a 2200-2500 request.
    respondWith(payload())
    await explorer({ ratings: [1600] }).query(FEN)
    await explorer({ ratings: [2200] }).query(FEN)
    expect(calls).toHaveLength(2)
    expect(readdirSync(dir)).toHaveLength(2)
  })
})

describe('explorer — failure handling', () => {
  it('retries a rate-limited request and succeeds', async () => {
    respondWith(
      () => ({ ok: false, status: 429 }),
      { ok: true, status: 200, json: async () => payload() },
    )
    const e = explorer()
    const r = await e.query(FEN)
    expect(r.moves).toHaveLength(1)
    expect(e.stats().retries).toBeGreaterThan(0)
  }, 20_000)

  it('retries a server error', async () => {
    respondWith(() => ({ ok: false, status: 503 }), {
      ok: true,
      status: 200,
      json: async () => payload(),
    })
    await expect(explorer().query(FEN)).resolves.toBeTruthy()
  }, 20_000)

  it('gives up immediately on a client error it cannot fix by waiting', async () => {
    globalThis.fetch = async () => ({ ok: false, status: 401, statusText: 'Unauthorized' })
    await expect(explorer().query(FEN)).rejects.toThrow(/401/)
  })

  it('fails loudly when the payload has no moves array', async () => {
    // A tree of zeroes built from a changed API is the silent-success shape this
    // pipeline keeps producing; better to stop and name the likely cause.
    respondWith({ white: 1, draws: 1, black: 1 })
    await expect(explorer().query(FEN)).rejects.toThrow(/moves/)
  })

  it('does not cache a failed response', async () => {
    globalThis.fetch = async () => ({ ok: false, status: 401, statusText: 'Unauthorized' })
    await expect(explorer().query(FEN)).rejects.toThrow()
    expect(readdirSync(dir)).toHaveLength(0)
  })
})

describe('explorer — politeness', () => {
  it('spaces out live requests', async () => {
    respondWith(payload())
    const e = explorer({ minDelayMs: 120 })
    const started = Date.now()
    await e.query(FEN)
    await e.query(FEN.replace(' w ', ' b ')) // a different position: a real request
    expect(Date.now() - started).toBeGreaterThanOrEqual(100)
  }, 20_000)
})
