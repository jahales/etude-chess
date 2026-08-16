import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render } from '@testing-library/react'
import { BoardPanel } from './BoardPanel'

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'

// jsdom ships no ResizeObserver and `useBoardWidth` observes the board frame.
// Sizing is not what this file is about, so it is stubbed rather than faked.
vi.stubGlobal(
  'ResizeObserver',
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
)

/**
 * The board's own "this is not the game" marker (#131).
 *
 * It is asserted here rather than reviewed by eye because the failure it guards
 * against is a reader taking an explored position for one that actually
 * occurred — and every screen that walks a line shares this component, so a
 * marker that only reaches some of them is the drift `BoardPanel` exists to
 * stop.
 */
describe('BoardPanel off-game marker', () => {
  it('says nothing at all when the board is the game', () => {
    const { container } = render(<BoardPanel id="t" fen={START} orientedFor="w" />)
    expect(container.querySelector('.off-game-flag')).toBeNull()
    expect(container.querySelector('.board-col')?.className).not.toContain('off-game')
  })

  it('flags the board and offers the way back', () => {
    const onLeave = vi.fn()
    const { container, getByRole } = render(
      <BoardPanel
        id="t"
        fen={START}
        orientedFor="w"
        offGame={{ label: 'Exploring — not the game', onLeave }}
      />,
    )
    expect(container.querySelector('.off-game-label')?.textContent).toBe(
      'Exploring — not the game',
    )
    // A class on the column, so the board itself is marked and not just a label
    // above it.
    expect(container.querySelector('.board-col')?.className).toContain('off-game')
    fireEvent.click(getByRole('button', { name: 'Back to the game' }))
    expect(onLeave).toHaveBeenCalled()
  })
})

/**
 * The mark on the move that produced the position (#160).
 *
 * Asserted on the squares themselves because the two failures worth guarding
 * are both invisible in a screenshot review that happens to start at item 2: a
 * position with no move before it drawing an empty mark, and a mark landing on
 * the wrong pair of squares.
 */
describe('BoardPanel last-move mark', () => {
  // react-chessboard puts `customSquareStyles` on the square's inner element —
  // the one sized to the square — not on the `[data-square]` wrapper.
  const styleOf = (container: HTMLElement, square: string) =>
    (container.querySelector(`[data-square="${square}"] > *`) as HTMLElement | null)?.style

  it('marks both squares of the move that led here', () => {
    const { container } = render(<BoardPanel id="t" fen={START} orientedFor="w" lastMove="g8f6" />)
    expect(styleOf(container, 'g8')?.boxShadow).toBeTruthy()
    expect(styleOf(container, 'f6')?.boxShadow).toBeTruthy()
    expect(styleOf(container, 'e4')?.boxShadow).toBeFalsy()
  })

  it('marks nothing when there was no move before this position', () => {
    for (const lastMove of [undefined, null, '']) {
      const { container } = render(
        <BoardPanel id="t" fen={START} orientedFor="w" lastMove={lastMove} />,
      )
      const marked = [...container.querySelectorAll('[data-square] > *')].filter(
        (el) => (el as HTMLElement).style.boxShadow,
      )
      expect(marked).toHaveLength(0)
    }
  })

  it('keeps a caller’s own highlight on a square the move also touched', () => {
    const { container } = render(
      <BoardPanel
        id="t"
        fen={START}
        orientedFor="w"
        lastMove="g8f6"
        customSquareStyles={{ f6: { background: 'rgba(53, 96, 73, 0.35)' } }}
      />,
    )
    expect(styleOf(container, 'f6')?.boxShadow).toBeTruthy()
    expect(styleOf(container, 'f6')?.background).toContain('53, 96, 73')
    // …and a square only the caller styled keeps working as it always did.
    expect(styleOf(container, 'g8')?.background).toBeFalsy()
  })
})
