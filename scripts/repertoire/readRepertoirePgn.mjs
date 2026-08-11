// Variation-aware reader for the repertoire PGNs — issue #102.
//
// `repertoirePgn.ts` writes these files; nothing could read them back. chess.js,
// which the rest of this repo uses, silently drops variations on parse — and a
// repertoire PGN is *mostly* variations: our moves sit on the mainline, and
// every reply we prepare for is a sibling. Reading one with chess.js yields a
// single game and looks like it worked.
//
// So the tree comes from `chessops/pgn`, which parses variations properly, and
// the positions come from chess.js, so FENs match the convention every other
// module here already uses (localBook, repertoirePgn.fenKey, the crawler).
//
// What the caller usually wants is `ourDecisions()`: every position where the
// repertoire commits to a single move. That is the set issue #106 needs to
// re-grade, and the number `summary.json` calls `ourDecisions`.

import { Chess } from 'chess.js'
import { parsePgn } from 'chessops/pgn'
import { fenKey } from '../../src/domain/repertoirePgn.ts'

/** `[%eval 0.60]` / `[%eval #-3]` from a comment, in centipawns, White-relative. */
export function parseEvalComment(comment) {
  const m = /\[%eval\s+(#?)(-?\d+(?:\.\d+)?)\]/.exec(comment ?? '')
  if (!m) return undefined
  const n = Number(m[2])
  if (!Number.isFinite(n)) return undefined
  return m[1] === '#' ? { type: 'mate', value: n } : { type: 'cp', value: Math.round(n * 100) }
}

/** `{covered in the "qga" line}` — the branch that owns this subtree instead. */
export function parseDelegation(comment) {
  return /covered in the "([^"]+)" line/.exec(comment ?? '')?.[1]
}

const headerOf = (game, name) => game.headers.get(name) ?? undefined

/**
 * Which colour the repertoire is written for.
 *
 * Read from `[Orientation]` and never guessed: getting it wrong would audit the
 * opponent's prepared replies as if they were our choices, and still produce a
 * full-looking report.
 */
export function orientationOf(game) {
  const raw = headerOf(game, 'Orientation')
  if (raw === 'white') return 'w'
  if (raw === 'black') return 'b'
  throw new Error(
    `game "${headerOf(game, 'Event') ?? '?'}" has no usable [Orientation] header ` +
      `(got ${JSON.stringify(raw)}) — cannot tell which moves are ours`,
  )
}

/**
 * Walk every move of every game in a repertoire PGN, variations included.
 *
 * @param {string} text
 * @yields {{branch: string, orientation: 'w'|'b', fen: string, san: string, uci: string,
 *           ply: number, sideToMove: 'w'|'b', ours: boolean, line: string[],
 *           mainline: boolean, comment: string, eval?: {type:'cp'|'mate',value:number},
 *           delegatedTo?: string, fenAfter: string}}
 */
export function* walkRepertoire(text) {
  for (const game of parsePgn(text)) {
    const branch = headerOf(game, 'Event') ?? '(unnamed)'
    const orientation = orientationOf(game)

    // Depth-first, carrying the position by FEN so a fork costs a clone and
    // nothing else. `mainline` marks the first child at every level, which is
    // the move the repertoire actually prescribes at our nodes.
    const start = new Chess().fen()
    /** @type {{node: object, fen: string, line: string[], mainline: boolean}[]} */
    const stack = game.moves.children
      .map((node, i) => ({ node, fen: start, line: [], mainline: i === 0 }))
      // Reversed for the same reason the recursive push below is: the stack is
      // popped from the end, so the mainline has to go on last to come off
      // first. Without this the root's own variations are walked *before* its
      // mainline — the opposite of every deeper level — and `ourDecisions`,
      // which keeps the first occurrence of a position, would attribute a
      // shared position to a variation.
      .reverse()

    while (stack.length) {
      const { node, fen, line, mainline } = stack.pop()
      const board = new Chess(fen)

      let move
      try {
        move = board.move(node.data.san)
      } catch {
        // A move that will not play means the file and the reader disagree
        // about the position. Silently stopping here would drop a whole
        // subtree and report a smaller, cleaner repertoire than exists.
        throw new Error(
          `illegal move "${node.data.san}" in branch "${branch}" after ${line.join(' ') || '(start)'}`,
        )
      }

      const comment = (node.data.comments ?? []).join(' ')
      const nextLine = [...line, move.san]

      yield {
        branch,
        orientation,
        fen,
        san: move.san,
        uci: move.lan,
        ply: nextLine.length,
        sideToMove: move.color,
        ours: move.color === orientation,
        line: nextLine,
        mainline,
        comment,
        eval: parseEvalComment(comment),
        delegatedTo: parseDelegation(comment),
        fenAfter: board.fen(),
      }

      // Push in reverse so the mainline is visited first.
      const kids = node.children
      for (let i = kids.length - 1; i >= 0; i--) {
        stack.push({ node: kids[i], fen: board.fen(), line: nextLine, mainline: i === 0 })
      }
    }
  }
}

/**
 * Every position where the repertoire commits us to one move.
 *
 * Keyed by position — `fenKey`, the first four FEN fields — so transpositions
 * collapse, matching how `build.mjs:decidedPositions` counts the `ourDecisions`
 * figure in summary.json. Counting a transposition twice would inflate both the
 * audit's denominator and any failure count taken from it.
 *
 * A position that two branches answer *differently* is reported in `conflicts`
 * rather than silently resolved. That is the one property a repertoire must
 * have — you know which move you play — so a violation is a finding, not a
 * detail for the dedup logic to swallow.
 *
 * @returns {{decisions: object[], conflicts: {fen: string, a: object, b: object}[]}}
 */
export function ourDecisions(text) {
  const byPosition = new Map()
  const conflicts = []

  for (const node of walkRepertoire(text)) {
    if (!node.ours) continue
    const key = fenKey(node.fen)
    const prior = byPosition.get(key)
    if (!prior) {
      byPosition.set(key, node)
      continue
    }
    if (prior.san !== node.san) conflicts.push({ fen: key, a: prior, b: node })
  }

  return { decisions: [...byPosition.values()], conflicts }
}
