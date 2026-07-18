import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { EvalBar } from './Analysis'

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
