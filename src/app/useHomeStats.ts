import { useEffect, useState } from 'react'
import { countAttempts, listGames, type StoredGame } from '../persist/db'

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
 * Reads the local history once on mount. `reloadKey` re-reads it — pass
 * something that changes when you return to Home, so finishing a game is
 * reflected without a refresh.
 */
export function useHomeStats(reloadKey: unknown = 0): HomeStats {
  const [stats, setStats] = useState<HomeStats>(EMPTY)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      // Both are best-effort and resolve to empty rather than throwing, so a
      // missing IndexedDB just means the cards show no stats.
      const [games, decisions] = await Promise.all([listGames(500), countAttempts()])
      if (cancelled) return
      setStats({
        gamesPlayed: games.length,
        lastAccuracy: lastAccuracyOf(games),
        decisions,
      })
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
