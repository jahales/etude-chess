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
