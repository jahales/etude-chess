import { describe, it, expect, vi } from 'vitest'
import { Chess } from 'chess.js'
import { act, render, renderHook, waitFor } from '@testing-library/react'
import { EvalBar, ExplorationBar, LinesPanel, useExploration } from './Analysis'
import type { AnalysisLine } from '../engine/analyser'
import type { AnalyserState } from '../app/useAnalyser'

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

// ---------- Walking a line on the board (#131) ----------

const PV = ['e2e4', 'e7e5', 'g1f3']
const LINE: AnalysisLine = { multipv: 1, score: { type: 'cp', value: 30 }, pv: PV }

/** The FEN after playing `sans` from the initial position. */
function after(...sans: string[]): string {
  const chess = new Chess()
  for (const san of sans) chess.move(san)
  return chess.fen()
}

describe('LinesPanel as a way into the line', () => {
  it('stays static text when nobody is listening', () => {
    const { container } = render(<LinesPanel fen={WHITE_TO_MOVE} lines={[LINE]} />)
    expect(container.querySelectorAll('.line-move')).toHaveLength(0)
    expect(container.querySelector('.line-pv')?.textContent).toBe('e4 e5 Nf3')
  })

  it('makes each move a button addressed by (line, index)', () => {
    const onPickMove = vi.fn()
    const { container } = render(
      <LinesPanel fen={WHITE_TO_MOVE} lines={[LINE]} onPickMove={onPickMove} />,
    )
    const moves = [...container.querySelectorAll<HTMLButtonElement>('.line-move')]
    expect(moves.map((b) => b.textContent)).toEqual(['e4', 'e5', 'Nf3'])
    act(() => moves[2]!.click())
    // The FEN travels with the click: it is what lets the reducer refuse to
    // walk a line against a position it was not computed for.
    expect(onPickMove).toHaveBeenCalledWith(WHITE_TO_MOVE, ['e4', 'e5', 'Nf3'], 2)
  })
})

/**
 * An `Analyser` whose answers are handed out on demand, so a test can hold a
 * search open while the board moves on underneath it.
 */
function deferredEngine() {
  const pending = new Map<string, (lines: AnalysisLine[]) => void>()
  const asked: string[] = []
  const engine: AnalyserState = {
    analyser: {
      evaluate: async () => ({ score: { type: 'cp', value: 0 }, bestMove: 'e2e4' }),
      analyseLines: (fen: string) => {
        asked.push(fen)
        return new Promise<AnalysisLine[]>((resolve) => pending.set(fen, resolve))
      },
      dispose: () => {},
    },
    ready: true,
    error: null,
  }
  return { engine, asked, answer: (fen: string, lines: AnalysisLine[]) => pending.get(fen)!(lines) }
}

describe('useExploration', () => {
  it('walks the board into the line and analyses where it landed', async () => {
    const { engine, asked, answer } = deferredEngine()
    const { result } = renderHook(() => useExploration(engine, WHITE_TO_MOVE))

    act(() => result.current.enter(WHITE_TO_MOVE, ['e4', 'e5', 'Nf3'], 1))
    expect(result.current.fen).toBe(after('e4', 'e5'))
    expect(result.current.offGame).toBe(true)

    await waitFor(() => expect(asked).toEqual([after('e4', 'e5')]))
    await act(async () => answer(after('e4', 'e5'), [LINE]))
    expect(result.current.lines).toEqual([LINE])
  })

  it('never shows a result computed for a position the board has left', async () => {
    // The cross-cutting rule, and the reason it is worth a test: the failure is
    // silent. Stale lines against a new position look exactly like real ones —
    // legal moves, a plausible score, and every claim in them false.
    const { engine, asked, answer } = deferredEngine()
    const { result } = renderHook(() => useExploration(engine, WHITE_TO_MOVE))

    act(() => result.current.enter(WHITE_TO_MOVE, ['e4', 'e5', 'Nf3'], 0))
    await waitFor(() => expect(asked).toContain(after('e4')))

    act(() => result.current.step(1)) // the board moves on mid-search
    await act(async () => answer(after('e4'), [LINE]))

    expect(result.current.fen).toBe(after('e4', 'e5'))
    expect(result.current.lines).toEqual([])
  })

  it('reports no exploration lines while the board is back on the game position', async () => {
    const { engine, answer, asked } = deferredEngine()
    const { result } = renderHook(() => useExploration(engine, WHITE_TO_MOVE))

    act(() => result.current.enter(WHITE_TO_MOVE, ['e4'], 0))
    await waitFor(() => expect(asked).toContain(after('e4')))
    await act(async () => answer(after('e4'), [LINE]))
    expect(result.current.lines).toEqual([LINE])

    act(() => result.current.seek(0))
    expect(result.current.offGame).toBe(false)
    expect(result.current.fen).toBeNull()
    expect(result.current.lines).toEqual([])
    expect(result.current.whitePct).toBeNull()
  })

  it('drops the exploration when the game moves to another position', () => {
    const { engine } = deferredEngine()
    const { result, rerender } = renderHook(({ root }) => useExploration(engine, root), {
      initialProps: { root: WHITE_TO_MOVE },
    })
    act(() => result.current.enter(WHITE_TO_MOVE, ['e4', 'e5'], 1))
    expect(result.current.offGame).toBe(true)

    rerender({ root: after('d4') })
    expect(result.current.exploration).toBeNull()
    expect(result.current.fen).toBeNull()
  })

  it('branches off when you play your own move, and rejects an illegal one', () => {
    const { engine } = deferredEngine()
    const { result } = renderHook(() => useExploration(engine, WHITE_TO_MOVE))

    let accepted = false
    act(() => {
      accepted = result.current.play('e2', 'e4')
    })
    expect(accepted).toBe(true)
    expect(result.current.fen).toBe(after('e4'))

    act(() => {
      result.current.play('a1', 'a8')
    })
    expect(result.current.fen).toBe(after('e4'))
  })

  it('steps with the arrow keys, and leaves them alone while you are typing', () => {
    const { engine } = deferredEngine()
    const { result } = renderHook(() => useExploration(engine, WHITE_TO_MOVE))
    act(() => result.current.enter(WHITE_TO_MOVE, ['e4', 'e5', 'Nf3'], 0))

    act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' })))
    expect(result.current.cursor).toBe(2)
    act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' })))
    expect(result.current.cursor).toBe(1)

    // The guess screen's reason box sits a few pixels from this board.
    const box = document.createElement('textarea')
    document.body.appendChild(box)
    act(() => void box.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })))
    expect(result.current.cursor).toBe(1)
    box.remove()
  })

  it('does nothing at all before you enter a line', () => {
    const { engine, asked } = deferredEngine()
    const { result } = renderHook(() => useExploration(engine, WHITE_TO_MOVE))
    expect(result.current.exploration).toBeNull()
    expect(asked).toEqual([])
  })
})

describe('ExplorationBar', () => {
  const ui = (moves: string[], ply: number) => {
    const { engine } = deferredEngine()
    const { result } = renderHook(() => useExploration(engine, WHITE_TO_MOVE))
    act(() => result.current.enter(WHITE_TO_MOVE, moves, ply))
    return result
  }

  it('says the board is not the game, in words', () => {
    const result = ui(['e4', 'e5'], 1)
    const { container } = render(<ExplorationBar explore={result.current} />)
    expect(container.querySelector('.exploring')?.className).toContain('off')
    expect(container.textContent).toContain('This is not the game')
  })

  it('does not claim to be off the game while sitting on the game position', () => {
    // Crying wolf costs more than the warning is worth: the marker has to mean
    // something every time it appears.
    const result = ui(['e4', 'e5'], 1)
    act(() => result.current.seek(0))
    const { container } = render(<ExplorationBar explore={result.current} />)
    expect(container.querySelector('.exploring')?.className).not.toContain('off')
    expect(container.textContent).not.toContain('This is not the game')
  })

  it('numbers the line from the position it started at', () => {
    // Rooted after 1.e4, so it reads "1…e5 2.Nf3" — an exploration almost never
    // starts at move one, and a line renumbered from there is a different game.
    const { engine } = deferredEngine()
    const { result } = renderHook(() => useExploration(engine, BLACK_TO_MOVE))
    act(() => result.current.enter(BLACK_TO_MOVE, ['e5', 'Nf3'], 0))
    const { container } = render(<ExplorationBar explore={result.current} />)
    const moves = [...container.querySelectorAll('.explore-move')].map((b) => b.textContent)
    expect(moves).toEqual(['start', '1…e5', '2.Nf3'])
  })
})
