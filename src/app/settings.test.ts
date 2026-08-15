import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import {
  STRENGTH_PRESETS,
  DEFAULT_SETTINGS,
  presetIdForNodes,
  liveEvalNodes,
  parsePlayerNames,
  formatPlayerNames,
  loadPlayerNames,
  savePlayerNames,
  PLAYER_NAMES_KEY,
  REVIEW_NODES_KEY,
  loadReviewNodes,
  saveReviewNodes,
} from './settings'
import { ANALYSIS_BUDGETS, BATCH_NODES } from './gameAnalysis'

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

// The names you play under (#130) — the list that lets an imported game be
// recognised as yours. Matching itself is `domain/studyGame.yourSide`; this is
// the list, how it is typed, and how it survives a reload.

describe('the names you play under', () => {
  it('takes one name per line, trimmed, and ignores the blank ones', () => {
    expect(parsePlayerNames('  quiet_etude \n\n  Hales, Jacob\n  ')).toEqual([
      'quiet_etude',
      'Hales, Jacob',
    ])
  })

  it('keeps a comma inside a name, because a PGN name is "Lastname, Firstname"', () => {
    // Splitting on commas is the obvious shortcut and it is wrong: it would turn
    // the single name written in every OTB export into two names that match
    // nothing.
    expect(parsePlayerNames('Hales, Jacob')).toEqual(['Hales, Jacob'])
  })

  it('drops a repeat that differs only in case, keeping what you typed first', () => {
    // Matching ignores case, so these are one name; keeping both would show the
    // same name twice in the field it was typed into.
    expect(parsePlayerNames('Quiet_Etude\nquiet_etude')).toEqual(['Quiet_Etude'])
  })

  it('round-trips through the field it was typed into', () => {
    const names = ['quiet_etude', 'Hales, Jacob']
    expect(parsePlayerNames(formatPlayerNames(names))).toEqual(names)
    expect(formatPlayerNames([])).toBe('')
  })
})

/**
 * An in-memory `Storage`, because the test global has none: vitest copies a
 * jsdom global across only when Node doesn't already define the name, and Node
 * 24 defines `localStorage` itself (as nothing, without `--localstorage-file`).
 * So the browser API the app actually runs against is supplied here rather than
 * assumed — and the throwing variant below is the same seam.
 */
function memoryStorage(): Storage {
  const values = new Map<string, string>()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, String(value)),
    removeItem: (key) => void values.delete(key),
    clear: () => values.clear(),
    key: (i) => [...values.keys()][i] ?? null,
    get length() {
      return values.size
    },
  } as Storage
}

describe('remembering the names between sessions', () => {
  beforeEach(() => vi.stubGlobal('localStorage', memoryStorage()))
  afterEach(() => vi.unstubAllGlobals())

  it('starts with none — a handle is the owner’s to enter, never a default', () => {
    expect(loadPlayerNames()).toEqual([])
  })

  it('reads back what was saved', () => {
    savePlayerNames(['quiet_etude', 'Hales, Jacob'])
    expect(loadPlayerNames()).toEqual(['quiet_etude', 'Hales, Jacob'])
  })

  it('forgets rather than leaving an empty list behind', () => {
    savePlayerNames(['quiet_etude'])
    savePlayerNames([])
    expect(loadPlayerNames()).toEqual([])
    expect(localStorage.getItem(PLAYER_NAMES_KEY)).toBeNull()
  })

  it('ignores a stored value that is not a list of names', () => {
    // Nothing stops a user (or a future version) leaving something else under
    // the key, and a study screen that throws on load is worse than one that
    // asks who you are again.
    localStorage.setItem(PLAYER_NAMES_KEY, 'not json at all')
    expect(loadPlayerNames()).toEqual([])
    localStorage.setItem(PLAYER_NAMES_KEY, '{"you":"quiet_etude"}')
    expect(loadPlayerNames()).toEqual([])
    localStorage.setItem(PLAYER_NAMES_KEY, '["quiet_etude", 7, "  "]')
    expect(loadPlayerNames()).toEqual(['quiet_etude'])
  })

  it('survives storage being unavailable, in both directions', () => {
    // Safari in private browsing throws from `setItem`, an embedded context can
    // refuse `getItem` outright, and a server-side render has no `localStorage`
    // at all. None of those may take the study screen down with them.
    const refuses = (): never => {
      throw new Error('storage denied')
    }
    vi.stubGlobal('localStorage', { getItem: refuses, setItem: refuses, removeItem: refuses })
    expect(loadPlayerNames()).toEqual([])
    expect(() => savePlayerNames(['quiet_etude'])).not.toThrow()
    expect(() => savePlayerNames([])).not.toThrow()

    vi.stubGlobal('localStorage', undefined)
    expect(loadPlayerNames()).toEqual([])
    expect(() => savePlayerNames(['quiet_etude'])).not.toThrow()
  })
})

// #144: the budget a whole-game pass runs at. Unlike the grading settings above,
// this one decides what a *stored* pass means, so a value we cannot place is
// more dangerous than a missing one.
describe('the review pass budget', () => {
  // Same seam as the names above: Node 24 defines `localStorage` itself, as
  // nothing, so the browser API is supplied rather than assumed.
  beforeEach(() => vi.stubGlobal('localStorage', memoryStorage()))
  afterEach(() => vi.unstubAllGlobals())

  it('defaults to the shared pass budget', () => {
    expect(loadReviewNodes()).toBe(BATCH_NODES)
  })

  it('remembers a budget that is one we offer', () => {
    const quick = ANALYSIS_BUDGETS.find((b) => b.nodes !== BATCH_NODES)!
    saveReviewNodes(quick.nodes)
    expect(loadReviewNodes()).toBe(quick.nodes)
  })

  it('refuses a stored budget that is not one of ours', () => {
    // A hand-edited or stale value would otherwise run a pass at a budget
    // nothing has measured, and then file it as though it had — and every claim
    // this app makes about a game rests on knowing which budget produced it.
    localStorage.setItem(REVIEW_NODES_KEY, '150000')
    expect(loadReviewNodes()).toBe(BATCH_NODES)
    localStorage.setItem(REVIEW_NODES_KEY, 'lots')
    expect(loadReviewNodes()).toBe(BATCH_NODES)
  })

  it('survives storage being unavailable, in both directions', () => {
    const refuses = (): never => {
      throw new Error('storage denied')
    }
    vi.stubGlobal('localStorage', { getItem: refuses, setItem: refuses, removeItem: refuses })
    expect(loadReviewNodes()).toBe(BATCH_NODES)
    expect(() => saveReviewNodes(800_000)).not.toThrow()
  })

  it('offers only budgets that say what they cost', () => {
    // The note is the reason the knob is honest; a budget without one is a knob
    // whose settings cannot be described (constitution §9, §12).
    for (const budget of ANALYSIS_BUDGETS) expect(budget.note.length).toBeGreaterThan(40)
    expect(ANALYSIS_BUDGETS.some((b) => b.nodes === BATCH_NODES)).toBe(true)
    // The budget the measurement condemns is not on the menu.
    expect(ANALYSIS_BUDGETS.every((b) => b.nodes > 150_000)).toBe(true)
  })
})
