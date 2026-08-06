// Audit a generated book against things that must be true of any real chess
// database (issue #88).
//
// Every defect found while building this generator produced a *plausible* book
// rather than an error — 3% of the games looks exactly like 100% of them — and
// none were caught by unit tests, because the logic was fine and the data was
// not. This is the check that would have caught them.
//
//   node scripts/repertoire/verifyBook.mjs out/band.json
//
// Exits non-zero if anything is an error, so it can gate a pipeline.

import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { Chess } from 'chess.js'
import { auditBook, firstMoveShares, recordedVsClaimed } from '../../src/domain/bookQuality.ts'

/**
 * Known totals for Lichess monthly dumps, used as ground truth.
 *
 * This is the check that caught the silent zstd truncation: the scan reported
 * 44,009 games for 2013-01 and looked entirely healthy, against a documented
 * 121,332. Without a number to compare against, a truncated scan is invisible.
 */
export const KNOWN_MONTH_TOTALS = {
  '2013-01': 121332,
}

/**
 * Replay a sample of the book's own move keys to confirm they are legal in the
 * position they are filed under. Catches key corruption and any drift between
 * how the book was written and how it is read back.
 */
function checkLegality(positions, sampleSize = 400) {
  const keys = Object.keys(positions)
  const step = Math.max(1, Math.floor(keys.length / sampleSize))
  const bad = []
  let checked = 0

  for (let i = 0; i < keys.length; i += step) {
    const key = keys[i]
    // The book stores four FEN fields; chess.js wants six.
    let chess
    try {
      chess = new Chess(`${key} 0 1`)
    } catch {
      bad.push({ key, san: '(position)', why: 'not a legal position' })
      continue
    }
    for (const san of Object.keys(positions[key])) {
      checked++
      try {
        if (!chess.move(san)) bad.push({ key, san, why: 'rejected' })
        else chess.undo()
      } catch {
        bad.push({ key, san, why: 'illegal here' })
      }
    }
  }
  return { checked, bad }
}

async function main() {
  const path = process.argv[2]
  if (!path) {
    console.log('usage: node scripts/repertoire/verifyBook.mjs <book.json>')
    process.exit(1)
  }

  const book = JSON.parse(await readFile(path, 'utf8'))
  const positions = book.positions ?? {}
  const meta = book.meta ?? {}
  const issues = auditBook(positions)

  console.log(`\n${path}`)
  console.log(`  ${Object.keys(positions).length} positions · ${meta.gamesUsed ?? '?'} games used`)
  console.log(`  ratings ${(meta.ratings ?? []).join('–')} · ${(meta.speeds ?? []).join(',')}`)

  const shares = firstMoveShares(positions)
  const top = Object.entries(shares)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([san, s]) => `${san} ${(s * 100).toFixed(1)}%`)
  if (top.length) console.log(`  first moves: ${top.join(' · ')}`)

  const rvc = recordedVsClaimed(positions, meta.gamesUsed ?? 0)
  if (rvc.claimed > 0) {
    console.log(
      `  recorded at start position: ${rvc.recorded} of ${rvc.claimed} used (${(rvc.ratio * 100).toFixed(1)}%)`,
    )
    if (rvc.ratio < 0.95) {
      issues.push({
        severity: 'error',
        check: 'games-recorded',
        detail: `only ${(rvc.ratio * 100).toFixed(1)}% of used games reached the start position — games are being dropped`,
      })
    }
  }

  // Ground truth, where we have it.
  const month = String(meta.source ?? '').match(/rated_(\d{4}-\d{2})\./)?.[1]
  const knownTotal = month ? KNOWN_MONTH_TOTALS[month] : undefined
  if (knownTotal && meta.gamesScanned) {
    const complete = meta.gamesScanned >= knownTotal
    console.log(
      `  scanned ${meta.gamesScanned} of ${knownTotal} known for ${month}` +
        (complete ? ' ✓' : ' — partial (expected if --max-games was reached)'),
    )
    // A partial scan is only suspicious if we did *not* ask it to stop. Books
    // built before `stoppedAtLimit` was recorded fall back to comparing games
    // used against the limit, and skip the check entirely if neither is known —
    // a check that fires on every capped build trains you to ignore it.
    const askedToStop =
      meta.stoppedAtLimit === true ||
      (typeof meta.maxGames === 'number' && meta.gamesUsed >= meta.maxGames)
    const canTell = meta.stoppedAtLimit !== undefined || typeof meta.maxGames === 'number'
    if (!complete && canTell && !askedToStop) {
      issues.push({
        severity: 'error',
        check: 'complete-scan',
        detail: `scan stopped at ${meta.gamesScanned} of ${knownTotal} without reaching --max-games — silent truncation`,
      })
    }
  }

  const legality = checkLegality(positions)
  console.log(`  legality: ${legality.checked} sampled move(s), ${legality.bad.length} illegal`)
  if (legality.bad.length) {
    issues.push({
      severity: 'error',
      check: 'legal-moves',
      detail: `${legality.bad.length} key(s) are not legal where filed, e.g. ${legality.bad
        .slice(0, 3)
        .map((b) => `${b.san} (${b.why})`)
        .join(', ')}`,
    })
  }

  console.log('')
  if (issues.length === 0) {
    console.log('✓ no issues')
    return
  }
  for (const i of issues) {
    console.log(`${i.severity === 'error' ? '✖' : '⚠'} ${i.check}: ${i.detail}`)
  }
  if (issues.some((i) => i.severity === 'error')) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
