import { describe, it, expect } from 'vitest'
import { moveWording, type MoveSource } from './moveSource'

// #158: "master" is a claim about who played the move, and it is only true of
// the curated pack. These tests pin the claim, not the prose — each case asserts
// what the words must and must not say about the player.

const ALL: MoveSource[] = [
  { kind: 'master' },
  { kind: 'you' },
  { kind: 'player', name: 'other_player' },
  { kind: 'unnamed' },
]

describe('moveWording', () => {
  it('calls it the master’s move only for the curated pack', () => {
    expect(moveWording({ kind: 'master' }).legend).toContain('master')

    for (const source of ALL.filter((s) => s.kind !== 'master')) {
      const w = moveWording(source)
      const everything = [w.tag, w.legend, w.yourLegend, w.sentence, w.matched, w.field].join(' ')
      expect(everything.toLowerCase()).not.toContain('master')
    }
  })

  it('keeps the pack’s own wording, which was never the wrong claim', () => {
    const w = moveWording({ kind: 'master' })
    expect(w.yourVerb).toBe('you played')
    expect(w.tag).toBe('master')
    expect(w.sentence).toBe('The master played')
    expect(w.matched).toContain('matched the master')
    expect(w.field).toBe("Master's move")
  })

  it('tells your two moves apart in a game you played', () => {
    // The case the bug was found in: both moves are yours, so wording that
    // named only one of them as "you" said nothing at all.
    const w = moveWording({ kind: 'you' })
    expect(w.yourVerb).not.toBe(w.tag)
    expect(w.legend).not.toBe(w.yourLegend)
    expect(w.tag).toContain('in the game')
    expect(w.legend).toContain('in the game')
    expect(w.yourLegend).toContain('just')
    expect(w.field).toContain('I played in the game')
  })

  it('credits your own move to the engine’s verdict, never to your past self', () => {
    // Playing the same move twice is agreement, not a grade. What graded it was
    // Stockfish (`engine/grading.ts`), and that is what the sentence says.
    expect(moveWording({ kind: 'you' }).matched).toContain('engine')
  })

  it('names the player when the file named one', () => {
    const w = moveWording({ kind: 'player', name: 'other_player' })
    expect(w.tag).toBe('other_player played')
    expect(w.legend).toBe('other_player’s move')
    expect(w.sentence).toBe('other_player played')
    expect(w.matched).toContain('other_player')
    expect(w.field).toBe("other_player's move")
  })

  it('falls back to the game itself, never to a person, when nobody is named', () => {
    const w = moveWording({ kind: 'unnamed' })
    expect(w.tag).toBe('in the game')
    expect(w.legend).toBe('the move played in the game')
    expect(w.sentence).toBe('The game continued')
    expect(w.field).toBe('The move played in the game')
  })

  it('gives every source a full set of phrases', () => {
    for (const source of ALL) {
      const w = moveWording(source)
      for (const [key, phrase] of Object.entries(w)) {
        expect(phrase, key).toBeTruthy()
      }
    }
  })
})
