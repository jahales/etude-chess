import { useEffect, useState } from 'react'
import { countAttempts, countGames, listGames, type StoredGame } from '../persist/db'

/**
 * What the Home cards show about your own history. Everything is optional: a
 * first-run user has no data, and the cards must read as an invitation rather
 * than as empty slots (docs/v0.3.0-plan.md §2 — "stats render blank-quietly").
 */
export interface HomeStats {
  gamesPlayed: number
  /** Accuracy of the most recent finished game, or undefined if none. */
  lastAccuracy?: number
  /** Committed guesses across all study sessions. */
  decisions: number
}

const EMPTY: HomeStats = { gamesPlayed: 0, decisions: 0 }

/**
 * How many recent games to scan for the last *graded* accuracy. Ungraded games
 * are rare, so a short scan practically always finds one; if a user somehow
 * abandoned this many games in a row, the stat is simply omitted.
 */
const RECENT_SCAN = 20

/**
 * Reads the local history once on mount. `reloadKey` re-reads it — pass
 * something that changes when you return to Home, so finishing a game is
 * reflected without a refresh.
 */
export function useHomeStats(reloadKey: unknown = 0): HomeStats {
  const [stats, setStats] = useState<HomeStats>(EMPTY)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      // All best-effort: they resolve to empty rather than throwing, so a missing
      // IndexedDB just means the cards show no stats.
      //
      // The count comes from the index and the accuracy from a handful of rows.
      // Loading every game to derive two numbers would deserialize each one's
      // whole coachLog and evalByPly — hundreds of KB, on every visit Home.
      const [gamesPlayed, recent, decisions] = await Promise.all([
        countGames(),
        listGames(RECENT_SCAN),
        countAttempts(),
      ])
      if (cancelled) return
      setStats({ gamesPlayed, lastAccuracy: lastAccuracyOf(recent), decisions })
    })()
    return () => {
      cancelled = true
    }
  }, [reloadKey])

  return stats
}

/**
 * `listGames` is newest-first, but accuracy only means something once the coach
 * has graded a move: a game resigned on move one reports 0%, which reads as
 * "you played terribly" rather than "no data". So skip games we know were never
 * graded. A v0.2 record has no `coachLog` at all — that's unknown, not empty,
 * so it still counts rather than being silently dropped from your history.
 */
export function lastAccuracyOf(games: StoredGame[]): number | undefined {
  return games.find((g) => g.coachLog === undefined || g.coachLog.length > 0)?.accuracy
}
