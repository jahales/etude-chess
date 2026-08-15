/**
 * A page of the attached database, ordered for review (#144).
 *
 * The browse machinery is #54's and is reused whole — `useDbBrowse` runs the
 * query, `domain/dbQuery` plans it, `persist/dbGames` walks the index. What this
 * adds is the one fact the index cannot answer, *has this game been analysed at
 * the budget we are working at*, and then hands both to `domain/reviewPlan` to
 * put the games worth opening first.
 *
 * **It orders a page, not the database.** Rows come back through whichever index
 * answered the filter, so a loss on page four stays on page four; sorting the
 * whole set would mean loading the whole set, which is what paging exists to
 * avoid (ADR 0018, plan §10). The screen says so — see `ReviewPicker`.
 */

import { useEffect, useMemo, useState } from 'react'
import type { Color } from '../domain/types'
import { orderForReview } from '../domain/reviewPlan'
import { yourSide } from '../domain/studyGame'
import { getDbAnalysis, type DbGame } from '../persist/dbGames'
import { isAnalysed } from './gameAnalysis'

/** A row with the two things the ordering needed, kept so the table can show them. */
export interface ReviewRow extends DbGame {
  /** The side you played, or `null` when nothing recorded says the game is yours. */
  yours: Color | null
  analysed: boolean
}

export interface ReviewList {
  /** The page, worth-reviewing first. Empty until the first read lands. */
  rows: ReviewRow[]
  /** Keys covered by a completed pass at this budget. */
  analysed: ReadonlySet<string>
  /**
   * False while the analysis states for this page are still being read.
   *
   * The screen waits on it rather than ordering twice: the analysis state is
   * half the sort key, so drawing the list before it arrives and re-drawing
   * after would move rows under the pointer of someone already reaching for one.
   */
  ready: boolean
}

export function useReviewList(
  rows: DbGame[] | null,
  names: readonly string[],
  nodes: number,
): ReviewList {
  const [analysed, setAnalysed] = useState<ReadonlySet<string>>(new Set())
  const [readFor, setReadFor] = useState<DbGame[] | null>(null)

  useEffect(() => {
    if (!rows) return
    let cancelled = false
    void (async () => {
      const states = await Promise.all(
        rows.map(async (game) => {
          // Takes the row, not the key: an analysis filed under a key whose game
          // has since been re-imported from a different starting position is
          // discarded rather than served (`getDbAnalysis`).
          const stored = await getDbAnalysis(game)
          return stored && isAnalysed(stored, nodes) ? game.key : null
        }),
      )
      if (cancelled) return
      setAnalysed(new Set(states.filter((key): key is string => key !== null)))
      // Stamped with the rows it describes, so a page that changed while this
      // was in flight is never drawn against the previous page's answers.
      setReadFor(rows)
    })()
    return () => {
      cancelled = true
    }
  }, [rows, nodes])

  const ready = rows !== null && readFor === rows

  const ordered = useMemo(() => {
    if (!rows || !ready) return []
    return orderForReview(
      rows.map((game) => ({
        ...game,
        yours: yourSide(game, names),
        analysed: analysed.has(game.key),
      })),
    )
  }, [rows, ready, names, analysed])

  return { rows: ordered, analysed, ready }
}
