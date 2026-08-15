/**
 * Browsing the attached database: the state a browse screen needs (#54, §10).
 *
 * The rules are pure (`domain/dbQuery.ts`) and the reading is an adapter
 * (`persist/dbGames.ts`); this owns only what changes over time — what is typed,
 * which page it is on, and what came back.
 *
 * Two things it exists to get right:
 *
 * - **A page at a time, always.** The screen never holds the result set, only
 *   the fifty rows it is drawing. That is not an optimisation: 10k–100k games is
 *   the guidance an import is written to (ADR 0018), and a table that renders
 *   its results is a table that hangs.
 * - **Three empty states, not one.** Nothing attached, an import still running,
 *   and a filter that matched nothing are different situations with different
 *   answers, so `stored` (how many games exist at all) is read alongside the
 *   query rather than inferred from an empty page.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { normalizeQuery, type GameQuery } from '../domain/dbQuery'
import {
  countDbGames,
  countMatchingDbGames,
  queryDbGames,
  type DbGame,
  type DbGameCount,
  type DbGamePage,
} from '../persist/dbGames'

/** What the filter form holds: raw strings, exactly as typed. */
export type BrowseForm = Partial<Record<keyof GameQuery, string>>

/**
 * How long to wait after a keystroke before querying.
 *
 * Every character typed into the player box is otherwise an index walk. 200 ms
 * is below the threshold where a search feels delayed and above the interval
 * between keystrokes.
 */
export const DEBOUNCE_MS = 200

export interface DbBrowse {
  /** The form's raw values. The inputs are controlled by these, not by `query`. */
  form: BrowseForm
  /** The form, normalised — what is actually being asked. */
  query: GameQuery
  setField: (name: keyof GameQuery, value: string) => void
  clear: () => void
  page: number
  goToPage: (page: number) => void
  /** The current page. `null` until the first read finishes. */
  rows: DbGame[] | null
  hasMore: boolean
  /** The index the rows came back through, which is the order they are in. */
  order: DbGamePage['order']
  /** How many games match, and whether that number is exact or a floor. */
  total: DbGameCount | null
  /** Games in the database regardless of the filters. Tells apart the empty states. */
  stored: number | null
  loading: boolean
}

export function useDbBrowse(reload = 0): DbBrowse {
  const [form, setForm] = useState<BrowseForm>({})
  const [page, setPage] = useState(0)
  const [result, setResult] = useState<DbGamePage | null>(null)
  const [total, setTotal] = useState<DbGameCount | null>(null)
  const [stored, setStored] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)

  const query = useMemo(() => normalizeQuery(form), [form])
  // Seeded with the first `query` object so the settling timeout below sets the
  // identical reference on mount and React skips the re-render.
  const [settled, setSettled] = useState<GameQuery>(query)

  useEffect(() => {
    const timer = setTimeout(() => setSettled(query), DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [query])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void Promise.all([
      queryDbGames(settled, page),
      countMatchingDbGames(settled),
      countDbGames(),
    ]).then(([nextPage, nextTotal, nextStored]) => {
      // A slower earlier query must not land on top of a faster later one.
      if (cancelled) return
      setResult(nextPage)
      setTotal(nextTotal)
      setStored(nextStored)
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [settled, page, reload])

  // Changing a filter goes back to the first page: page 4 of the old results is
  // not page 4 of the new ones, and landing on an empty page reads as "no
  // matches" when there are plenty.
  const setField = useCallback((name: keyof GameQuery, value: string) => {
    setForm((f) => ({ ...f, [name]: value }))
    setPage(0)
  }, [])

  const clear = useCallback(() => {
    setForm({})
    setPage(0)
  }, [])

  return {
    form,
    query,
    setField,
    clear,
    page,
    goToPage: setPage,
    rows: result?.rows ?? null,
    hasMore: result?.hasMore ?? false,
    order: result?.order ?? 'none',
    total,
    stored,
    loading,
  }
}
