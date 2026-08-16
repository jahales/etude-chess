import { describe, it, expect } from 'vitest'
import {
  changedResultCategory,
  flipWdl,
  resultCategory,
  whiteWdl,
  RESULT_MAJORITY,
} from './resultCategory'
import type { Wdl } from './types'

const wdl = (win: number, draw: number, loss: number): Wdl => ({ win, draw, loss })

describe('flipWdl', () => {
  it('trades win for loss and leaves the draw alone', () => {
    expect(flipWdl(wdl(700, 250, 50))).toEqual(wdl(50, 250, 700))
  })
  it('is its own inverse', () => {
    const w = wdl(123, 456, 421)
    expect(flipWdl(flipWdl(w))).toEqual(w)
  })
})

describe('whiteWdl', () => {
  it('leaves a White-to-move reading alone and flips a Black-to-move one', () => {
    const stm = wdl(800, 150, 50)
    expect(whiteWdl(stm, 'w')).toEqual(stm)
    expect(whiteWdl(stm, 'b')).toEqual(wdl(50, 150, 800))
  })
})

describe('resultCategory', () => {
  it('names the result only when one outcome holds a majority', () => {
    expect(resultCategory(wdl(1000, 0, 0))).toBe('white-wins')
    expect(resultCategory(wdl(0, 0, 1000))).toBe('black-wins')
    expect(resultCategory(wdl(1, 998, 1))).toBe('draw')
  })

  it('calls a position with no majority anyone’s game', () => {
    // The case a plurality rule gets wrong: White is the likeliest single
    // outcome and is still less likely than not.
    expect(resultCategory(wdl(400, 300, 300))).toBe('unclear')
    expect(resultCategory(wdl(480, 300, 220))).toBe('unclear')
  })

  it('treats the threshold itself as not yet a majority', () => {
    // Exactly half is not "more likely than everything else together".
    expect(resultCategory(wdl(RESULT_MAJORITY, 500, 0))).toBe('unclear')
    expect(resultCategory(wdl(RESULT_MAJORITY + 1, 499, 0))).toBe('white-wins')
  })

  it('never names two results at once, whatever the split', () => {
    // Guarding the invariant the majority rule buys: the three sum to 1000, so
    // at most one can clear 500 and the answer is never ambiguous.
    for (let win = 0; win <= 1000; win += 25) {
      for (let draw = 0; draw + win <= 1000; draw += 25) {
        const c = resultCategory(wdl(win, draw, 1000 - win - draw))
        expect(['white-wins', 'draw', 'black-wins', 'unclear']).toContain(c)
      }
    }
  })
})

describe('changedResultCategory — the importance rule', () => {
  it('is false for a large win% swing that never risked the result', () => {
    // The skill's own example (`game-review` §4): +8.0 to +4.0 is an enormous
    // swing in win% and `1000/0/0` either side of it. Nothing was at stake.
    expect(changedResultCategory(wdl(1000, 0, 0), wdl(1000, 0, 0))).toBe(false)
    expect(changedResultCategory(wdl(998, 2, 0), wdl(920, 78, 2))).toBe(false)
  })

  it('is true for a small swing that lost the game', () => {
    // +0.3 to −0.3 is a few win%; it is also the move that turned a game White
    // was winning into one Black was. This is the pair win% swing ranks the
    // wrong way round, and the reason the owner asked for WDL.
    expect(changedResultCategory(wdl(600, 350, 50), wdl(50, 350, 600))).toBe(true)
  })

  it('catches a win thrown away into a draw, and a draw thrown away into a loss', () => {
    expect(changedResultCategory(wdl(900, 100, 0), wdl(20, 960, 20))).toBe(true)
    expect(changedResultCategory(wdl(20, 960, 20), wdl(0, 100, 900))).toBe(true)
  })

  it('sees a position becoming decided, and a decided one reopening', () => {
    expect(changedResultCategory(wdl(400, 300, 300), wdl(900, 90, 10))).toBe(true)
    expect(changedResultCategory(wdl(900, 90, 10), wdl(400, 300, 300))).toBe(true)
  })

  it('is symmetric under a perspective flip of both sides', () => {
    // The rule must not depend on whose eyes it is read through — only on both
    // readings being in the *same* pair of eyes.
    const before = wdl(700, 250, 50)
    const after = wdl(100, 600, 300)
    expect(changedResultCategory(before, after)).toBe(
      changedResultCategory(flipWdl(before), flipWdl(after)),
    )
  })

  it('reports a reversal on a quiet move if one side is left unflipped', () => {
    // Not a rule, a warning pinned as a test: the engine reports WDL from the
    // side to move, so comparing a raw "after" against a White-perspective
    // "before" makes every ordinary move look like it threw the game away.
    const stillWinningForWhite = wdl(900, 90, 10)
    const sameThingSideToMove = flipWdl(stillWinningForWhite) // Black now to move
    expect(changedResultCategory(stillWinningForWhite, sameThingSideToMove)).toBe(true)
    expect(changedResultCategory(stillWinningForWhite, flipWdl(sameThingSideToMove))).toBe(false)
  })

  it('grades nothing — the answer is a boolean, not a size', () => {
    // Structural, and the point of the module: there is no magnitude here to be
    // tempted into ranking moves by, which is how a second grading scale starts
    // (ADR 0010, constitution §9).
    expect(typeof changedResultCategory(wdl(1000, 0, 0), wdl(0, 0, 1000))).toBe('boolean')
  })
})
