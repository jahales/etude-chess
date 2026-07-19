import { describe, it, expect } from 'vitest'
import { annotationForSwing, moverColorAt, BLUNDER_MIN_SWING } from './annotation'
import { TIER_A_MAX_SWING, TIER_B_MAX_SWING, tierForSwing } from './grade'

describe('annotationForSwing', () => {
  it('marks nothing on a move that gave up little', () => {
    expect(annotationForSwing(0)).toBeUndefined()
    expect(annotationForSwing(TIER_A_MAX_SWING)).toBeUndefined()
  })

  it('marks an inaccuracy, a mistake and a blunder by how much was given up', () => {
    expect(annotationForSwing(TIER_A_MAX_SWING + 0.1)).toBe('?!')
    expect(annotationForSwing(TIER_B_MAX_SWING)).toBe('?!')
    expect(annotationForSwing(TIER_B_MAX_SWING + 0.1)).toBe('?')
    expect(annotationForSwing(BLUNDER_MIN_SWING)).toBe('??')
    expect(annotationForSwing(80)).toBe('??')
  })

  it('never contradicts the tier the coach reports for the same move', () => {
    // Two parts of the app disagreeing about one move would undermine both:
    // an "Inaccuracy" verdict must not sit beside a `?` glyph.
    for (let swing = 0; swing <= 100; swing += 0.5) {
      const tier = tierForSwing(swing)
      const glyph = annotationForSwing(swing)
      if (tier === 'A') expect(glyph).toBeUndefined()
      if (tier === 'B') expect(glyph).toBe('?!')
      if (tier === 'C') expect(['?', '??']).toContain(glyph)
    }
  })

  it('has no opinion when the swing is unknown', () => {
    // A gap in the analysis must read as "not measured", never as "fine".
    expect(annotationForSwing(undefined)).toBeUndefined()
  })
})

describe('moverColorAt', () => {
  it('alternates from White at ply 0', () => {
    expect(moverColorAt(0)).toBe('w')
    expect(moverColorAt(1)).toBe('b')
    expect(moverColorAt(6)).toBe('w')
  })
})
