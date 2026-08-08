// Several engines, one queue of positions.
//
// This is the way to afford a high node budget. The alternative — telling one
// Stockfish to use more threads — is barred by the reproducibility rule
// engine.mjs documents at length: multithreaded search splits work by thread
// scheduling, so the same position at the same node budget returns a different
// score run to run, and a ~10cp wobble silently flips findings across the 5 win%
// tier boundary.
//
// Running N *single-threaded* engines over different positions has no such
// problem. Each search is bit-for-bit the search a lone engine would have done;
// only the wall clock changes. On a 16-core machine that buys most of an order
// of magnitude, which is the difference between an 800k screening pass and a 4M
// one for the same wait.
//
// Positions must therefore be independent — fine for reviewing a finished game,
// where every position is known up front. A crawl that picks its next position
// from the last result cannot use this.

import { cpus } from 'node:os'
import { createEngine } from './engine.mjs'

/**
 * @param {object} [opts]
 * @param {number} [opts.size]  engines to run; defaults to half the cores, capped at 6
 * @param {number} [opts.hashMb] per engine — total memory is this times `size`
 * @param {string} [opts.path]
 * @param {string[]} [opts.args]
 */
export function createEnginePool(opts = {}) {
  const {
    // Half the cores leaves room for everything else on the machine, and the cap
    // is about memory rather than CPU: each engine holds its own hash table, so
    // eight of them at the default 256MB is two gigabytes before any searching.
    size = Math.min(6, Math.max(1, Math.floor(cpus().length / 2))),
    ...engineOpts
  } = opts

  const engines = Array.from({ length: size }, () => createEngine(engineOpts))

  return {
    size,

    /**
     * Analyse many positions, returning results **in input order**.
     *
     * Engines pull from a shared cursor rather than taking a fixed slice, so one
     * slow position does not leave five engines idle behind it.
     *
     * @param {string[]} fens
     * @param {{nodes?: number, multipv?: number}} [o]
     * @param {(done: number, total: number) => void} [onProgress]
     */
    async analyseAll(fens, o = {}, onProgress) {
      const results = new Array(fens.length)
      let cursor = 0
      let done = 0
      await Promise.all(
        engines.map(async (engine) => {
          for (;;) {
            const i = cursor++
            if (i >= fens.length) return
            results[i] = await engine.analyse(fens[i], o)
            onProgress?.(++done, fens.length)
          }
        }),
      )
      return results
    },

    /** Total searches run across the pool. */
    searchCount: () => engines.reduce((total, e) => total + e.searchCount(), 0),

    async quit() {
      await Promise.all(engines.map((e) => e.quit()))
    },
  }
}
