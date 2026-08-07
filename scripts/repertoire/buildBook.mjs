// Build a local opening book from the Lichess monthly database dumps.
//
// Why this exists rather than just calling the explorer API: the book is
// **reproducible** (a fixed month, not a moving window), has no rate limit, can
// be filtered to any rating band and time control we like, and works offline.
// The explorer is a fine source but it is a moving target and a dependency.
//
// Streams `https://database.lichess.org/standard/*.pgn.zst` and decompresses on
// the fly with Node's native zstd, so a 27 GB month can be sampled without ever
// storing it — we abort the download once `--max-games` is reached.
//
// Output has the same shape the explorer returns, so localBook.mjs is a
// drop-in replacement for explorer.mjs in the crawler.

import { spawn, spawnSync } from 'node:child_process'
import {
  createReadStream,
  createWriteStream,
  existsSync,
  readFileSync,
  statSync,
  truncateSync,
  writeFileSync,
} from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { Readable } from 'node:stream'
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'
import { Chess } from 'chess.js'
import { fenKey } from '../../src/domain/repertoirePgn.ts'
import { sniffAndDecompress } from './decompress.mjs'

const DUMP = (month) =>
  `https://database.lichess.org/standard/lichess_db_standard_rated_${month}.pgn.zst`

const SPEED_RE = /\b(ultrabullet|bullet|blitz|rapid|classical)\b/i
const WANTED_HEADERS = new Set(['Event', 'Result', 'WhiteElo', 'BlackElo', 'Variant'])

/**
 * Cap on the memoised transition table. The distribution is heavily Zipfian —
 * a few opening positions account for most transitions — so a cap this size
 * captures nearly every hit while bounding memory at a few hundred MB.
 */
const MAX_TRANSITIONS = 1_500_000

/**
 * Turn the byte source into a stream readline can consume.
 *
 * The no-op error listener is load-bearing. When we stop at `--max-games` the
 * pipeline is torn down mid-flight and emits ERR_STREAM_PREMATURE_CLOSE
 * *asynchronously*, after the consumer has already stopped iterating — so it
 * reaches no try/catch and crashes the process as an unhandled 'error' event.
 * With a listener attached it stays a normal stream error: still delivered to
 * whoever is iterating, no longer fatal to whoever is not.
 */
function decompressedStream(source, opts) {
  // highWaterMark is in *objects* here, and our objects are whole 32 MiB
  // decompressed chunks — the default of 16 lets the stream sit on a large
  // backlog of them while readline works through the first. Two is plenty to
  // keep the consumer fed.
  const stream = Readable.from(sniffAndDecompress(source, opts), { highWaterMark: 2 })
  stream.on('error', () => {})
  return stream
}

/**
 * The dump bytes we actually read, kept on disk so we only ever download them
 * once.
 *
 * We consume a *prefix* of the month — `--max-games` decides how much — so the
 * cache is bounded by what we asked for, not by the 27 GB the file weighs.
 * Rebuilding a book with different thresholds, or a second band for
 * replication, then costs no network at all. If a later run needs more than the
 * cache holds, it resumes from the network at exactly the cached length and
 * appends, so the cache only ever grows toward what we have genuinely read.
 *
 * **Only bytes that have provably decoded are trusted.** A killed build leaves a
 * partial write, and zstd does not report a torn frame — it returns whatever it
 * managed to decode and calls that success. So a naive byte cache silently
 * poisons every subsequent run: that is exactly what wedged the 2026-05 build,
 * repeatedly, always at the same offset.
 *
 * The sidecar records `validBytes`: bytes the decoder has consumed, held a
 * safety margin behind the feed position mid-stream and marked in full once the
 * stream ends cleanly (see SAFETY_MARGIN in decompress.mjs). On startup we
 * truncate back to that mark, discarding any untrusted tail, and re-fetch from
 * there — so a killed build costs at most the margin, never a wedged cache.
 */
export function readValidBytes(metaPath) {
  try {
    const { validBytes } = JSON.parse(readFileSync(metaPath, 'utf8'))
    return Number.isInteger(validBytes) && validBytes >= 0 ? validBytes : 0
  } catch {
    return 0
  }
}

export async function* cachedDump(url, cachePath) {
  const metaPath = `${cachePath}.meta`
  await mkdir(dirname(cachePath), { recursive: true })

  let trusted = 0
  if (existsSync(cachePath)) {
    const onDisk = statSync(cachePath).size
    trusted = Math.min(readValidBytes(metaPath), onDisk)
    if (onDisk > trusted) {
      // Everything past the last verified frame is of unknown provenance.
      truncateSync(cachePath, trusted)
      process.stderr.write(
        `  (discarded ${((onDisk - trusted) / 1e6).toFixed(0)} MB of unverified cache tail)\n`,
      )
    }
    if (trusted > 0) {
      for await (const chunk of createReadStream(cachePath, { end: trusted - 1 })) yield chunk
      process.stderr.write(`  (${(trusted / 1e6).toFixed(0)} MB from verified cache)\n`)
    }
  }

  const sink = createWriteStream(cachePath, { flags: 'a' })
  try {
    for await (const chunk of resumableFetch(url, { startOffset: trusted })) {
      sink.write(chunk)
      yield chunk
    }
  } finally {
    // Wait for the flush. `end()` alone returns before the data reaches disk,
    // so a run finishing (or being killed) straight afterwards loses whatever
    // was still buffered — the next run then re-downloads bytes we already had
    // and paid for. The cache stays *correct* either way, because startup takes
    // min(validBytes, file size), but it silently stops being a cache.
    await new Promise((resolve) => sink.end(resolve))
  }
}

const SEVENZIP_CANDIDATES = [
  process.env.SEVENZIP_PATH,
  'C:/Program Files/7-Zip/7z.exe',
  'C:/Program Files (x86)/7-Zip/7z.exe',
  '7z',
].filter(Boolean)

function sevenZip() {
  const exe = SEVENZIP_CANDIDATES.find((p) => p === '7z' || existsSync(p))
  if (!exe) {
    throw new Error(
      `7-Zip was not found. Install it, set SEVENZIP_PATH, or extract the archive ` +
        `and pass the .pgn directly.`,
    )
  }
  return exe
}

/**
 * Byte source for a local file. `.7z` is streamed through 7-Zip rather than
 * extracted first: Lumbra's Gigabase ships ~1 GB archives that expand to
 * gigabytes, and there is no reason to put that on disk when we read it once,
 * sequentially, and usually stop early.
 *
 * The archive is listed first so we can extract *the PGN member* rather than
 * whatever 7-Zip happens to emit. Lumbra publishes both a PGN build and a Scid
 * build, and the Scid one (`.si5`/`.sg5`/`.sn5`) is binary — streaming that
 * through a PGN parser yields "scanned 0 games" with no indication why.
 */
function fileSource(path) {
  if (!/\.7z$/i.test(path)) {
    const stream = createReadStream(path)
    return { stream, close: () => stream.destroy() }
  }
  const exe = sevenZip()

  const listing = spawnSync(exe, ['l', '-ba', '-slt', path], { encoding: 'utf8', maxBuffer: 1 << 24 })
  const members = [...String(listing.stdout ?? '').matchAll(/^Path = (.+)$/gm)].map((m) => m[1].trim())
  const pgn = members.find((f) => /\.pgn$/i.test(f))
  if (!pgn) {
    const scid = members.filter((f) => /\.s[ing][45]$/i.test(f))
    throw new Error(
      scid.length
        ? `${path} is a Scid database (${scid.map((f) => f.replace(/^.*[\\/]/, '')).join(', ')}), not PGN.\n` +
          `  Scid's move encoding is a stateful per-piece scheme — reading it means reimplementing\n` +
          `  Scid's own decoder. Download the PGN build of this database instead, or convert it\n` +
          `  with Scid vs. PC ("scidt -x"), then pass the .pgn to --file.`
        : `${path} contains no .pgn member. Found: ${members.join(', ') || '(nothing)'}`,
    )
  }

  // `x -so <member>` writes just that file to stdout, so we never materialise it.
  const proc = spawn(exe, ['x', '-so', path, pgn], { stdio: ['ignore', 'pipe', 'ignore'] })
  proc.on('error', (e) => proc.stdout.destroy(e))
  // Same reason as decompressedStream: killing 7-Zip mid-write raises EPIPE on
  // this pipe after we have stopped reading it.
  proc.stdout.on('error', () => {})
  return {
    stream: proc.stdout,
    // Stopping early is the normal case — we read a prefix of a multi-GB
    // archive. Kill 7-Zip rather than leaving it writing into a closed pipe.
    close: () => {
      proc.kill()
      proc.stdout.destroy()
    },
  }
}

/**
 * Byte stream for a URL that survives a dropped connection by resuming with a
 * Range request. Sampling a recent month means pulling ~1 GB over several
 * minutes, and that reliably hits ECONNRESET eventually — without this the
 * whole build is lost, usually near the end. `database.lichess.org` answers
 * Range requests with 206, which is what makes this possible.
 */
export async function* resumableFetch(url, { retries = 8, startOffset = 0, stallMs = 60_000 } = {}) {
  let offset = startOffset
  let attempt = 0
  let reader = null
  let watchdog = null
  try {
    for (;;) {
      try {
        // A dropped connection raises an error and we resume. A connection that
        // simply *stops delivering* without closing raises nothing at all, and
        // fetch has no timeout — so the read below waits forever. That is not
        // hypothetical: it hung a build for five hours with the byte count
        // frozen. The watchdog turns silence into an error so the existing
        // resume path can do its job.
        const controller = new AbortController()
        let lastByteAt = Date.now()
        watchdog = setInterval(() => {
          if (Date.now() - lastByteAt > stallMs) {
            controller.abort(new Error(`no data for ${Math.round(stallMs / 1000)}s`))
          }
        }, 5_000)

        const res = await fetch(url, {
          signal: controller.signal,
          ...(offset ? { headers: { Range: `bytes=${offset}-` } } : {}),
        })
        // 416 means the range starts past the end: we already hold the whole
        // file. That happens on every run once a cache has completed, so
        // treating it as an error makes a finished cache permanently fatal.
        if (res.status === 416) return
        if (offset === 0 ? !res.ok : res.status !== 206) {
          throw new Error(`HTTP ${res.status} fetching ${url}`)
        }
        reader = res.body.getReader()
        for (;;) {
          const { value, done } = await reader.read()
          if (done) return
          lastByteAt = Date.now()
          offset += value.length
          attempt = 0 // any progress refreshes the retry budget
          yield Buffer.from(value)
        }
      } catch (err) {
        clearInterval(watchdog)
        watchdog = null
        try {
          await reader?.cancel()
        } catch {
          // already torn down
        }
        reader = null
        if (++attempt > retries) {
          throw new Error(`download failed after ${offset} bytes`, { cause: err })
        }
        process.stderr.write(
          `\n  … connection lost at ${(offset / 1e6).toFixed(0)} MB — resuming (attempt ${attempt})\n`,
        )
        await new Promise((r) => setTimeout(r, 1000 * attempt))
      }
    }
  } finally {
    clearInterval(watchdog)
    try {
      await reader?.cancel()
    } catch {
      // consumer stopped early; nothing to clean up
    }
  }
}

/**
 * Stream games out of a zstd-compressed PGN. Yields `{headers, movetext}`.
 * @param {NodeJS.ReadableStream} input raw (still compressed) byte stream
 */
async function* streamGames(input, opts) {
  const rl = createInterface({ input: decompressedStream(input, opts), crlfDelay: Infinity })
  // readline re-emits its input's errors on the Interface itself. When we stop
  // early the input is torn down mid-write, and with nothing listening *here*
  // that becomes an unhandled 'error' event and kills the process — after the
  // book is already complete. Anyone still iterating gets the error regardless.
  rl.on('error', () => {})
  let headers = {}
  let sawHeaders = false

  for await (const line of rl) {
    if (line.charCodeAt(0) === 0x5b /* [ */) {
      // Only the five headers we filter on. Regexing all ~14 of them across
      // millions of games is the single biggest cost in this loop, and twelve
      // of them get discarded.
      const sp = line.indexOf(' ')
      if (sp > 0) {
        const key = line.slice(1, sp)
        if (WANTED_HEADERS.has(key)) headers[key] = line.slice(sp + 2, line.length - 2)
      }
      sawHeaders = true
      continue
    }
    if (!line.trim()) continue
    if (sawHeaders) {
      yield { headers, movetext: line }
      headers = {}
      sawHeaders = false
    }
  }
}

/** Strip clock/eval comments, NAGs, move numbers and the result token. */
function tokenise(movetext) {
  return movetext
    .replace(/\{[^}]*\}/g, ' ')
    .replace(/\$\d+/g, ' ')
    .replace(/\d+\.(\.\.)?/g, ' ')
    .replace(/\b(1-0|0-1|1\/2-1\/2|\*)\s*$/, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
}

/**
 * Moves for the first `maxPly` plies only.
 *
 * A Lichess game averages several KB of movetext once clock and eval comments
 * are counted, and we keep the first twelve plies of it — so regexing the whole
 * string is most of the scan's CPU spent on data we discard. Tokenise a prefix
 * long enough to hold `maxPly` plies, and fall back to the full string on the
 * rare game whose comments are fat enough that the prefix came up short. The
 * fallback is what keeps this an optimisation rather than silent truncation.
 */
function sans(movetext, maxPly) {
  const budget = maxPly * 80 + 200
  if (movetext.length <= budget) return tokenise(movetext)

  // Cut back to before any unterminated comment. `{[^}]*}` needs a closing
  // brace, so a prefix ending inside `{ [%clk 0:03:00] }` leaves the fragment
  // behind and its pieces (`[%clk`, `0:03:0`) become tokens — which then count
  // toward the `>= maxPly` guard below, so a game with fat annotations can pass
  // the guard on junk and have its replay break early on an illegal SAN.
  let slice = movetext.slice(0, budget)
  const lastOpen = slice.lastIndexOf('{')
  if (lastOpen > slice.lastIndexOf('}')) slice = slice.slice(0, lastOpen)

  const head = tokenise(slice)
  return head.length >= maxPly ? head : tokenise(movetext)
}

function outcomeIndex(result) {
  if (result === '1-0') return 0
  if (result === '1/2-1/2') return 1
  if (result === '0-1') return 2
  return -1
}

export async function buildBook(opts) {
  const {
    month,
    file,
    out,
    minRating = 1600,
    maxRating = 2000,
    speeds = ['blitz', 'rapid', 'classical'],
    maxPly = 16,
    maxGames = 200_000,
    minGames = 5,
    cache = null,
    onProgress,
  } = opts

  /** @type {Map<string, Map<string, [number,number,number]>>} fenKey → san → [w,d,b] */
  const book = new Map()
  const speedSet = new Set(speeds.map((s) => s.toLowerCase()))

  let aborted = false

  // Advance the cache's verified mark as frames land. Written on a throttle —
  // it only ever needs to be roughly current, and losing the last few frames of
  // credit just means re-fetching them.
  const metaPath = month && cache ? join(cache, `${month}.pgn.zst.part.meta`) : null
  let verified = 0
  let lastMarked = 0
  const markCache = () => {
    if (!metaPath || verified === lastMarked) return
    lastMarked = verified
    try {
      writeFileSync(metaPath, JSON.stringify({ validBytes: verified }))
    } catch {
      // a cache we cannot mark is a slow cache, not a broken one
    }
  }
  const onConsumed = metaPath
    ? (bytes) => {
        verified = bytes
        // Throttled by bytes, but small enough to fire on a small month too —
        // at 32 MB the whole 17 MB 2013-01 dump finished without ever marking,
        // so its cache was never trusted and every run re-downloaded it.
        if (bytes - lastMarked >= 8 << 20) markCache()
      }
    : undefined

  const { stream: source, close } = file
    ? fileSource(file)
    : (() => {
        const bytes = cache
          ? cachedDump(DUMP(month), join(cache, `${month}.pgn.zst.part`))
          : resumableFetch(DUMP(month))
        const stream = Readable.from(bytes)
        return { stream, close: () => stream.destroy() }
      })()
  let seen = 0
  let kept = 0
  // Memoised position transitions: `${fenKey}|${rawToken}` → {san, nextKey}.
  //
  // Profiling put 86.6% of the scan in chess.js, and 27.5% in legal-move
  // generation alone: resolving one SAN makes chess.js generate every legal
  // move and make/undo each to test it, at ~91µs a call, and we did that
  // 12 times per game. But 300k games only reach on the order of half a million
  // distinct positions, so the same transitions were being re-derived millions
  // of times. A hit here costs ~0.13µs; a miss costs ~104µs, and the hit rate
  // climbs with corpus size — the bigger the build, the more this pays.
  //
  // Sound because a position's legal moves are fully determined by the four
  // fields fenKey keeps (placement, side, castling, en passant). The halfmove
  // and fullmove counters we discard cannot change which moves are legal, only
  // the fifty-move rule, which does not arise inside twelve plies.
  const transitions = new Map()
  const scratch = new Chess()
  const startKey = fenKey(scratch.fen())

  try {
    for await (const { headers, movetext } of streamGames(source, { onConsumed })) {
      seen++
      if (kept >= maxGames) {
        aborted = true
        break
      }

      const outcome = outcomeIndex(headers.Result)
      if (outcome < 0) continue
      if (headers.Variant && headers.Variant !== 'Standard') continue

      // Exclude *known-wrong* speeds rather than requiring a known-right one.
      // Lichess dumps always name the speed in Event; an OTB or engine PGN
      // never does, and those games should not all be silently dropped.
      const speed = (headers.Event || '').match(SPEED_RE)?.[1]?.toLowerCase()
      if (speed && !speedSet.has(speed)) continue

      const we = Number(headers.WhiteElo)
      const be = Number(headers.BlackElo)
      if (!we || !be) continue
      if (we < minRating || we > maxRating || be < minRating || be > maxRating) continue

      const moves = sans(movetext, maxPly)
      if (moves.length < 4) continue

      let key = startKey
      for (let i = 0; i < Math.min(maxPly, moves.length); i++) {
        const token = moves[i]
        const memo = `${key}|${token}`
        let step = transitions.get(memo)

        if (step === undefined) {
          // Cache miss: do the expensive thing once. Note we record chess.js's
          // *canonical* SAN, not the raw token — PGN in the wild carries suffix
          // annotations (`Bf5?!`) and over-disambiguated forms, and keying on
          // raw text silently splits one move's statistics across entries. That
          // bites hardest where it matters most: `?`/`??` land on bad-but-
          // popular moves, so the split strands part of every trap's record in
          // a rare entry that pruning then deletes.
          try {
            scratch.load(`${key} 0 1`)
            const move = scratch.move(token)
            if (!move) break
            step = { san: move.san, next: fenKey(scratch.fen()) }
          } catch {
            break // malformed movetext — abandon this game, keep the book
          }
          if (transitions.size < MAX_TRANSITIONS) transitions.set(memo, step)
        }

        let node = book.get(key)
        if (!node) book.set(key, (node = new Map()))
        let tally = node.get(step.san)
        if (!tally) node.set(step.san, (tally = [0, 0, 0]))
        tally[outcome]++
        key = step.next
      }

      kept++
      if (kept % 25_000 === 0) {
  onProgress?.({
          seen,
          kept,
          positions: book.size,
          transitions: transitions.size,
          heapMb: Math.round(process.memoryUsage().heapUsed / 1048576),
        })
      }
    }
  } catch (err) {
    // Stopping at --max-games means tearing down a pipeline that is still
    // producing: 7-Zip mid-write, a socket mid-body. The resulting
    // ERR_STREAM_PREMATURE_CLOSE is the abort working, not a failure — but only
    // when we are the ones who asked for it.
    if (!aborted) throw err
  } finally {
    close()
    // Whatever happened, credit every frame that did decode.
    markCache()
  }

  // Prune the long tail: a move seen twice carries no usable win rate, and the
  // tail is the overwhelming majority of the positions by count.
  let pruned = 0
  for (const [key, node] of book) {
    for (const [san, t] of node) {
      if (t[0] + t[1] + t[2] < minGames) {
        node.delete(san)
        pruned++
      }
    }
    if (node.size === 0) book.delete(key)
  }

  const serialised = {
    meta: {
      source: file ?? DUMP(month),
      ratings: [minRating, maxRating],
      speeds,
      maxPly,
      gamesScanned: seen,
      // Recorded so verifyBook can tell a scan that stopped because we asked it
      // to from one that stopped on its own — without this it cannot, and
      // reports every capped build as a silent truncation.
      maxGames,
      stoppedAtLimit: aborted,
      gamesUsed: kept,
      positions: book.size,
      minGames,
    },
    positions: Object.fromEntries([...book].map(([k, v]) => [k, Object.fromEntries(v)])),
  }

  if (out) {
    await mkdir(dirname(out), { recursive: true })
    await writeFile(out, JSON.stringify(serialised), 'utf8')
  }
  return { book, meta: serialised.meta, pruned }
}

// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue
    const key = argv[i].slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) out[key] = true
    else {
      out[key] = next
      i++
    }
  }
  return out
}

const HELP = `
Build a local opening book from the Lichess database dumps (issue #88).

  node scripts/repertoire/buildBook.mjs --month 2024-01 --out out/book.json \\
       --ratings 1600-2000 --speeds blitz,rapid --max-games 400000

  --month     2024-01           which monthly dump to stream       (required unless --file)
  --file      games.pgn         a local file instead: .pgn, .pgn.gz or .pgn.zst
                                (format is sniffed, not taken from the name).
                                This is the route for a PGN exported from En
                                Croissant, ChessBase or SCID — set --ratings to
                                match that database's strength.
  --out       out/book.json     where to write                     (required)
  --ratings   1600-2000         both players must fall in this band
  --speeds    blitz,rapid       time controls to include
  --max-ply   16                plies recorded per game
  --max-games 200000            stop (and abort the download) after this many
  --min-games 5                 drop moves seen fewer times than this
  --cache     db/cache          keep downloaded dump bytes here and reuse them
                                next run (only what --max-games actually reads)
  --no-cache                    stream without keeping anything on disk

Dumps grow fast: 2013-01 is 17 MB, 2016-01 is 831 MB, a 2026 month is ~27 GB.
Streaming means --max-games decides the real cost, not the file size.
`

async function main() {
  const a = parseArgs(process.argv.slice(2))
  if (a.help || !a.out || (!a.month && !a.file)) {
    console.log(HELP)
    process.exit(a.help ? 0 : 1)
  }
  const [minRating, maxRating] = String(a.ratings ?? '1600-2000').split('-').map(Number)
  const started = Date.now()

  const { meta, pruned } = await buildBook({
    month: a.month ? String(a.month) : undefined,
    file: a.file ? String(a.file) : undefined,
    out: String(a.out),
    minRating,
    maxRating,
    speeds: a.speeds ? String(a.speeds).split(',') : undefined,
    maxPly: a['max-ply'] ? Number(a['max-ply']) : undefined,
    maxGames: a['max-games'] ? Number(a['max-games']) : undefined,
    minGames: a['min-games'] ? Number(a['min-games']) : undefined,
    cache: a['no-cache'] ? null : String(a.cache ?? 'db/cache'),
    onProgress: ({ seen, kept, positions, transitions, heapMb }) =>
      process.stdout.write(
        `\r  scanned ${seen} · kept ${kept} · positions ${positions} · transitions ${transitions} · heap ${heapMb} MB   `,
      ),
  })

  console.log(
    `\n\nbook written to ${a.out}` +
      `\n  scanned ${meta.gamesScanned} games, used ${meta.gamesUsed}` +
      ` (${((100 * meta.gamesUsed) / Math.max(1, meta.gamesScanned)).toFixed(1)}% in band)` +
      `\n  ${meta.positions} positions kept, ${pruned} rare moves pruned` +
      `\n  ratings ${meta.ratings.join('–')} · ${meta.speeds.join(',')} · ${((Date.now() - started) / 1000).toFixed(0)}s`,
  )
}

// Windows gives `file:///C:/…` from import.meta.url but argv[1] is a plain path,
// so this must go through pathToFileURL rather than string-patching slashes.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
