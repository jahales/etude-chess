// Reading a player's public chess.com archive.
//
// Extracted from scripts/review/game.mjs when scripts/coach/archive.mjs needed
// the same thing (#137). Two copies of an archive scan is two places for the
// "no public endpoint takes a game id" workaround to drift, and the second copy
// is always the one that forgets the User-Agent chess.com asks for.
//
// The owner's handle is never written down in this repo — it is theirs to
// publish. Callers pass it in from --me or $CHESSCOM_USER.

export const USER_AGENT = 'etude-chess game review (https://github.com/jahales/etude-chess)'

export async function json(url) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`)
  return res.json()
}

/** The bare game id out of a chess.com URL, or the argument if it is already one. */
export function gameId(value) {
  const m = /(\d{6,})/.exec(value ?? '')
  return m ? m[1] : null
}

/**
 * The player's monthly archive URLs, **newest month first**.
 *
 * chess.com returns them oldest first; every caller here wants the other order,
 * because the game you just played and the chess you play now are both at that
 * end.
 */
export async function archiveMonths(user) {
  const { archives } = await json(`https://api.chess.com/pub/player/${user}/games/archives`)
  return [...archives].reverse()
}

/**
 * Find a game in the player's public archives, newest month first. There is no
 * public endpoint that takes a game id, so this is a scan — it stops at the
 * first hit, which for a game you just played is the first request.
 */
export async function fetchGame({ user, id, last }) {
  for (const month of await archiveMonths(user)) {
    const { games } = await json(month)
    if (last) {
      if (games.length) return games[games.length - 1]
      continue
    }
    const hit = games.find((g) => gameId(g.url) === id)
    if (hit) return hit
  }
  return null
}

/**
 * Every game in the archive, newest first, one month's request at a time.
 *
 * A generator rather than an array because the archive is the whole account and
 * the caller (scripts/coach/archive.mjs) spends minutes of engine time per game:
 * it should start on the first game rather than after the last HTTP request, and
 * a `--limit` run should make one request, not twenty.
 *
 * `timeClasses` is **required and never defaulted to "everything"**. Pooling
 * blitz with rapid describes a player who is the average of two people, and the
 * owner's archive is 5:1 blitz — see the coach skill's rule 1. An empty set here
 * would be the pooling bug wearing a default value.
 *
 * @param {object} opts
 * @param {string} opts.user
 * @param {ReadonlySet<string>|readonly string[]} opts.timeClasses  e.g. ['rapid','daily']
 * @param {string} [opts.since]  earliest month to read, `YYYY/MM`
 */
export async function* eachGame({ user, timeClasses, since }) {
  const wanted = new Set(timeClasses)
  if (!wanted.size) throw new Error('eachGame needs at least one time class — see the coach skill, rule 1')
  for (const month of await archiveMonths(user)) {
    // Months are `.../games/2026/07`, so a string compare on the tail is a date
    // compare. Cheap, and it skips the request entirely rather than the games.
    if (since && monthKey(month) < since) continue
    const { games } = await json(month)
    for (const game of [...games].reverse()) {
      if (wanted.has(game.time_class)) yield game
    }
  }
}

/** `YYYY/MM` out of an archive URL, for comparing months. */
export function monthKey(url) {
  return /(\d{4}\/\d{2})\/?$/.exec(url)?.[1] ?? ''
}
