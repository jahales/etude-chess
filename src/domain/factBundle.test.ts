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

const gradeA: MoveGrade = { bestWinPercent: 55, playedWinPercent: 55, swing: 0, tier: 'A' }
const gradeC: MoveGrade = { bestWinPercent: 60, playedWinPercent: 20, swing: 40, tier: 'C' }

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
      masterMoveSan: 'Nf3',
      grade: gradeC,
    })
    expect(b.hangingAfterMove.some((h) => h.square === 'd5' && h.piece === 'q')).toBe(true)
    expect(b.matchedMaster).toBe(false)
    expect(b.bestMoveSan).toBe('Nf3')
  })

  it('marks a move that matches the master', () => {
    const b = buildFactBundle({
      fen: FEN,
      userMoveSan: 'Nf3',
      bestMoveUci: 'g1f3',
      masterMoveSan: 'Nf3',
      grade: gradeA,
    })
    expect(b.matchedMaster).toBe(true)
    expect(b.hangingAfterMove).toHaveLength(0)
  })
})

describe('explain', () => {
  const FEN = 'rnbqkbnr/pppp1ppp/4p3/8/8/8/PPP2PPP/RNBQKBNR w KQkq - 0 1'

  it('congratulates an A-tier match without scolding', () => {
    const b = buildFactBundle({ fen: FEN, userMoveSan: 'Nf3', bestMoveUci: 'g1f3', masterMoveSan: 'Nf3', grade: gradeA })
    const text = explain(b)
    expect(text).toContain('matched the master')
    expect(text).not.toContain('mistake')
  })

  it('names the hung piece and points to the master move on a blunder', () => {
    const b = buildFactBundle({ fen: FEN, userMoveSan: 'Qd5', bestMoveUci: 'g1f3', masterMoveSan: 'Nf3', grade: gradeC })
    const text = explain(b)
    expect(text).toContain('mistake')
    expect(text).toMatch(/queen on d5 hanging/)
    expect(text).toContain('Nf3')
  })
})

describe('factBundleToText (clipboard handoff)', () => {
  it('emits grounded facts and an instruction, no invented moves', () => {
    const FEN = 'rnbqkbnr/pppp1ppp/4p3/8/8/8/PPP2PPP/RNBQKBNR w KQkq - 0 1'
    const b = buildFactBundle({ fen: FEN, userMoveSan: 'Qd5', bestMoveUci: 'g1f3', masterMoveSan: 'Nf3', grade: gradeC })
    const text = factBundleToText(b)
    expect(text).toContain(`Position (FEN): ${FEN}`)
    expect(text).toContain('Side to move: White')
    expect(text).toContain("Master's move: Nf3")
    expect(text).toMatch(/queen on d5/)
  })
})
