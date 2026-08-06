// A local opening book that satisfies the same interface as explorer.mjs, so
// the crawler can run entirely offline against data built by buildBook.mjs.
//
// Same `query(fen)` shape as the Lichess explorer, so the crawler neither knows
// nor cares which one it is talking to.
//
// The book stores SAN only; UCI is derived at query time with chess.js, which
// keeps the file substantially smaller and cannot disagree with the position.

import { readFile } from 'node:fs/promises'
import { Chess } from 'chess.js'
import { fenKey } from '../../src/domain/repertoirePgn.ts'

const EMPTY = { white: 0, draws: 0, black: 0, opening: null, moves: [] }

/**
 * @param {{path: string}} opts
 * @returns {Promise<{query(fen: string): Promise<any>, stats(): object}>}
 */
export async function createLocalBook({ path }) {
  const data = JSON.parse(await readFile(path, 'utf8'))
  const positions = data.positions ?? {}
  const counters = { hits: 0, misses: 0 }

  return {
    async query(fen) {
      const node = positions[fenKey(fen)]
      if (!node) {
        counters.misses++
        return { ...EMPTY }
      }
      counters.hits++

      const chess = new Chess(fen)
      const moves = []
      let white = 0
      let draws = 0
      let black = 0

      for (const [san, tally] of Object.entries(node)) {
        let move
        try {
          move = chess.move(san)
        } catch {
          continue // a SAN the book recorded that isn't legal here — skip it
        }
        if (!move) continue
        chess.undo()
        moves.push({ san: move.san, uci: move.lan, white: tally[0], draws: tally[1], black: tally[2] })
        white += tally[0]
        draws += tally[1]
        black += tally[2]
      }

      moves.sort(
        (a, b) => b.white + b.draws + b.black - (a.white + a.draws + a.black),
      )
      return { white, draws, black, opening: null, moves }
    },

    stats: () => ({ source: 'local book', ...data.meta, ...counters }),
  }
}
