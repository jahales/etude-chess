import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, statSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cachedDump, resumableFetch, readValidBytes } from './buildBook.mjs'

// Download resilience and cache integrity. Both cost a full day:
//
//  - a connection that stopped delivering without closing hung a build for five
//    hours, because fetch has no timeout and a silent socket raises nothing;
//  - a killed build left a cache whose tail had never been verified, and every
//    later run choked on it in a way that looked like slow progress.
//
// Neither is reachable from the domain, and neither had a test.

let dir
const realFetch = globalThis.fetch

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cache-'))
})
afterEach(() => {
  globalThis.fetch = realFetch
})

const body = (buf) => ({
  ok: true,
  status: 200,
  body: { getReader: () => readerFor(buf) },
})

function readerFor(chunks) {
  const queue = Array.isArray(chunks) ? [...chunks] : [chunks]
  return {
    async read() {
      if (queue.length === 0) return { done: true, value: undefined }
      const next = queue.shift()
      if (next instanceof Error) throw next
      if (typeof next === 'function') return next()
      return { done: false, value: next }
    },
    async cancel() {},
  }
}

const collect = async (gen) => {
  const out = []
  for await (const chunk of gen) out.push(Buffer.from(chunk))
  return Buffer.concat(out)
}

describe('resumableFetch', () => {
  it('yields the whole body', async () => {
    globalThis.fetch = async () => body([Buffer.from('abc'), Buffer.from('def')])
    expect((await collect(resumableFetch('u'))).toString()).toBe('abcdef')
  })

  it('resumes from the byte it reached when the connection drops', async () => {
    const ranges = []
    let attempt = 0
    globalThis.fetch = async (_url, opts) => {
      ranges.push(opts?.headers?.Range)
      if (attempt++ === 0) {
        return { ok: true, status: 200, body: { getReader: () => readerFor([Buffer.from('abc'), new Error('ECONNRESET')]) } }
      }
      return { ok: true, status: 206, body: { getReader: () => readerFor([Buffer.from('def')]) } }
    }
    expect((await collect(resumableFetch('u'))).toString()).toBe('abcdef')
    // Second request must ask for exactly what was missing, or the stream is
    // silently corrupted at the join.
    expect(ranges[1]).toBe('bytes=3-')
  })

  it('starts from an offset when told the cache already holds a prefix', async () => {
    let seen
    globalThis.fetch = async (_url, opts) => {
      seen = opts?.headers?.Range
      return { ok: true, status: 206, body: { getReader: () => readerFor([Buffer.from('xyz')]) } }
    }
    await collect(resumableFetch('u', { startOffset: 100 }))
    expect(seen).toBe('bytes=100-')
  })

  it('treats 416 as "we already have it all", not as a failure', async () => {
    // Once a cache holds the whole file every later run asks for a range past
    // the end. Treating that as an error made a completed cache permanently
    // fatal.
    globalThis.fetch = async () => ({ ok: false, status: 416 })
    expect((await collect(resumableFetch('u', { startOffset: 999 }))).length).toBe(0)
  })

  it('gives up after exhausting its retries rather than looping forever', async () => {
    globalThis.fetch = async () => {
      throw new Error('network down')
    }
    await expect(collect(resumableFetch('u', { retries: 2 }))).rejects.toThrow(/download failed/)
  })

  it('aborts a connection that stops delivering without closing', async () => {
    // The five-hour hang: a silent socket raises nothing and fetch has no
    // timeout, so the read waits forever. The watchdog turns silence into an
    // error the resume path already knows how to handle.
    let attempts = 0
    globalThis.fetch = async (_url, opts) => {
      attempts++
      if (attempts === 1) {
        return {
          ok: true,
          status: 200,
          body: {
            getReader: () => ({
              async read() {
                // Never resolves on its own; only the abort signal ends this.
                return new Promise((_resolve, reject) => {
                  opts.signal.addEventListener('abort', () =>
                    reject(opts.signal.reason ?? new Error('aborted')),
                  )
                })
              },
              async cancel() {},
            }),
          },
        }
      }
      return { ok: true, status: 206, body: { getReader: () => readerFor([Buffer.from('ok')]) } }
    }
    const out = await collect(resumableFetch('u', { stallMs: 50 }))
    expect(out.toString()).toBe('ok')
    expect(attempts).toBe(2)
  }, 15_000)

  it('rejects an unexpected status outright', async () => {
    globalThis.fetch = async () => ({ ok: false, status: 500 })
    await expect(collect(resumableFetch('u', { retries: 1 }))).rejects.toThrow()
  })
})

describe('cachedDump — integrity', () => {
  const path = () => join(dir, 'dump.zst.part')
  const meta = () => `${path()}.meta`

  it('reads nothing from a cache with no verified mark and re-fetches', async () => {
    // A cache written before validBytes existed is of unknown provenance.
    writeFileSync(path(), Buffer.from('STALEDATA'))
    globalThis.fetch = async () => body([Buffer.from('fresh')])
    const out = await collect(cachedDump('u', path()))
    expect(out.toString()).toBe('fresh')
    expect(statSync(path()).size).toBe(5)
  })

  it('serves a verified prefix and asks only for the remainder', async () => {
    writeFileSync(path(), Buffer.from('abcdef'))
    writeFileSync(meta(), JSON.stringify({ validBytes: 6 }))
    let range
    globalThis.fetch = async (_u, opts) => {
      range = opts?.headers?.Range
      return { ok: true, status: 206, body: { getReader: () => readerFor([Buffer.from('ghi')]) } }
    }
    expect((await collect(cachedDump('u', path()))).toString()).toBe('abcdefghi')
    expect(range).toBe('bytes=6-')
  })

  it('discards a tail past the verified mark', async () => {
    // Exactly what an interrupted write leaves: bytes on disk that no frame
    // ever decoded. Trusting them wedged every later run at the same offset.
    writeFileSync(path(), Buffer.from('GOODJUNKJUNK'))
    writeFileSync(meta(), JSON.stringify({ validBytes: 4 }))
    globalThis.fetch = async () => ({
      ok: true,
      status: 206,
      body: { getReader: () => readerFor([Buffer.from('MORE')]) },
    })
    expect((await collect(cachedDump('u', path()))).toString()).toBe('GOODMORE')
    expect(readFileSync(path()).toString()).toBe('GOODMORE')
  })

  it('never trusts a mark beyond the bytes actually on disk', async () => {
    writeFileSync(path(), Buffer.from('abc'))
    writeFileSync(meta(), JSON.stringify({ validBytes: 999 }))
    let range
    globalThis.fetch = async (_u, opts) => {
      range = opts?.headers?.Range
      return { ok: true, status: 206, body: { getReader: () => readerFor([Buffer.from('d')]) } }
    }
    expect((await collect(cachedDump('u', path()))).toString()).toBe('abcd')
    expect(range).toBe('bytes=3-')
  })

  it('appends what it downloads so the next run can reuse it', async () => {
    globalThis.fetch = async () => body([Buffer.from('one'), Buffer.from('two')])
    await collect(cachedDump('u', path()))
    expect(readFileSync(path()).toString()).toBe('onetwo')
  })

  it('creates the cache directory if it does not exist', async () => {
    const nested = join(dir, 'a', 'b', 'dump.part')
    globalThis.fetch = async () => body([Buffer.from('x')])
    await collect(cachedDump('u', nested))
    expect(existsSync(nested)).toBe(true)
  })
})

describe('readValidBytes', () => {
  it('reads a recorded mark', () => {
    const p = join(dir, 'm.json')
    writeFileSync(p, JSON.stringify({ validBytes: 42 }))
    expect(readValidBytes(p)).toBe(42)
  })

  it('trusts nothing when the sidecar is missing or unreadable', () => {
    expect(readValidBytes(join(dir, 'absent.json'))).toBe(0)
    const bad = join(dir, 'bad.json')
    writeFileSync(bad, 'not json{')
    expect(readValidBytes(bad)).toBe(0)
  })

  it('rejects a nonsensical mark rather than acting on it', () => {
    const p = join(dir, 'neg.json')
    writeFileSync(p, JSON.stringify({ validBytes: -5 }))
    expect(readValidBytes(p)).toBe(0)
  })
})
