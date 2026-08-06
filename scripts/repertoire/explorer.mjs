// Lichess opening-explorer client with an on-disk cache.
//
// Two endpoints, two jobs (ADR 0021): `masters` supplies the principled spine,
// `amateur` — filtered to our rating band — supplies the deviations we actually
// meet. A master database contains almost no Englund or Wayward Queen, which is
// exactly what a 1400 faces, so the band filter is load-bearing rather than a
// refinement.
//
// Everything is cached by request, so re-running the crawl with different
// thresholds costs zero requests. That matters: tuning is the main activity.

import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const ENDPOINTS = {
  amateur: 'https://explorer.lichess.ovh/lichess',
  masters: 'https://explorer.lichess.ovh/masters',
}

/** Rating buckets the explorer accepts; a request is the union of those given. */
export const RATING_BUCKETS = [0, 1000, 1200, 1400, 1600, 1800, 2000, 2200, 2500]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * @param {object} opts
 * @param {string} opts.cacheDir
 * @param {'amateur'|'masters'} [opts.source]
 * @param {number[]} [opts.ratings]  rating buckets (amateur only)
 * @param {string[]} [opts.speeds]   time controls (amateur only)
 * @param {number} [opts.moves]      how many candidate moves to ask for
 * @param {number} [opts.minDelayMs] politeness gap between live requests
 */
export function createExplorer(opts) {
  const {
    cacheDir,
    source = 'amateur',
    ratings = [1600, 1800],
    speeds = ['blitz', 'rapid', 'classical'],
    moves = 12,
    minDelayMs = 1100,
  } = opts

  const endpoint = ENDPOINTS[source]
  if (!endpoint) throw new Error(`unknown explorer source: ${source}`)

  const counters = { hits: 0, misses: 0, retries: 0 }
  let ready = mkdir(cacheDir, { recursive: true })
  let lastRequest = 0
  /** Serialises live requests so the delay is actually honoured under concurrency. */
  let chain = Promise.resolve()

  function paramsFor(fen) {
    const p = new URLSearchParams({
      variant: 'standard',
      fen,
      moves: String(moves),
      topGames: '0',
      recentGames: '0',
    })
    if (source === 'amateur') {
      p.set('ratings', ratings.join(','))
      p.set('speeds', speeds.join(','))
    }
    return p
  }

  function cachePath(params) {
    const key = createHash('sha1').update(`${endpoint}?${params}`).digest('hex')
    return join(cacheDir, `${key}.json`)
  }

  async function fetchLive(url) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const wait = Math.max(0, minDelayMs - (Date.now() - lastRequest))
      if (wait > 0) await sleep(wait)
      lastRequest = Date.now()

      const res = await fetch(url, { headers: { Accept: 'application/json' } })
      if (res.ok) return res.json()

      // 429 is expected under sustained crawling; back off rather than fail the run.
      if (res.status === 429 || res.status >= 500) {
        counters.retries++
        await sleep(2000 * 2 ** attempt)
        continue
      }
      throw new Error(`explorer ${res.status} ${res.statusText} for ${url}`)
    }
    throw new Error(`explorer gave up after retries: ${url}`)
  }

  return {
    /**
     * Statistics for one position.
     * @returns {Promise<{moves: {san:string,uci:string,white:number,draws:number,black:number,averageRating?:number}[], white:number, draws:number, black:number, opening: {eco:string,name:string}|null}>}
     */
    async query(fen) {
      await ready
      const params = paramsFor(fen)
      const path = cachePath(params)

      try {
        const cached = await readFile(path, 'utf8')
        counters.hits++
        return JSON.parse(cached)
      } catch {
        // cache miss — fall through
      }

      counters.misses++
      const url = `${endpoint}?${params}`
      const run = chain.then(() => fetchLive(url))
      chain = run.catch(() => {}) // keep the chain alive after a failure
      const data = await run

      // Fail loudly on an unexpected payload rather than silently crawling a
      // tree of zeroes — every downstream statistic would be meaningless.
      if (!data || !Array.isArray(data.moves)) {
        throw new Error(
          `explorer returned no \`moves\` array for ${fen}. ` +
            `Response keys: ${data ? Object.keys(data).join(', ') : 'none'}. ` +
            `The API shape may have changed — check https://lichess.org/api#tag/Opening-Explorer`,
        )
      }

      const slim = {
        white: data.white ?? 0,
        draws: data.draws ?? 0,
        black: data.black ?? 0,
        opening: data.opening ?? null,
        moves: (data.moves ?? []).map((m) => ({
          san: m.san,
          uci: m.uci,
          white: m.white ?? 0,
          draws: m.draws ?? 0,
          black: m.black ?? 0,
          averageRating: m.averageRating,
        })),
      }
      await writeFile(path, JSON.stringify(slim), 'utf8')
      return slim
    },

    stats: () => ({ ...counters, source }),
  }
}
