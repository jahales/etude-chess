// Review mode's composition (#144), at the place the composition can go wrong.
//
// The ordering and the offer rules are `domain/reviewPlan.test.ts`'s and the
// pass is `app/useDbGameAnalysis.test.ts`'s. What only this screen can get wrong
// is what it *says* when the pieces are joined up: that an unanalysed game is
// never offered as a list of critical positions, that a game measured end to end
// with nothing above Tier A says so as a finding rather than as an empty list,
// and that the cost of the pass is on screen before the button is pressed.
//
// The fake-indexeddb import must run before ./persist/db is reached — getDb()
// decides once, at first call, whether IndexedDB exists.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import Dexie from 'dexie'
import type { Analyser } from '../engine/analyser'
import type { Score } from '../domain/types'
import type { AnalyserState } from '../app/useAnalyser'
import type { PositionEval } from '../domain/gameRecord'
import { BATCH_NODES, REFERENCE_NODES } from '../app/gameAnalysis'
import { saveDbAnalysis, type DbGame } from '../persist/dbGames'
import { ReviewGame } from './Review'

/** Ten plies of the Two Knights, so White has five moves to be judged on. */
const MOVETEXT = 'e4 e5 Nf3 Nc6 Bc4 Nf6 Ng5 d5 exd5 Nxd5'

const game = (over: Partial<DbGame> = {}): DbGame => ({
  key: 'test-game',
  white: 'You',
  black: 'Them',
  result: '0-1',
  speed: 'rapid',
  plies: 10,
  movetext: MOVETEXT,
  source: 'mine.pgn',
  importedAt: 0,
  ...over,
})

/**
 * An engine whose answer depends only on how many times it has been asked.
 *
 * The pass evaluates the start position first and then each ply in order, so
 * call `n` is ply `n - 1` — which is what lets a single position be made bad on
 * purpose without replaying anything here.
 */
function scriptedEngine(scoreForCall: (call: number) => Score, ready = true): AnalyserState {
  let call = 0
  const analyser: Analyser = {
    evaluate: async () => ({ score: scoreForCall(call++), bestMove: null }),
    analyseLines: async () => [],
    dispose: () => {},
  }
  return { analyser, ready, error: null }
}

const level = (): Score => ({ type: 'cp', value: 0 })

const props = (over: Partial<Parameters<typeof ReviewGame>[0]> = {}) => ({
  game: game(),
  engine: scriptedEngine(level),
  names: ['You'],
  onChangeNames: () => {},
  nodes: BATCH_NODES,
  onChangeNodes: () => {},
  onStart: () => {},
  ...over,
})

/** A click, with the effects it kicks off flushed before the next assertion. */
const click = async (el: HTMLElement) => {
  await act(async () => {
    el.click()
  })
}

beforeEach(async () => {
  const d = new Dexie('etude-chess')
  try {
    await d.open()
    await d.table('dbAnalysis').clear()
  } catch {
    // First run: db.ts hasn't created the database yet.
  } finally {
    d.close()
  }
})

describe('before the pass has run', () => {
  it('states the cost — how many searches, at what budget — before the button', async () => {
    render(<ReviewGame {...props()} />)
    await screen.findByRole('button', { name: 'Analyse this game' })

    // Eleven positions: ten plies plus the one the game starts from, without
    // which the first move can never be scored.
    expect(screen.getByText(/11 searches/)).toBeInTheDocument()
    expect(screen.getByText(/400k nodes each/)).toBeInTheDocument()
    expect(screen.getByText(/couple of minutes for a full game/)).toBeInTheDocument()
  })

  // The limitation is stated where the decision is made, not discovered in a
  // footnote after the findings are on screen (constitution §9, §12).
  it('says what the pass cannot do before the button that runs it', async () => {
    render(<ReviewGame {...props()} />)
    await screen.findByRole('button', { name: 'Analyse this game' })

    expect(screen.getByText(/What this pass cannot do/)).toBeInTheDocument()
    expect(screen.getByText(/has not been shown to be clean/)).toBeInTheDocument()
  })

  // The failure the issue leads with: a list of "critical positions" chosen out
  // of a game whose actual blunder was never measured.
  it('refuses the critical positions outright, and says why', async () => {
    render(<ReviewGame {...props()} />)
    await screen.findByRole('button', { name: 'Analyse this game' })

    expect(screen.getByText(/analyse the game first/i)).toBeInTheDocument()
    expect(screen.getByText(/leave the rest looking fine/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Re-decide/ })).not.toBeInTheDocument()
  })

  // Grading happens per move as you commit it, so this path needs no pass —
  // and offering it is what keeps the refusal above from being a dead end.
  it('still offers the whole game', async () => {
    render(<ReviewGame {...props()} />)
    expect(await screen.findByRole('button', { name: /Work all \d+ positions/ })).toBeInTheDocument()
  })
})

describe('after a complete pass', () => {
  it('offers exactly the positions that cost more than Tier A', async () => {
    // Call 5 is ply 4 — White's 5.Bc4 in this line. Black is to move in the
    // position it produces, so a large positive score there is a large drop for
    // White across that move.
    const engine = scriptedEngine((call) =>
      call === 5 ? { type: 'cp', value: 900 } : { type: 'cp', value: 0 },
    )
    const onStart = vi.fn()
    render(<ReviewGame {...props({ engine, onStart })} />)

    await click(await screen.findByRole('button', { name: 'Analyse this game' }))
    const start = await screen.findByRole('button', { name: /Re-decide 1 position$/ }, { timeout: 5000 })

    expect(screen.getByText(/Analysed — every position measured at/)).toBeInTheDocument()
    expect(screen.getByText('Bc4')).toBeInTheDocument()
    // The claim the evidence supports, not the one the feature is named after.
    expect(
      screen.getByRole('heading', { name: 'The positions this pass could see' }),
    ).toBeInTheDocument()
    expect(screen.getByText(/list is a floor, not a ceiling/)).toBeInTheDocument()

    await click(start)
    // The session is the ordinary one, narrowed to the ply that was selected —
    // not a second kind of session.
    expect(onStart).toHaveBeenCalledTimes(1)
    expect(onStart.mock.calls[0]![1]).toEqual([4])
  })

  // "Analysed with no findings" and "not analysed" both render as no list, and
  // neither of them is "you played clean" at a budget a browser can afford —
  // 800k, twice the default here, already loses a real Tier B move on this
  // project's reference game (#132, constitution §9, §12).
  it('reports the coverage without ever calling a browser-budget game clean', async () => {
    render(<ReviewGame {...props()} />)
    await click(await screen.findByRole('button', { name: 'Analyse this game' }))

    await waitFor(() =>
      expect(screen.getByText(/of your moves were measured at/)).toBeInTheDocument(),
    )
    expect(screen.getByText(/not the same as a clean game/)).toBeInTheDocument()
    expect(screen.getByText(/nothing obvious/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Re-decide/ })).not.toBeInTheDocument()
  })

  it('says the same at the deepest budget the browser offers', async () => {
    render(<ReviewGame {...props({ nodes: 800_000 })} />)
    await click(await screen.findByRole('button', { name: 'Analyse this game' }))

    await waitFor(() =>
      expect(screen.getByText(/of your moves were measured at/)).toBeInTheDocument(),
    )
    expect(screen.getByText(/not the same as a clean game/)).toBeInTheDocument()
  })
})

/**
 * The seam an off-app deep pass arrives through (filed as its own issue).
 *
 * Nothing here builds the import. What is pinned is that the seam exists and
 * behaves: a stored complete pass at a deeper budget is used as it stands, no
 * WASM search runs over the top of it, and the hedging that browser budgets earn
 * comes off — because at that depth an absence does mean something.
 */
describe('an analysis deeper than this tab could run', () => {
  const ev = (whitePct: number): PositionEval => ({ whitePct, label: `${whitePct}` })

  const seedDeepPass = () =>
    saveDbAnalysis({
      key: 'test-game',
      // Level until White's 5.Bc4 (ply 4), which drops 45 points — one Tier C.
      evalByPly: [50, 50, 50, 50, 5, 5, 5, 5, 5, 5].map(ev),
      startEval: ev(50),
      analysedAt: 1,
      analysisNodes: REFERENCE_NODES,
    })

  it('is used as it stands, with no search of its own', async () => {
    await seedDeepPass()
    let searches = 0
    const engine = scriptedEngine(() => {
      searches++
      return { type: 'cp', value: 0 }
    })

    render(<ReviewGame {...props({ engine })} />)
    await screen.findByRole('button', { name: /Re-decide 1 position$/ })

    expect(searches).toBe(0)
    expect(screen.getByText(/deeper pass than this tab would have run/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Analyse this game' })).not.toBeInTheDocument()
  })

  it('drops the hedge, because at that depth an absence means something', async () => {
    await seedDeepPass()
    render(<ReviewGame {...props()} />)

    expect(
      await screen.findByRole('heading', { name: 'The positions that decided it' }),
    ).toBeInTheDocument()
    expect(screen.queryByText(/list is a floor, not a ceiling/)).not.toBeInTheDocument()
  })
})

describe('whose side', () => {
  it('reviews your side of a game you lost, without being asked which', async () => {
    render(<ReviewGame {...props({ game: game({ white: 'You', result: '0-1' }) })} />)
    expect(await screen.findByText(/so that is the side being reviewed/)).toHaveTextContent(
      'You played White here',
    )
  })

  it('asks which side on a game it cannot tell is yours', async () => {
    render(<ReviewGame {...props({ names: [], game: game({ result: '1/2-1/2' }) })} />)
    expect(await screen.findByText(/Nothing on this game says which side was yours/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'White' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Black' })).toBeInTheDocument()
  })
})
