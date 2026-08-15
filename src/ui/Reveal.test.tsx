import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { Reveal } from './Reveal'
import { buildFactBundle } from '../domain/factBundle'
import { explain } from '../domain/factBundle'
import type { QuizItem } from '../domain/harness'

/**
 * §11's two acceptance criteria, at the place they are actually about: a game
 * imported with comments shows one at the matching reveal, and a game without
 * comments reveals exactly as it did before #55.
 */

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'

const fb = buildFactBundle({
  fen: START,
  userMoveSan: 'e4',
  bestMoveUci: 'd2d4',
  masterMoveSan: 'd4',
  grade: { bestWinPercent: 55, playedWinPercent: 52, swing: 3, tier: 'B' },
})

const item: QuizItem = {
  fen: START,
  ply: 8,
  moveNumber: 5,
  sideToMove: 'w',
  masterMoveSan: 'd4',
  masterMoveUci: 'd2d4',
}

const note = { text: 'A classic space-gaining advance.', source: 'mygames.pgn' }

const reveal = (props: Partial<Parameters<typeof Reveal>[0]> = {}) =>
  render(<Reveal fb={fb} item={item} onNext={() => {}} last={false} {...props} />).container

describe('the reveal with an imported game’s annotation', () => {
  it('shows the note and names the file it came from', () => {
    const c = reveal({ note })
    expect(c.textContent).toContain('A classic space-gaining advance.')
    expect(c.textContent).toContain('mygames.pgn')
  })

  it('keeps our why and their note as two separately attributed blocks', () => {
    // The honesty rule, pinned rather than trusted to careful editing: someone
    // else's prose out of a file the user supplied sits next to an
    // engine-derived sentence of ours, and neither may be readable as the other
    // (constitution §9, §12). So the note is quoted, not merged into the
    // paragraph, and both blocks say whose they are.
    const c = reveal({ note })
    const quote = c.querySelector('.source-quote blockquote')!
    expect(quote.textContent).toBe(note.text)

    const why = c.querySelector('.why')!
    expect(why.textContent).toBe(explain(fb))
    expect(why.textContent).not.toContain(note.text)

    expect(c.querySelector('.whose.ours')?.textContent).toMatch(/étude/)
    expect(c.querySelector('.whose.theirs')?.textContent).toMatch(/the file's own note/)
  })

  it('reveals exactly as before for a game the file did not annotate', () => {
    // Stronger than "no note is shown": the annotated reveal minus its note is
    // byte-for-byte the un-annotated one, so #55 can only ever have added to
    // this screen — a pack game's reveal is untouched.
    const plain = reveal({ note: null })
    const stripped = reveal({ note })
    stripped.querySelector('.source-note')!.remove()
    expect(stripped.innerHTML).toBe(plain.innerHTML)

    expect(plain.textContent).not.toContain('mygames.pgn')
    expect(plain.querySelector('.source-note')).toBeNull()
    expect(plain.querySelector('.whose')).toBeNull()
  })

  it('shows nothing at a ply the file left alone', () => {
    // `annotationAt` hands back null for an unannotated ply; the reveal must
    // then look like any other.
    expect(reveal({ note: undefined }).querySelector('.source-note')).toBeNull()
  })
})
