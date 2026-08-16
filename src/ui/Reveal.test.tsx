import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { Reveal } from './Reveal'
import { buildFactBundle } from '../domain/factBundle'
import { explain } from '../domain/factBundle'
import type { MoveSource } from '../domain/moveSource'
import type { QuizItem } from '../domain/harness'

/**
 * §11's two acceptance criteria, at the place they are actually about: a game
 * imported with comments shows one at the matching reveal, and a game without
 * comments reveals exactly as it did before #55.
 */

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'

const bundle = (moveSource: MoveSource = { kind: 'master' }, over: Partial<Parameters<typeof buildFactBundle>[0]> = {}) =>
  buildFactBundle({
    fen: START,
    userMoveSan: 'e4',
    bestMoveUci: 'd2d4',
    gameMoveSan: 'd4',
    moveSource,
    grade: { bestWinPercent: 55, playedWinPercent: 52, swing: 3, tier: 'B' },
    ...over,
  })

const fb = bundle()

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

/**
 * #158: the same honesty rule, applied to the *moves* rather than to the prose.
 * The screen shows two moves and used to call the second one the master's
 * whatever the game was — including on the owner's own ~1100 blitz game, where
 * both of them were his.
 */
describe('what the reveal calls the game’s own move', () => {
  const header = (c: HTMLElement) => c.querySelector('.your-move')!.textContent
  const legend = (c: HTMLElement) => c.querySelector('.arrow-key')!.textContent!

  it('says master for the curated pack, which is the one place it is true', () => {
    const c = reveal()
    expect(header(c)).toBe('you played e4 · master d4')
    expect(legend(c)).toContain('master’s move')
  })

  it('tells your two moves apart in a game you played', () => {
    // Both moves are yours here, so "you played … · your move" named neither.
    const c = reveal({ fb: bundle({ kind: 'you' }) })
    expect(header(c)).toBe('you chose e4 · in the game you played d4')
    expect(legend(c)).toContain('the move you played in the game')
    expect(legend(c)).toContain('the move you just chose')
    expect(c.textContent!.toLowerCase()).not.toContain('master')
  })

  it('names the player whose game it is when the file named one', () => {
    const c = reveal({ fb: bundle({ kind: 'player', name: 'other_player' }) })
    expect(header(c)).toBe('you played e4 · other_player played d4')
    expect(legend(c)).toContain('other_player’s move')
    expect(c.textContent!.toLowerCase()).not.toContain('master')
  })

  it('falls back to the game, never to a person, when the file named nobody', () => {
    const c = reveal({ fb: bundle({ kind: 'unnamed' }) })
    expect(header(c)).toBe('you played e4 · in the game d4')
    expect(legend(c)).toContain('the move played in the game')
    expect(c.textContent!.toLowerCase()).not.toContain('master')
  })

  it('keeps the arrow legend’s three entries and their swatches', () => {
    // Only the words changed: the colours, and which move each names, did not.
    const c = reveal({ fb: bundle({ kind: 'you' }, { bestMoveUci: 'b1c3' }) })
    expect([...c.querySelectorAll('.arrow-key .swatch')].map((s) => s.className)).toEqual([
      'swatch master',
      'swatch engine',
      'swatch user',
    ])
  })
})

// ---------- the result either side of your move (#161) ----------

describe('the win/draw/loss line at the reveal', () => {
  const shift = (
    before: [number, number, number],
    after: [number, number, number],
  ) => ({
    before: { win: before[0], draw: before[1], loss: before[2] },
    after: { win: after[0], draw: after[1], loss: after[2] },
  })

  it('says the result held when a big win% swing changed nothing', () => {
    // The `game-review` skill §4 case, at the screen it is about: the badge says
    // "Inaccuracy" and the game was already over. Without this line the reveal
    // implied the game hung on a move that risked nothing.
    const c = reveal({ resultShift: shift([1000, 0, 0], [1000, 0, 0]) })
    expect(c.textContent).toContain('The likely result did not change')
    expect(c.textContent).toContain('White wins')
    expect(c.querySelector('.result-shift')!.className).toContain('held')
  })

  it('says the result changed when a small swing lost the game', () => {
    const c = reveal({ resultShift: shift([600, 350, 50], [50, 350, 600]) })
    expect(c.textContent).toContain('Your move changed the likely result')
    expect(c.textContent).toContain('from White wins to Black wins')
    expect(c.querySelector('.result-shift')!.className).toContain('changed')
  })

  it('shows both readings as percentages, before then after', () => {
    const c = reveal({ resultShift: shift([820, 150, 30], [410, 500, 90]) })
    const numbers = c.querySelector('.result-numbers')!.textContent!
    expect(numbers).toContain('82/15/3')
    expect(numbers).toContain('41/50/9')
    expect(numbers).toContain('win/draw/loss for White')
  })

  it('names it as the engine’s expectancy, not a prediction', () => {
    // Constitution §12: no number on this screen may imply we know how the game
    // would actually have gone.
    const c = reveal({ resultShift: shift([1000, 0, 0], [1000, 0, 0]) })
    expect(c.querySelector('.result-caveat')!.textContent).toContain('not a prediction')
  })

  it('renders exactly the reveal it always did when there is no WDL', () => {
    const c = reveal()
    expect(c.querySelector('.result-shift')).toBeNull()
    expect(c.textContent).toContain(explain(fb))
  })
})

// ---------- skipping to the next important move (#161) ----------

describe('the skip-ahead control', () => {
  const target = { index: 4, ply: 12, before: 'white-wins' as const, after: 'draw' as const }

  it('offers the jump when there is a later move that changed the result', () => {
    const c = reveal({ skip: { target, measured: 6, unmeasured: 0 }, onSkip: () => {} })
    expect(c.querySelector('.btn.skip')!.textContent).toContain(
      'Skip to the next move that changed the result',
    )
    expect(c.querySelector('.skip-note')).toBeNull()
  })

  it('says "no later move changed the result" only when everything ahead was measured', () => {
    const c = reveal({ skip: { target: null, measured: 6, unmeasured: 0 }, onSkip: () => {} })
    expect(c.querySelector('.btn.skip')).toBeNull()
    expect(c.textContent).toContain('No later move in this game changed the result')
  })

  it('names the gap instead of claiming nothing is left, when nothing was measured', () => {
    // The #132 distinction at the screen it would be lost on: an old stored pass
    // carries no WDL, and reporting "nothing more to skip to" would tell the
    // reader they played a clean second half of a game nobody looked at.
    const c = reveal({ skip: { target: null, measured: 0, unmeasured: 9 }, onSkip: () => {} })
    expect(c.textContent).toContain('No win/draw/loss recorded for the 9 positions ahead')
    expect(c.textContent).not.toContain('No later move in this game changed the result')
  })

  it('reports both counts when the pass covered only part of what is ahead', () => {
    const c = reveal({ skip: { target: null, measured: 4, unmeasured: 3 }, onSkip: () => {} })
    expect(c.textContent).toContain('of the 4 positions ahead we could measure')
    expect(c.textContent).toContain('other 3 have no win/draw/loss recorded')
  })

  it('warns that a jump over unmeasured positions may have stepped past one', () => {
    const c = reveal({ skip: { target, measured: 4, unmeasured: 3 }, onSkip: () => {} })
    expect(c.querySelector('.btn.skip')).not.toBeNull()
    expect(c.textContent).toContain('not necessarily the next one there is')
  })

  it('says nothing at all on the last question', () => {
    const c = reveal({ skip: { target: null, measured: 0, unmeasured: 0 }, onSkip: () => {} })
    expect(c.querySelector('.skip-ahead')).toBeNull()
  })

  it('is absent entirely when the session must not offer it', () => {
    // A critical-positions session, or the curated pack: `skip` is null and no
    // sentence is rendered, because neither has a claim to make.
    expect(reveal({ skip: null, onSkip: () => {} }).querySelector('.skip-ahead')).toBeNull()
    expect(reveal().querySelector('.skip-ahead')).toBeNull()
  })

  it('fires the jump when clicked', () => {
    let jumped = 0
    const c = reveal({ skip: { target, measured: 6, unmeasured: 0 }, onSkip: () => jumped++ })
    ;(c.querySelector('.btn.skip') as HTMLButtonElement).click()
    expect(jumped).toBe(1)
  })
})
