import { Chess } from 'chess.js'

/**
 * Rebuild every position of a game from its SAN move list.
 *
 * Positions aren't stored — they're derivable, and storing them would be both
 * bulky and a second source of truth that can drift from `sanHistory`.
 *
 * Returns `sans.length + 1` FENs when the game is well-formed: index `i` is the
 * position *before* move `i`, and the last entry is the final position.
 */
export function replayPositions(sans: readonly string[], startFen?: string): string[] {
  const chess = startFen ? new Chess(startFen) : new Chess()
  const positions = [chess.fen()]
  for (const san of sans) {
    try {
      chess.move(san)
    } catch {
      // Stored data can be older than the code that reads it, or simply corrupt.
      // Replaying what we can beats throwing away a whole game — the caller sees
      // a short list and shows the moves it could reconstruct.
      break
    }
    positions.push(chess.fen())
  }
  return positions
}
