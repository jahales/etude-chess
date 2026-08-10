// The soundness gate, with a deep evaluation in front of the local search.
//
// ADR 0021 gates our own moves on a fixed-node Stockfish search: reject any
// candidate more than SOUNDNESS_MAX_SWING (5) win% below the best. v1 ran that
// at 120,000 nodes, roughly depth 15. The audit for #106 found the result held
// up — 6 of 585 prescribed moves concede more than the gate allows, none worse
// than Tier B — but 120k is still a thin basis for a decision that gets baked
// into a repertoire, when 401M positions at median depth 50 are sitting on disk.
//
// So the gate consults the index first and falls back to the engine. Two rules
// keep that honest:
//
//   1. **Both sides of the subtraction come from the same source.** Mixing a
//      depth-50 best against a depth-15 candidate would manufacture swings out
//      of depth disagreement. If the index cannot score both, the whole
//      comparison falls back to the engine's numbers.
//   2. **Only the gate moves.** Trap scoring and the quiet test stay on the
//      engine. `trapValue` is a statistic whose distribution was calibrated by
//      a cross-month replication, and the quiet test is a *shallow-versus-deep*
//      comparison that a single cloud number cannot take part in. Changing
//      either would invalidate work this change has no quarrel with.

import { Chess } from 'chess.js'
import { winPercent } from '../../src/domain/winPercent.ts'

/**
 * Below this the index is not obviously better than the local search, and the
 * extra source is not worth the inconsistency. The dump's median is 50.
 */
export const MIN_INDEX_DEPTH = 25

const negate = (s) => ({ type: s.type, value: -s.value })

function applyUci(fen, uci) {
  try {
    const c = new Chess(fen)
    const move = c.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion: uci.length > 4 ? uci[4] : undefined,
    })
    return move ? c.fen() : null
  } catch {
    return null
  }
}

/**
 * @param {object} opts
 * @param {{query: (fen: string) => object|null}|null} [opts.evalDb]
 * @param {number} [opts.minDepth]
 */
export function createSoundnessGate({ evalDb = null, minDepth = MIN_INDEX_DEPTH } = {}) {
  const counters = { cloud: 0, local: 0, multipv: 0, after: 0 }

  return {
    /**
     * Win% our move gives up against the best available.
     *
     * @param {string} fen   the position we are choosing in
     * @param {string} uci   the candidate
     * @param {{swing: number, depth?: number}} fallback
     *   what the local search already computed, used verbatim when the index
     *   cannot score this decision — so a miss costs nothing.
     * @returns {{swing: number, source: 'cloud'|'local', depth: number, method?: 'multipv'|'after'}}
     */
    swingFor(fen, uci, fallback) {
      const local = () => {
        counters.local++
        return { swing: fallback.swing, source: 'local', depth: fallback.depth ?? 0 }
      }
      if (!evalDb) return local()

      const before = evalDb.query(fen)
      if (!before?.lines?.length || before.depth < minDepth) return local()
      const bestWp = winPercent(before.lines[0].score)

      // Same search, same depth — directly comparable.
      const mine = before.lines.find((l) => l.pv[0] === uci)
      if (mine) {
        counters.cloud++
        counters.multipv++
        return {
          swing: Math.max(0, bestWp - winPercent(mine.score)),
          source: 'cloud',
          depth: before.depth,
          method: 'multipv',
        }
      }

      // Outside the stored pvs: score the position after our move and negate.
      const afterFen = applyUci(fen, uci)
      const after = afterFen && evalDb.query(afterFen)
      if (!after?.lines?.length || after.depth < minDepth) return local()

      counters.cloud++
      counters.after++
      return {
        swing: Math.max(0, bestWp - winPercent(negate(after.lines[0].score))),
        source: 'cloud',
        depth: Math.min(before.depth, after.depth),
        method: 'after',
      }
    },

    stats: () => ({ ...counters }),
  }
}
