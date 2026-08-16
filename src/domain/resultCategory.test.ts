import { describe, it, expect } from 'vitest'
import {
  changedResultCategory,
  flipWdl,
  nextImportantMove,
  resultCategory,
  whiteWdl,
  RESULT_MAJORITY,
} from './resultCategory'
import type { PositionEval } from './gameRecord'
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

// ---------- skipping to the next one ----------

/** A stored evaluation with a WDL, White's perspective. */
const at = (win: number, draw: number, loss: number): PositionEval => ({
  whitePct: win / 10,
  label: '+0.0',
  wdl: { win, draw, loss },
})
/** A stored evaluation from a pass that predates WDL, or a position it missed. */
const noWdl: PositionEval = { whitePct: 50, label: '0.0' }

describe('nextImportantMove', () => {
  // A five-question session over plies 0..8. The move at ply 4 is the one that
  // turned a win into a draw; everything else leaves the category alone.
  const evalByPly = [
    at(900, 90, 10), // after ply 0
    at(880, 110, 10),
    at(910, 80, 10),
    at(890, 100, 10),
    at(30, 950, 20), // after ply 4 — the win is gone
    at(20, 960, 20),
    at(20, 960, 20),
    at(10, 970, 20),
    at(10, 970, 20),
  ]
  const plies = [0, 2, 4, 6, 8]
  const startEval = at(950, 40, 10)

  it('lands on the move that changed the result, and says what it changed to', () => {
    const r = nextImportantMove({ plies, fromIndex: 0, evalByPly, startEval })
    expect(r.target).toEqual({ index: 2, ply: 4, before: 'white-wins', after: 'draw' })
  })

  it('scans forward only, never back to a moment already passed', () => {
    // A "next" button that could land behind you is not a next button.
    const r = nextImportantMove({ plies, fromIndex: 2, evalByPly, startEval })
    expect(r.target).toBeNull()
    expect(r.measured).toBe(2) // plies 6 and 8
    expect(r.unmeasured).toBe(0)
  })

  it('takes the first result-changer ahead, not the biggest', () => {
    // Ranking would put the reader somewhere further down the game than the
    // move they were about to reach — and choosing between two result-changing
    // moves is the severity judgment this module refuses to make.
    const twoChanges = [...evalByPly]
    twoChanges[6] = at(10, 100, 890) // the draw is thrown away too, later and worse
    const r = nextImportantMove({ plies, fromIndex: 0, evalByPly: twoChanges, startEval })
    expect(r.target?.ply).toBe(4)
  })

  it('measures the move at ply 0 against the start evaluation', () => {
    const r = nextImportantMove({
      plies: [0],
      fromIndex: -1,
      evalByPly: [at(20, 960, 20)],
      startEval: at(900, 90, 10),
    })
    expect(r.target?.ply).toBe(0)
    expect(r.measured).toBe(1)
  })

  it('cannot measure ply 0 with no start evaluation, and says so', () => {
    const r = nextImportantMove({ plies: [0], fromIndex: -1, evalByPly: [at(20, 960, 20)] })
    expect(r.target).toBeNull()
    expect(r.unmeasured).toBe(1)
    expect(r.measured).toBe(0)
  })

  it('counts a position with no recorded WDL as unmeasured, never as unchanged', () => {
    // The #132 distinction, at the place it would be lost: a pass that predates
    // WDL leaves `{whitePct, label}` behind, and treating those as "the result
    // held" would report a clean second half of a game nobody looked at.
    const gappy = [...evalByPly]
    gappy[3] = noWdl
    gappy[4] = noWdl
    const r = nextImportantMove({ plies, fromIndex: 0, evalByPly: gappy, startEval })
    expect(r.target).toBeNull()
    expect(r.unmeasured).toBe(1) // ply 4 — its "before" is gone
    expect(r.measured).toBe(3) // plies 2, 6 and 8, none of which changed anything
  })

  it('reports everything ahead as unmeasured when the game was never analysed', () => {
    const r = nextImportantMove({ plies, fromIndex: -1, evalByPly: undefined })
    expect(r.target).toBeNull()
    expect(r.measured).toBe(0)
    expect(r.unmeasured).toBe(5)
  })

  it('distinguishes "nothing changed the result" from "nothing was measured"', () => {
    // The two answers a caller must never merge. Both have a null target; only
    // one of them supports saying "no later move changed the result".
    const clean = nextImportantMove({
      plies: [0, 2],
      fromIndex: -1,
      evalByPly: [at(900, 90, 10), at(895, 95, 10), at(880, 110, 10)],
      startEval: at(910, 80, 10),
    })
    expect(clean).toEqual({ target: null, measured: 2, unmeasured: 0 })

    const blind = nextImportantMove({
      plies: [0, 2],
      fromIndex: -1,
      evalByPly: [noWdl, noWdl, noWdl],
      startEval: noWdl,
    })
    expect(blind).toEqual({ target: null, measured: 0, unmeasured: 2 })
  })

  it('keeps counting past the move it lands on, so the caveat covers the rest', () => {
    const gappy = [...evalByPly]
    gappy[5] = noWdl
    gappy[6] = noWdl
    const r = nextImportantMove({ plies, fromIndex: 0, evalByPly: gappy, startEval })
    expect(r.target?.ply).toBe(4)
    expect(r.unmeasured).toBe(1) // ply 6
    expect(r.measured).toBe(3) // plies 2, 4 and 8
  })

  it('reports nothing ahead when you are on the last question', () => {
    const r = nextImportantMove({ plies, fromIndex: 4, evalByPly, startEval })
    expect(r).toEqual({ target: null, measured: 0, unmeasured: 0 })
  })
})
