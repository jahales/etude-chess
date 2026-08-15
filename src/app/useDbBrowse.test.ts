// The browse hook: what it holds that neither the rules nor the store do.
//
// The querying is covered in persist/dbGames.query.test.ts and the rules in
// domain/dbQuery.test.ts, so what is worth pinning here is the state: that a
// filter change goes back to page one, that paging moves a window rather than
// growing one, and that "nothing attached" stays distinguishable from "nothing
// matched" — three empty states rendered as one is the failure this exists to
// prevent (plan §10).
//
// This import must run before ./db is reached: getDb() decides once, at first
// call, whether IndexedDB exists. Vitest hoists imports in source order.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import Dexie from 'dexie'
import { PAGE_SIZE } from '../domain/dbQuery'
import { putDbGames, type DbGame } from '../persist/dbGames'
import { useDbBrowse } from './useDbBrowse'

const game = (over: Partial<DbGame>): DbGame => ({
  key: 'k',
  white: 'Morphy, Paul',
  black: 'Anderssen, Adolf',
  event: 'Paris',
  year: 1858,
  result: '1-0',
  speed: 'classical',
  plies: 30,
  movetext: 'e4 e5',
  source: 'old.pgn',
  importedAt: 1,
  names: ['morphy', 'paul', 'anderssen', 'adolf', 'paris'],
  ...over,
})

beforeEach(async () => {
  const d = new Dexie('etude-chess')
  try {
    await d.open()
    await d.table('dbGames').clear()
  } catch {
    // First run: db.ts hasn't created the database yet.
  } finally {
    d.close()
  }
})

/** Render and wait out the settling delay of the first query. */
async function browse() {
  const { result } = renderHook(() => useDbBrowse())
  await waitFor(() => expect(result.current.rows).not.toBeNull())
  return result
}

describe('useDbBrowse', () => {
  it('reports an empty database as empty rather than as a filter that matched nothing', async () => {
    const result = await browse()
    expect(result.current.stored).toBe(0)
    expect(result.current.rows).toEqual([])
  })

  it('keeps the database total beside the filtered one, so both can be said', async () => {
    await putDbGames([game({ key: 'a' }), game({ key: 'b', white: 'Tal, Mikhail', names: ['tal'] })])
    const result = await browse()

    act(() => result.current.setField('text', 'tal'))
    await waitFor(() => expect(result.current.total?.count).toBe(1))

    expect(result.current.stored).toBe(2)
    expect(result.current.total).toEqual({ count: 1, exact: true })
  })

  it('goes back to the first page when a filter changes', async () => {
    // Page 4 of the old results is not page 4 of the new ones, and landing on an
    // empty page reads as "no matches" when there are plenty.
    await putDbGames(
      Array.from({ length: PAGE_SIZE + 5 }, (_, i) => game({ key: `k${i}`, black: `Opponent ${i}` })),
    )
    const result = await browse()

    act(() => result.current.goToPage(1))
    await waitFor(() => expect(result.current.page).toBe(1))

    act(() => result.current.setField('text', 'morphy'))
    expect(result.current.page).toBe(0)
  })

  it('moves a window rather than accumulating rows', async () => {
    await putDbGames(
      Array.from({ length: PAGE_SIZE + 5 }, (_, i) => game({ key: `k${i}`, black: `Opponent ${i}` })),
    )
    const result = await browse()
    expect(result.current.rows).toHaveLength(PAGE_SIZE)
    expect(result.current.hasMore).toBe(true)

    act(() => result.current.goToPage(1))
    await waitFor(() => expect(result.current.rows).toHaveLength(5))
    expect(result.current.hasMore).toBe(false)
  })

  it('clears back to the whole database', async () => {
    await putDbGames([game({ key: 'a' }), game({ key: 'b', white: 'Tal, Mikhail', names: ['tal'] })])
    const result = await browse()

    act(() => result.current.setField('text', 'nobody'))
    await waitFor(() => expect(result.current.rows).toEqual([]))

    act(() => result.current.clear())
    await waitFor(() => expect(result.current.rows).toHaveLength(2))
    expect(result.current.form).toEqual({})
  })

  it('normalises what was typed without touching what is in the box', async () => {
    // The input keeps the half-typed year; the query simply doesn't have one yet.
    const result = await browse()
    act(() => result.current.setField('yearFrom', 'nineteen'))
    expect(result.current.form.yearFrom).toBe('nineteen')
    expect(result.current.query).toEqual({})
  })
})
