import { useMemo, useState, type CSSProperties, type ComponentProps, type ReactNode } from 'react'
import { Chessboard } from 'react-chessboard'
import { materialBalance } from '../domain/material'
import type { Color } from '../domain/types'
import { EvalBar, MaterialStrip } from './Analysis'
import { lastMoveSquareStyles } from './format'
import { useBoardWidth } from './useBoardWidth'

type ChessboardProps = ComponentProps<typeof Chessboard>

/** Board arrows, named here because BoardPanel owns the Chessboard. */
export type Arrows = NonNullable<ChessboardProps['customArrows']>

/**
 * The board column every mode shares: sizing, orientation, the flip control,
 * the eval bar and the material strip.
 *
 * Guess, play and replay each grew their own copy of this, and the copies
 * drifted — replay shipped with no eval bar at all. Anything that should appear
 * on "a board" (coordinates, arrows, the underpromotion picker, #43) belongs
 * here so it can't land on only some screens.
 */
export function BoardPanel({
  id,
  fen,
  /** Which colour the viewer is playing; the board starts from their side. */
  orientedFor,
  whitePct = null,
  showEvalBar = true,
  showMaterial = true,
  offGame,
  lastMove,
  customSquareStyles,
  children,
  ...board
}: {
  id: string
  fen: string
  orientedFor: Color
  /** White's win probability for the eval bar, or null while it's unknown. */
  whitePct?: number | null
  showEvalBar?: boolean
  showMaterial?: boolean
  /**
   * The board is showing something other than the real game — a line being
   * walked, or a branch off it (#131).
   *
   * It belongs here rather than in a side panel because the board is what a
   * reader is looking at, and mistaking an imagined position for one that
   * actually occurred is the failure worth spending a ribbon on.
   */
  offGame?: { label: string; onLeave?: () => void }
  /**
   * UCI of the move that produced `fen`, marked on its two squares (#160).
   *
   * It lives here rather than on the guess screen for the reason the rest of
   * this component exists: "how did this position arrive" is a fact about a
   * board, and a board is shared. Absent — the first position of a game, or a
   * screen that has not adopted it — draws nothing.
   *
   * The caller owns the *when*: pass it only while `fen` is the position that
   * move actually led to, never against a line being walked or a move being
   * previewed.
   */
  lastMove?: string | null
  /** Controls that belong under the board (turn line, replay transport). */
  children?: ReactNode
} & Omit<ChessboardProps, 'id' | 'position' | 'boardWidth' | 'boardOrientation'>) {
  const { ref, width } = useBoardWidth()
  const [flipped, setFlipped] = useState(false)
  const whiteBottom = orientedFor === 'w' ? !flipped : flipped

  // Merged per square, not replaced: a square can be both the one you just
  // picked up and one the last move touched, and it should still say both.
  // The caller's style wins on the properties it sets, since it is the live
  // interaction and the mark is context.
  const squareStyles = useMemo(() => {
    const merged: Record<string, CSSProperties> = lastMoveSquareStyles(lastMove)
    for (const [square, style] of Object.entries(customSquareStyles ?? {})) {
      merged[square] = { ...merged[square], ...style }
    }
    return merged
  }, [lastMove, customSquareStyles])

  return (
    <div className={`board-col ${offGame ? 'off-game' : ''}`}>
      {offGame && (
        <div className="off-game-flag" role="status">
          <span className="off-game-dot" aria-hidden="true" />
          <span className="off-game-label">{offGame.label}</span>
          {offGame.onLeave && (
            <button className="btn ghost off-game-back" type="button" onClick={offGame.onLeave}>
              Back to the game
            </button>
          )}
        </div>
      )}
      <div className="board-row">
        {showEvalBar && <EvalBar whitePct={whitePct} whiteBottom={whiteBottom} />}
        <div className="board-frame" ref={ref}>
          <Chessboard
            id={id}
            position={fen}
            boardWidth={width}
            boardOrientation={whiteBottom ? 'white' : 'black'}
            customBoardStyle={{ borderRadius: '6px' }}
            customSquareStyles={squareStyles}
            {...board}
          />
        </div>
      </div>
      {showMaterial && <MaterialStrip material={materialBalance(fen)} />}
      <div className="board-controls">
        {children}
        <button
          className="btn ghost flip"
          type="button"
          onClick={() => setFlipped((f) => !f)}
          aria-label="Flip board"
          title="Flip board"
        >
          ⇅ Flip
        </button>
      </div>
    </div>
  )
}
