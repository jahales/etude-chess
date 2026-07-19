import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { EvalBar, LinesPanel } from './Analysis'

const WHITE_TO_MOVE = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
const BLACK_TO_MOVE = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1'

describe('EvalBar orientation (review #2)', () => {
  it("anchors White's fill to the bottom when White is at the bottom", () => {
    const { container } = render(<EvalBar whitePct={70} whiteBottom={true} />)
    const fill = container.querySelector('.evalbar-white') as HTMLElement
    expect(fill.style.height).toBe('70%')
    expect(fill.style.top).toBe('auto')
    expect(fill.style.bottom).not.toBe('auto') // anchored to the bottom
  })

  it("anchors White's fill to the top when the board is flipped", () => {
    const { container } = render(<EvalBar whitePct={70} whiteBottom={false} />)
    const fill = container.querySelector('.evalbar-white') as HTMLElement
    expect(fill.style.bottom).toBe('auto')
    expect(fill.style.top).not.toBe('auto') // anchored to the top (White is now up top)
  })
})

describe('LinesPanel score perspective', () => {
  const line = (cp: number) => ({ multipv: 1, score: { type: 'cp' as const, value: cp }, pv: ['e2e4'] })

  it('shows White-perspective scores when White is to move', () => {
    const { container } = render(<LinesPanel fen={WHITE_TO_MOVE} lines={[line(131)]} />)
    expect(container.querySelector('.line-score')?.textContent).toBe('+1.31')
  })

  it('negates when Black is to move, so it agrees with the bar and chip beside it', () => {
    // UCI scores are side-to-move relative. Showing +1.31 here while the eval
    // bar and score chip both read −1.31 for the same position is the bug this
    // pins: architecture.md requires White's perspective for "bar, chip, move
    // list, lines".
    const { container } = render(<LinesPanel fen={BLACK_TO_MOVE} lines={[line(131)]} />)
    expect(container.querySelector('.line-score')?.textContent).toBe('−1.31')
  })
})
