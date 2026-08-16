import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { useBoardWidth } from './useBoardWidth'

// jsdom ships no ResizeObserver, and it lays nothing out — every box is 0×0.
// So this file asserts the *wiring* only: that the hook hands CSS the one term
// CSS cannot compute for itself. Whether the resulting board actually fits the
// window is a question only a real browser can answer, and #150 was verified by
// driving one.
vi.stubGlobal(
  'ResizeObserver',
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
)

function Board({ top }: { top: number }) {
  const { ref, width } = useBoardWidth()
  return (
    <div
      ref={(el) => {
        if (el) el.getBoundingClientRect = () => ({ top }) as DOMRect
        ref.current = el
      }}
      data-testid="frame"
      data-width={width}
    />
  )
}

const topVar = () => document.documentElement.style.getPropertyValue('--board-top')

afterEach(cleanup)

describe('useBoardWidth', () => {
  it('publishes where the board starts, which is what caps it against the viewport height', () => {
    render(<Board top={84} />)
    expect(topVar()).toBe('84px')
  })

  it('leaves no measurement behind, so the next board is not sized at the last one’s position', () => {
    const { unmount } = render(<Board top={84} />)
    unmount()
    expect(topVar()).toBe('')
  })

  it('never reports a board smaller than the floor, however the frame measures', () => {
    const { getByTestId } = render(<Board top={0} />)
    // jsdom reports clientWidth 0; a board rendered at 0 is a board you cannot use.
    expect(Number(getByTestId('frame').dataset.width)).toBe(260)
  })
})
