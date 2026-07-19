import { describe, it, expect } from 'vitest'
import { Chess } from 'chess.js'
import { hangingAfterMove, findHangingPieces } from './factBundle'
import type { Color } from './types'

/** Play the moves, then report what the last mover left hanging. */
function afterMoves(sans: string[]) {
  const chess = new Chess()
  let last = chess.move(sans[0]!)
  for (const san of sans.slice(1)) last = chess.move(san)
  const mover: Color = last.color as Color
  return { hanging: hangingAfterMove(chess, mover, last), static: findHangingPieces(chess, mover) }
}

describe('hangingAfterMove — nets the capture against the recapture', () => {
  it('does not flag an even pawn trade (1.e4 d5 2.exd5)', () => {
    const { hanging, static: raw } = afterMoves(['e4', 'd5', 'exd5'])
    // The static read calls this a hanging pawn; it is simply the other half of a trade.
    expect(raw.map((h) => h.square)).toContain('d5')
    expect(hanging).toEqual([])
  })

  it('does not flag the Exchange Ruy (4.Bxc6), which is main-line theory', () => {
    const { hanging, static: raw } = afterMoves(['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Bxc6'])
    expect(raw.map((h) => h.square)).toContain('c6')
    expect(hanging).toEqual([])
  })

  it('still flags a piece hung outright, with no capture to offset it', () => {
    // 2...Qh4 walks the queen onto a square the g-pawn wins it on.
    const { hanging } = afterMoves(['e4', 'e5', 'Nf3', 'Qh4'])
    expect(hanging.map((h) => h.square)).toContain('h4')
    expect(hanging.find((h) => h.square === 'h4')?.loss).toBeGreaterThan(0)
  })

  it('reports the true net cost of a bad trade, not the gross recapture', () => {
    // White wins a knight with the rook and loses the rook to the c6 pawn that
    // defends it: 5 taken back − 3 won = 2.
    const chess = new Chess('4k3/8/2p5/3n4/8/8/8/3RK3 w - - 0 1')
    const move = chess.move('Rxd5')
    const [hung] = hangingAfterMove(chess, 'w', move)
    expect(hung?.square).toBe('d5')
    expect(hung?.loss).toBe(2)
  })

  it('leaves other pieces judged statically — an ignored attack is still an error', () => {
    // Black's queen is en prise on h4; 3.d3 addresses nothing else and ignores it.
    const chess = new Chess()
    for (const m of ['e4', 'e5', 'Nf3', 'Qh4', 'd3']) chess.move(m)
    const move = chess.move('Nc6')
    // Black moved a knight, so the queen is not the moved piece and keeps its full loss.
    const hung = hangingAfterMove(chess, 'b', move)
    expect(hung.map((h) => h.square)).toContain('h4')
  })
})
