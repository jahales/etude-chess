import { describe, it, expect } from 'vitest'
import { Chess } from 'chess.js'
import {
  explorationFen,
  explorationMoves,
  explorationReducer as reduce,
  isOffGame,
  moveSan,
  type Exploration,
} from './exploration'

const START = new Chess().fen()

/** The FEN after playing `sans` from the initial position. */
function after(...sans: string[]): string {
  const chess = new Chess()
  for (const san of sans) chess.move(san)
  return chess.fen()
}

/** Enter `moves` at `ply` from the game position — what clicking a line does. */
const enterFromStart = (moves: string[], ply: number) =>
  reduce(null, { type: 'ENTER', fen: START, moves, ply })

describe('entering a line', () => {
  it('walks the board to the move that was clicked', () => {
    const e = enterFromStart(['e4', 'e5', 'Nf3', 'Nc6'], 1)!
    expect(e.cursor).toBe(2)
    expect(explorationFen(e)).toBe(after('e4', 'e5'))
    expect(e.line).toEqual(['e4', 'e5', 'Nf3', 'Nc6'])
  })

  it('keeps the whole line, so the moves after the click are still there to step into', () => {
    const e = enterFromStart(['e4', 'e5', 'Nf3'], 0)!
    expect(e.cursor).toBe(1)
    expect(e.line).toHaveLength(3)
  })

  it('roots the exploration at the position the line was computed for', () => {
    const fen = '8/8/8/4k3/8/8/4P3/4K3 w - - 0 42'
    const e = reduce(null, { type: 'ENTER', fen, moves: ['e4', 'Kd6'], ply: 0 })!
    expect(e.rootFen).toBe(fen)
    expect(reduce(e, { type: 'SEEK', cursor: 0 })).toEqual({ ...e, cursor: 0 })
    expect(explorationFen({ ...e, cursor: 0 })).toBe(fen)
  })

  it('clamps a click past the end of the line to its last move', () => {
    const e = enterFromStart(['e4', 'e5'], 9)!
    expect(e.cursor).toBe(2)
  })

  it('walks at least one move, so an exploration is never a synonym for the game position', () => {
    const e = enterFromStart(['e4', 'e5'], -3)!
    expect(e.cursor).toBe(1)
  })

  it('keeps only the legal prefix of a line', () => {
    // A PV is rendered to SAN against a position; a stale one stops replaying
    // part-way. Half a line beats a throw inside the reducer.
    const e = enterFromStart(['e4', 'e5', 'Qh9', 'Nc6'], 1)!
    expect(e.line).toEqual(['e4', 'e5'])
  })

  it('refuses a line with no legal move at all, rather than opening an empty exploration', () => {
    // An exploration sitting on the game position would be labelled "not the
    // game" while showing exactly the game.
    expect(enterFromStart(['Qh9'], 0)).toBeNull()
  })

  it('stores chess.js canonical SAN, whatever spelling it was handed', () => {
    const e = enterFromStart(['e2e4'], 0)!
    expect(e.line).toEqual(['e4'])
  })
})

describe('stepping', () => {
  const line = () => enterFromStart(['e4', 'e5', 'Nf3', 'Nc6'], 3)!

  it('steps back one ply', () => {
    const e = reduce(line(), { type: 'STEP', delta: -1 })!
    expect(e.cursor).toBe(3)
    expect(explorationFen(e)).toBe(after('e4', 'e5', 'Nf3'))
  })

  it('stepping past the end is a no-op and does not disturb the state', () => {
    const e = line()
    expect(reduce(e, { type: 'STEP', delta: 1 })).toBe(e)
  })

  it('stepping back before the start stops at the root instead of leaving', () => {
    // Leaving has to be a control you press. Falling out of the exploration on
    // one extra ← would take the "not the game" marker off the screen without
    // the reader having asked for it.
    const e = reduce(line(), { type: 'STEP', delta: -99 })!
    expect(e.cursor).toBe(0)
    expect(explorationFen(e)).toBe(START)
    expect(e.line).toHaveLength(4)
  })

  it('is not off the game at the root, because the root is the game position', () => {
    expect(isOffGame(reduce(line(), { type: 'SEEK', cursor: 0 }))).toBe(false)
    expect(isOffGame(line())).toBe(true)
    expect(isOffGame(null)).toBe(false)
  })

  it('seeks to a ply, clamped to the line', () => {
    expect(reduce(line(), { type: 'SEEK', cursor: 2 })!.cursor).toBe(2)
    expect(reduce(line(), { type: 'SEEK', cursor: 40 })!.cursor).toBe(4)
    expect(reduce(line(), { type: 'SEEK', cursor: -1 })!.cursor).toBe(0)
  })

  it('ignores stepping when there is nothing to step through', () => {
    expect(reduce(null, { type: 'STEP', delta: 1 })).toBeNull()
    expect(reduce(null, { type: 'SEEK', cursor: 2 })).toBeNull()
  })
})

describe('branching', () => {
  it('truncates whatever was ahead of the cursor', () => {
    const entered = enterFromStart(['e4', 'e5', 'Nf3', 'Nc6'], 1)!
    const branched = reduce(entered, {
      type: 'PLAY',
      fen: explorationFen(entered),
      from: 'f1',
      to: 'c4',
    })!
    expect(branched.line).toEqual(['e4', 'e5', 'Bc4'])
    expect(branched.cursor).toBe(3)
    expect(branched.rootFen).toBe(START)
  })

  it('starts an exploration when you play a move on the game position', () => {
    // Free exploration from a position (#11): you do not have to click a line
    // first.
    const e = reduce(null, { type: 'PLAY', fen: START, from: 'e2', to: 'e4' })!
    expect(e.rootFen).toBe(START)
    expect(e.line).toEqual(['e4'])
    expect(e.cursor).toBe(1)
  })

  it('leaves the line alone when the move is not legal', () => {
    const entered = enterFromStart(['e4', 'e5'], 1)!
    expect(
      reduce(entered, { type: 'PLAY', fen: explorationFen(entered), from: 'e1', to: 'e5' }),
    ).toBe(entered)
  })

  it('promotes to the piece asked for, and to a queen when nothing is asked', () => {
    const fen = '8/4P3/8/8/8/8/8/4K2k w - - 0 1'
    expect(reduce(null, { type: 'PLAY', fen, from: 'e7', to: 'e8' })!.line).toEqual(['e8=Q'])
    expect(
      reduce(null, { type: 'PLAY', fen, from: 'e7', to: 'e8', promotion: 'n' })!.line,
    ).toEqual(['e8=N'])
  })
})

describe('engine/board sync inside the reducer', () => {
  // architecture.md's cross-cutting rule: an engine result carries the FEN it
  // was computed for, and is dropped if the board has moved on. A click on a
  // line is that result arriving as a user action, so the same rule applies —
  // and the failure it prevents is silent, not a crash: the board would walk a
  // variation the engine never suggested for it.

  it('extends the current line only when the click came from the position on the board', () => {
    const entered = enterFromStart(['e4', 'e5'], 1)!
    const extended = reduce(entered, {
      type: 'ENTER',
      fen: explorationFen(entered),
      moves: ['Nf3', 'Nc6'],
      ply: 0,
    })!
    expect(extended.rootFen).toBe(START)
    expect(extended.line).toEqual(['e4', 'e5', 'Nf3', 'Nc6'])
    expect(extended.cursor).toBe(3)
  })

  it('splices at the cursor, dropping the moves the old line had ahead', () => {
    const entered = enterFromStart(['e4', 'e5', 'Nf3', 'Nc6'], 1)!
    const extended = reduce(entered, {
      type: 'ENTER',
      fen: explorationFen(entered),
      moves: ['Bc4'],
      ply: 0,
    })!
    expect(extended.line).toEqual(['e4', 'e5', 'Bc4'])
  })

  it('re-roots at the position the line really belongs to when it is not the one on the board', () => {
    // A panel still showing the previous position's lines. Appending those to
    // the current line is the wrong answer; so is walking them from the wrong
    // square. Rooting a fresh exploration at their own position is the only one
    // that leaves the board showing what the engine was actually asked about.
    const entered = enterFromStart(['e4', 'e5', 'Nf3'], 3)!
    const stale = reduce(entered, { type: 'ENTER', fen: START, moves: ['d4', 'd5'], ply: 1 })!
    expect(stale.rootFen).toBe(START)
    expect(stale.line).toEqual(['d4', 'd5'])
    expect(explorationFen(stale)).toBe(after('d4', 'd5'))
  })

  it('re-roots a branch played on a position the exploration is not standing on', () => {
    const entered = enterFromStart(['e4', 'e5'], 2)!
    const played = reduce(entered, { type: 'PLAY', fen: START, from: 'd2', to: 'd4' })!
    expect(played.rootFen).toBe(START)
    expect(played.line).toEqual(['d4'])
  })
})

describe('leaving', () => {
  it('drops the exploration entirely', () => {
    expect(reduce(enterFromStart(['e4'], 0), { type: 'LEAVE' })).toBeNull()
    expect(reduce(null, { type: 'LEAVE' })).toBeNull()
  })

  it('re-entering afterwards is indistinguishable from entering the first time', () => {
    const first = enterFromStart(['e4', 'e5', 'Nf3'], 2)
    const again = reduce(reduce(first, { type: 'LEAVE' }), {
      type: 'ENTER',
      fen: START,
      moves: ['e4', 'e5', 'Nf3'],
      ply: 2,
    })
    expect(again).toEqual(first)
  })
})

describe('an exploration that did not start from the standard start', () => {
  // Every position worth exploring in this app is mid-game, so this is the
  // normal case rather than the exotic one.
  const ENDGAME = '8/8/8/4k3/8/8/4P3/4K3 w - - 0 42'

  it('derives positions from its own root', () => {
    const e = reduce(null, { type: 'ENTER', fen: ENDGAME, moves: ['e4', 'Kd6', 'Kd2'], ply: 2 })!
    const chess = new Chess(ENDGAME)
    for (const san of ['e4', 'Kd6', 'Kd2']) chess.move(san)
    expect(explorationFen(e)).toBe(chess.fen())
  })

  it('numbers its moves from the root, not from move one', () => {
    const e = reduce(null, { type: 'ENTER', fen: ENDGAME, moves: ['e4', 'Kd6', 'Kd2'], ply: 0 })!
    expect(explorationMoves(e)).toEqual([
      { index: 0, san: 'e4', moveNumber: 42, side: 'w' },
      { index: 1, san: 'Kd6', moveNumber: 42, side: 'b' },
      { index: 2, san: 'Kd2', moveNumber: 43, side: 'w' },
    ])
  })

  it('numbers correctly when Black is the side to move at the root', () => {
    const fen = after('e4')
    const e = reduce(null, { type: 'ENTER', fen, moves: ['e5', 'Nf3', 'Nc6'], ply: 0 })!
    expect(explorationMoves(e)).toEqual([
      { index: 0, san: 'e5', moveNumber: 1, side: 'b' },
      { index: 1, san: 'Nf3', moveNumber: 2, side: 'w' },
      { index: 2, san: 'Nc6', moveNumber: 2, side: 'b' },
    ])
  })
})

describe('positions are derived, never stored', () => {
  it('reads the board off rootFen + line, so the two cannot drift', () => {
    const e: Exploration = { rootFen: START, line: ['e4', 'e5'], cursor: 2 }
    expect(explorationFen(e)).toBe(after('e4', 'e5'))
  })

  it('does not throw on a line that no longer replays', () => {
    // Nothing in the reducer can produce this; a hand-built value can, and a
    // throw here would land inside a render.
    const e: Exploration = { rootFen: START, line: ['e4', 'Qh9'], cursor: 2 }
    expect(() => explorationFen(e)).not.toThrow()
  })
})

describe('moveSan', () => {
  it('is one definition of legality for the reducer and the drag handler', () => {
    expect(moveSan(START, 'e2', 'e4')).toBe('e4')
    expect(moveSan(START, 'e2', 'e5')).toBeNull()
  })
})
