import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createEnginePool } from './enginePool.mjs'

// Against the scripted fake, like engine.test.mjs. The contract worth pinning is
// that concurrency does not reorder or drop anything: results must line up with
// the input, whichever engine happened to take which position.

const here = dirname(fileURLToPath(import.meta.url))
const FAKE = join(here, '__fixtures__', 'fakeEngine.mjs')

let dir
let logPath
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pool-'))
  logPath = join(dir, 'log.txt')
})

let scripts = 0
function poolWith(script, size) {
  const scriptPath = join(dir, `script-${scripts++}.json`)
  writeFileSync(scriptPath, JSON.stringify(script))
  process.env.FAKE_ENGINE_SCRIPT = scriptPath
  process.env.FAKE_ENGINE_LOG = logPath
  return createEnginePool({ size, path: process.execPath, args: [FAKE] })
}

const commands = () => (existsSync(logPath) ? readFileSync(logPath, 'utf8').split('\n') : [])

/** Distinct positions whose scores encode their index, so order is checkable. */
const FENS = Array.from({ length: 12 }, (_, i) => `4k3/8/8/8/8/8/8/4K3 w - - ${i} 1`)
const byFen = Object.fromEntries(
  FENS.map((fen, i) => [
    fen,
    [`info depth 20 multipv 1 score cp ${i * 10} nodes 1000 pv e2e4`, 'bestmove e2e4'],
  ]),
)

describe('a pool of single-threaded engines', () => {
  it('returns results in input order, not completion order', async () => {
    // The whole point of the pool is that positions finish out of order. If the
    // results followed completion, every grade would land on the wrong move.
    const pool = poolWith({ byFen }, 4)
    const results = await pool.analyseAll(FENS, { nodes: 1000 })
    expect(results.map((r) => r.lines[0].score.value)).toEqual(FENS.map((_, i) => i * 10))
    await pool.quit()
  })

  it('analyses every position exactly once', async () => {
    const pool = poolWith({ byFen }, 4)
    await pool.analyseAll(FENS, { nodes: 1000 })
    const sent = commands().filter((c) => c.startsWith('position fen '))
    expect(sent).toHaveLength(FENS.length)
    expect(new Set(sent).size).toBe(FENS.length)
    expect(pool.searchCount()).toBe(FENS.length)
    await pool.quit()
  })

  it('keeps every engine single-threaded, so each search stays reproducible', async () => {
    // The reason the pool exists rather than `setoption Threads`. If this ever
    // reads other than 1, the numbers stop being comparable run to run.
    const pool = poolWith({ byFen }, 3)
    await pool.analyseAll(FENS.slice(0, 3), { nodes: 1000 })
    const threadOptions = commands().filter((c) => c.startsWith('setoption name Threads'))
    expect(threadOptions).toHaveLength(3)
    expect(new Set(threadOptions)).toEqual(new Set(['setoption name Threads value 1']))
    await pool.quit()
  })

  it('reports progress once per position', async () => {
    const pool = poolWith({ byFen }, 4)
    const seen = []
    await pool.analyseAll(FENS, { nodes: 1000 }, (done, total) => seen.push([done, total]))
    expect(seen).toHaveLength(FENS.length)
    // Counts must be monotonic even though the work is not.
    expect(seen.map(([d]) => d)).toEqual(FENS.map((_, i) => i + 1))
    expect(seen.every(([, total]) => total === FENS.length)).toBe(true)
    await pool.quit()
  })

  it('copes with fewer positions than engines', async () => {
    const pool = poolWith({ byFen }, 6)
    const results = await pool.analyseAll(FENS.slice(0, 2), { nodes: 1000 })
    expect(results).toHaveLength(2)
    expect(results.map((r) => r.lines[0].score.value)).toEqual([0, 10])
    await pool.quit()
  })

  it('returns nothing for an empty list without hanging', async () => {
    const pool = poolWith({ byFen }, 3)
    expect(await pool.analyseAll([], { nodes: 1000 })).toEqual([])
    await pool.quit()
  })
})
