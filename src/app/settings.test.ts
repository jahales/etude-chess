import { describe, it, expect } from 'vitest'
import {
  STRENGTH_PRESETS,
  DEFAULT_SETTINGS,
  presetIdForNodes,
  liveEvalNodes,
} from './settings'

describe('analysis settings', () => {
  it('has ascending, distinct strength presets', () => {
    const nodes = STRENGTH_PRESETS.map((p) => p.nodes)
    expect(nodes).toEqual([...nodes].sort((a, b) => a - b))
    expect(new Set(nodes).size).toBe(nodes.length)
  })

  it('maps node budgets back to a preset id, defaulting to balanced', () => {
    expect(presetIdForNodes(300_000)).toBe('fast')
    expect(presetIdForNodes(DEFAULT_SETTINGS.nodes)).toBe('balanced')
    expect(presetIdForNodes(999)).toBe('balanced')
  })

  it('keeps the live eval light regardless of strength', () => {
    expect(liveEvalNodes({ nodes: 1_500_000, multipv: 3 })).toBe(300_000)
    expect(liveEvalNodes({ nodes: 300_000, multipv: 3 })).toBe(300_000)
  })
})
