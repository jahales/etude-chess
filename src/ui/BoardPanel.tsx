import { useState, type ComponentProps, type ReactNode } from 'react'
import { Chessboard } from 'react-chessboard'
import { materialBalance } from '../domain/material'
import type { Color } from '../domain/types'
import { EvalBar, MaterialStrip } from './Analysis'
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
  /** Controls that belong under the board (turn line, replay transport). */
  children?: ReactNode
} & Omit<ChessboardProps, 'id' | 'position' | 'boardWidth' | 'boardOrientation'>) {
  const { ref, width } = useBoardWidth()
  const [flipped, setFlipped] = useState(false)
  const whiteBottom = orientedFor === 'w' ? !flipped : flipped

  return (
    <div className="board-col">
      <div className="board-row">
        {showEvalBar && <EvalBar whitePct={whitePct} whiteBottom={whiteBottom} />}
        <div className="board-frame" ref={ref}>
          <Chessboard
            id={id}
            position={fen}
            boardWidth={width}
            boardOrientation={whiteBottom ? 'white' : 'black'}
            customBoardStyle={{ borderRadius: '6px' }}
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
