import { describe, it, expect } from 'vitest'
import { Chess } from 'chess.js'
import {
  findHangingPieces,
  uciToSan,
  buildFactBundle,
  explain,
  factBundleToText,
} from './factBundle'
import type { MoveGrade } from './grade'
import type { MoveSource } from './moveSource'

const gradeA: MoveGrade = { bestWinPercent: 55, playedWinPercent: 55, swing: 0, tier: 'A' }
const gradeC: MoveGrade = { bestWinPercent: 60, playedWinPercent: 20, swing: 40, tier: 'C' }

const MASTER: MoveSource = { kind: 'master' }
const MINE: MoveSource = { kind: 'you' }

describe('findHangingPieces', () => {
  it('flags an undefended piece attacked by a cheaper one', () => {
    // White queen on d5, attacked by the black e6 pawn, no defenders.
    const chess = new Chess('rnbqkbnr/pppp1ppp/4p3/3Q4/8/8/PPPP1PPP/RNB1KBNR b KQkq - 0 1')
    const hanging = findHangingPieces(chess, 'w')
    expect(hanging).toHaveLength(1)
    expect(hanging[0]!.square).toBe('d5')
    expect(hanging[0]!.piece).toBe('q')
    expect(hanging[0]!.loss).toBe(9)
  })

  it('reports nothing in the quiet starting position', () => {
    const chess = new Chess()
    expect(findHangingPieces(chess, 'w')).toHaveLength(0)
    expect(findHangingPieces(chess, 'b')).toHaveLength(0)
  })
})

describe('uciToSan', () => {
  it('converts a legal UCI move to SAN', () => {
    expect(uciToSan(new Chess().fen(), 'g1f3')).toBe('Nf3')
  })
  it('handles promotion', () => {
    expect(uciToSan('8/P7/8/8/8/8/8/k6K w - - 0 1', 'a7a8q')).toBe('a8=Q+')
  })
  it('returns null for an illegal move', () => {
    expect(uciToSan(new Chess().fen(), 'e2e5')).toBeNull()
  })
})

describe('buildFactBundle', () => {
  // Position where White can play the losing Qd5?? (hangs the queen to ...exd5).
  const FEN = 'rnbqkbnr/pppp1ppp/4p3/8/8/8/PPP2PPP/RNBQKBNR w KQkq - 0 1'

  it('detects the queen the user hung', () => {
    const b = buildFactBundle({
      fen: FEN,
      userMoveSan: 'Qd5',
      bestMoveUci: 'g1f3',
      gameMoveSan: 'Nf3',
      moveSource: MASTER,
      grade: gradeC,
    })
    expect(b.hangingAfterMove.some((h) => h.square === 'd5' && h.piece === 'q')).toBe(true)
    expect(b.matchedGameMove).toBe(false)
    expect(b.bestMoveSan).toBe('Nf3')
  })

  it('marks a move that matches the one played in the game', () => {
    const b = buildFactBundle({
      fen: FEN,
      userMoveSan: 'Nf3',
      bestMoveUci: 'g1f3',
      gameMoveSan: 'Nf3',
      moveSource: MASTER,
      grade: gradeA,
    })
    expect(b.matchedGameMove).toBe(true)
    expect(b.hangingAfterMove).toHaveLength(0)
  })

  it('carries who played the game’s move rather than assuming a master (#158)', () => {
    const b = buildFactBundle({
      fen: FEN,
      userMoveSan: 'Qd5',
      bestMoveUci: 'g1f3',
      gameMoveSan: 'Nf3',
      moveSource: MINE,
      grade: gradeC,
    })
    expect(b.moveSource).toEqual({ kind: 'you' })
  })
})

describe('explain', () => {
  const FEN = 'rnbqkbnr/pppp1ppp/4p3/8/8/8/PPP2PPP/RNBQKBNR w KQkq - 0 1'
  const bundle = (over: Partial<Parameters<typeof buildFactBundle>[0]> = {}) =>
    buildFactBundle({
      fen: FEN,
      userMoveSan: 'Qd5',
      bestMoveUci: 'g1f3',
      gameMoveSan: 'Nf3',
      moveSource: MASTER,
      grade: gradeC,
      ...over,
    })

  it('congratulates an A-tier match without scolding', () => {
    const text = explain(bundle({ userMoveSan: 'Nf3', grade: gradeA }))
    expect(text).toContain('matched the master')
    expect(text).not.toContain('mistake')
  })

  it('names the hung piece and points to the master move on a blunder', () => {
    const text = explain(bundle())
    expect(text).toContain('mistake')
    expect(text).toMatch(/queen on d5 hanging/)
    expect(text).toContain('The master played Nf3')
  })

  // #158. Everything below this line is the same reveal on a game that is not a
  // master game — most often one the reader played themselves, at ~1100.

  it('credits your own game to you, not to a master', () => {
    const text = explain(bundle({ moveSource: MINE }))
    expect(text).toContain('In the game you played Nf3')
    expect(text.toLowerCase()).not.toContain('master')
  })

  it('names the player whose game it is when it is neither yours nor a master’s', () => {
    const text = explain(bundle({ moveSource: { kind: 'player', name: 'other_player' } }))
    expect(text).toContain('other_player played Nf3')
    expect(text.toLowerCase()).not.toContain('master')
  })

  it('praises an engine-equal move for what the engine said, not for the game’s move', () => {
    // The line the bug was reported on: "Solid — as strong as the master's
    // choice" about a club move nobody compared you to. Grading is against
    // Stockfish (`engine/grading.ts`), so that is who the sentence may cite.
    for (const moveSource of [MASTER, MINE] as MoveSource[]) {
      const text = explain(bundle({ moveSource, grade: gradeA }))
      expect(text).toContain('engine')
      expect(text).not.toContain('as strong as the master')
    }
  })

  it('does not re-announce the game’s move when you played it again', () => {
    // Your own bad move, chosen a second time: "In the game you played Qd5"
    // under "you chose Qd5" reads as two different moves. Only the engine's
    // preference is new information here.
    const text = explain(
      bundle({ userMoveSan: 'Nf3', gameMoveSan: 'Nf3', bestMoveUci: 'b1c3', moveSource: MINE }),
    )
    expect(text).toContain('The engine prefers Nc3')
    expect(text).not.toContain('In the game you played')
  })
})

describe('factBundleToText (clipboard handoff)', () => {
  const FEN = 'rnbqkbnr/pppp1ppp/4p3/8/8/8/PPP2PPP/RNBQKBNR w KQkq - 0 1'
  const bundle = (over: Partial<Parameters<typeof buildFactBundle>[0]> = {}) =>
    buildFactBundle({
      fen: FEN,
      userMoveSan: 'Qd5',
      bestMoveUci: 'g1f3',
      gameMoveSan: 'Nf3',
      moveSource: MASTER,
      grade: gradeC,
      ...over,
    })

  it('emits grounded facts and an instruction, no invented moves', () => {
    const text = factBundleToText(bundle())
    expect(text).toContain(`Position (FEN): ${FEN}`)
    expect(text).toContain('Side to move: White')
    expect(text).toContain("Master's move: Nf3")
    expect(text).toMatch(/queen on d5/)
  })

  // #158's worst case: nobody proofreads this text between the button and the
  // model, so a false premise here is reasoned from confidently.

  it('never tells an LLM your own blitz move was a master’s', () => {
    const text = factBundleToText(bundle({ moveSource: MINE }))
    expect(text).toContain('The move I played in the game: Nf3')
    expect(text.toLowerCase()).not.toContain('master')
  })

  it('attributes an imported game to the player the file named', () => {
    const text = factBundleToText(bundle({ moveSource: { kind: 'player', name: 'other_player' } }))
    expect(text).toContain("other_player's move: Nf3")
    expect(text.toLowerCase()).not.toContain('master')
  })

  it('asks the LLM about the engine’s move, and says which move graded me', () => {
    // The instruction used to ask why the *game's* move was better than mine —
    // a comparison nothing in this app has ever made.
    const text = factBundleToText(bundle({ moveSource: MINE }))
    expect(text).toContain('explain why Nf3 is better than Qd5 here')
    expect(text).toContain('The tier came from comparing my move with the engine')
    expect(text).toContain('not the standard I was graded against')
  })

  it('asks what the move achieves when there is nothing better to compare it with', () => {
    // Mine already is the engine's pick: "why X is better than X" invites an
    // invented difference, which is the one thing ADR 0012 forbids.
    const text = factBundleToText(
      bundle({ userMoveSan: 'Nf3', bestMoveUci: 'g1f3', grade: gradeA }),
    )
    expect(text).toContain('explain what Nf3 achieves here')
    expect(text).not.toContain('is better than')
  })
})
