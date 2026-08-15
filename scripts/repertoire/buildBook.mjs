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
import { createPositionFilter, DEFAULT_BITS } from './positionFilter.mjs'
import { Chess } from 'chess.js'
import { fenKey } from '../../src/domain/repertoirePgn.ts'
import { sniffAndDecompress } from './decompress.mjs'
import { numberFlag, parseArgs, stringFlag } from './args.mjs'

const DUMP = (month) =>
  `https://database.lichess.org/standard/lichess_db_standard_rated_${month}.pgn.zst`

/**
 * The time controls a Lichess dump names in its `Event` header.
 *
 * One list, two readers: the scan matches it against a game, and `--speeds`
 * validates against it. A speed the scan cannot see is one `--speeds` must not
 * accept — asking for a name nothing matches empties the book rather than
 * narrowing it.
 */
export const KNOWN_SPEEDS = ['ultrabullet', 'bullet', 'blitz', 'rapid', 'classical']
const SPEED_RE = new RegExp(`\\b(${KNOWN_SPEEDS.join('|')})\\b`, 'i')
const WANTED_HEADERS = new Set(['Event', 'Result', 'WhiteElo', 'BlackElo', 'Variant'])

/**
 * Cap on the memoised transition table. The distribution is heavily Zipfian —
 * a few opening positions account for most transitions — so a cap this size
 * captures nearly every hit while bounding memory at a few hundred MB.
 */
const MAX_TRANSITIONS = 1_500_000

/**
 * Positions one book may hold — V8's own per-Map ceiling, 2^24.
 *
 * Checked rather than discovered: past it `Map.set` throws a `RangeError` that
 * names neither the book nor the flag responsible.
 */
export const MAX_BOOK_POSITIONS = 2 ** 24

/**
 * What this script does when the command line says nothing.
 *
 * Named rather than written straight into the destructuring below, because
 * `--help` quotes them. #115 found this help text advertising `--ratings
 * 1600-2000 --max-games 400000` — a band and a game count that had never been
 * either the defaults or what shipped — which is what a number copied into
 * prose does the first time the code moves. Every default in {@link HELP} is
 * interpolated from here, so the two cannot drift again.
 *
 * `minGames` is read by {@link buildBook} and {@link buildBookFiltered} both,
 * and they have to agree: the counting pass decides what the real pass is
 * allowed to build, so two different fives would let the filter discard
 * positions the prune would have kept.
 */
export const DEFAULTS = Object.freeze({
  minRating: 1600,
  maxRating: 2000,
  speeds: Object.freeze(['blitz', 'rapid', 'classical']),
  maxPly: 16,
  maxGames: 200_000,
  minGames: 5,
})

/**
 * Where the CLI keeps downloaded dump bytes unless told otherwise.
 *
 * This is the *command line's* default, not `buildBook()`'s: called as a
 * library it caches nothing unless asked, because a caller passing a month has
 * not necessarily agreed to spend 27 GB of disk on it. `--no-cache` is the
 * explicit way to say no from the command line.
 */
export const DEFAULT_CACHE = 'db/cache'

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

/**
 * Count first, then build only what can survive the prune.
 *
 * Two passes over the input for a fraction of the memory of one. The counting
 * pass is constant-memory by construction, so the depth a book can reach stops
 * being a memory question — which it very much was: a 4M-game ply-20 book
 * reached 16,731,809 positions and died on V8's per-Map ceiling, having spent
 * all of that on rows the final prune would have deleted.
 *
 * **Local sources only.** A second pass over `--month` would re-read the
 * network stream, so the caller decides; `main` uses it for `--file`.
 */
export async function buildBookFiltered(opts) {
  const { onProgress, minGames = DEFAULTS.minGames, filterBits } = opts

  onProgress?.({ phase: 'counting' })
  const filter = createPositionFilter({ minGames, ...(filterBits ? { bits: filterBits } : {}) })
  await buildBook({ ...opts, out: null, countOnly: true, filter })

  const stats = filter.stats()
  onProgress?.({ phase: 'counted', ...stats })
  return buildBook({ ...opts, filter })
}

export async function buildBook(opts) {
  const {
    month,
    file,
    out,
    minRating = DEFAULTS.minRating,
    maxRating = DEFAULTS.maxRating,
    // Copied, not shared: this array reaches the serialised meta, and a frozen
    // module-level one would be the same object in every book built in a run.
    speeds = [...DEFAULTS.speeds],
    maxPly = DEFAULTS.maxPly,
    maxGames = DEFAULTS.maxGames,
    minGames = DEFAULTS.minGames,
    cache = null,
    onProgress,
    /**
     * Count sightings into `filter` and build nothing. The first half of
     * {@link buildBookFiltered}; on its own it is a way to size a book without
     * paying for it.
     */
    countOnly = false,
    /**
     * A {@link createPositionFilter} from a counting pass. Positions it rejects
     * are never stored, which is what keeps a deep book inside memory — and
     * inside V8's per-Map ceiling, which a 4M-game ply-20 book hit outright.
     */
    filter = null,
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

        // Counting pass: record the sighting and store nothing. Constant
        // memory, so this pass cannot hit any ceiling however deep it runs.
        if (countOnly) {
          filter.count(key)
          key = step.next
          continue
        }
        // Real pass: a position the counting pass never saw `minGames` times
        // cannot have a move played `minGames` times, so it would be pruned at
        // the end anyway. Not building it is the whole saving.
        if (filter && !filter.keeps(key)) {
          key = step.next
          continue
        }

        let node = book.get(key)
        if (!node) {
          // V8 caps a Map at 2^24 entries and throws a bare `RangeError: Map
          // maximum size exceeded` — after however long the scan has been
          // running, with nothing naming the knob that caused it. Distinct
          // positions grow with both depth and games, and depth is much the
          // stronger term: a 4M-game book hit this at --max-ply 20 and sat
          // comfortably under it at 18.
          if (book.size >= MAX_BOOK_POSITIONS) {
            throw new Error(
              `book reached ${book.size.toLocaleString()} positions, V8's per-Map limit. ` +
                `Lower --max-ply (the stronger lever) or --max-games and run again — ` +
                `positions past the crawl's depth cap are pruned anyway.`,
            )
          }
          book.set(key, (node = new Map()))
        }
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

  // A counting pass has nothing to serialise; the filter is the whole output.
  if (countOnly) return { counting: true, filter, gamesScanned: seen, gamesUsed: kept }

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
      // What the counting pass spared us building, so a thin book cannot be
      // mistaken for a filter that discarded too much.
      ...(filter ? { prefiltered: filter.stats() } : {}),
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

/**
 * Every flag this script accepts.
 *
 * `buildBook.mjs` was the third copy of the parser #115 unified, and it kept
 * both defects: it took any flag you gave it, and it read numbers with
 * `Number()`, so a bare `--max-games` was `Number(true)` — a whole book built
 * from **one game**, written, and reported as a success (#122). It is the front
 * of the pipeline, so every crawl, trap statistic and study ranking after it is
 * computed against whatever this produced; the symptom arrives hours later as
 * numbers that look slightly odd.
 *
 * Kept in the order `HELP` lists them, because a test asserts the two name the
 * same set and a mismatch is easier to read that way. Missing a flag from this
 * list is worse than the bug it fixes: it turns a working invocation into a
 * hard error.
 */
export const FLAGS = [
  'month',
  'file',
  'out',
  'ratings',
  'speeds',
  'max-ply',
  'max-games',
  'min-games',
  'one-pass',
  'filter-bits',
  'cache',
  'no-cache',
  'help',
]

/**
 * What `--help` prints — and, via `FLAGS`, a promise that every flag named here
 * is one the parser accepts. Every default is interpolated from the constant it
 * describes, because the last hand-written copy of these numbers advertised a
 * band and a game count that had never shipped (#115).
 */
export const HELP = `
Build a local opening book from the Lichess database dumps (issue #88).

The command the shipped band book was built with — 1300–1800, ply 20, 8M games:

  node scripts/repertoire/buildBook.mjs --month 2026-07 --out db/book-band-2026-07.json \\
       --ratings 1300-1800 --speeds blitz,rapid --max-ply 20 --max-games 8000000

None of those are the defaults below; the defaults are what this script does
when you say nothing, not what the repertoire was built from.

  --month     2026-07           which monthly dump to stream       (required unless --file)
  --file      games.pgn         a local file instead: .pgn, .pgn.gz, .pgn.zst or .7z
                                (format is sniffed, not taken from the name).
                                This is the route for a PGN exported from En
                                Croissant, ChessBase or SCID — set --ratings to
                                match that database's strength.
  --out       out/book.json     where to write                     (required)
  --ratings   ${`${DEFAULTS.minRating}-${DEFAULTS.maxRating}`.padEnd(18)}both players must fall in this band, min-max
  --speeds    blitz,rapid       time controls  (default: ${DEFAULTS.speeds.join(',')})
  --max-ply   ${String(DEFAULTS.maxPly).padEnd(18)}plies recorded per game
  --max-games ${String(DEFAULTS.maxGames).padEnd(18)}stop (and abort the download) after this many
  --min-games ${String(DEFAULTS.minGames).padEnd(18)}drop moves seen fewer times than this
  --one-pass                    skip the counting pass (uses far more memory)
  --filter-bits ${String(DEFAULT_BITS).padEnd(16)}counting-table width; memory is 2^bits bytes
  --cache     ${DEFAULT_CACHE.padEnd(18)}keep downloaded dump bytes here and reuse them
                                next run (only what --max-games actually reads)
  --no-cache                    stream without keeping anything on disk
  --help                        this text

Dumps grow fast: 2013-01 is 17 MB, 2016-01 is 831 MB, a 2026 month is ~27 GB.
Streaming means --max-games decides the real cost, not the file size.

Anything not in that list is an error, not a default (issues #115, #122).
`

/**
 * The rating band `--ratings` names, or undefined for {@link DEFAULTS}.
 *
 * Validated rather than mapped straight through `Number`, because every way of
 * getting it wrong produced a band the scan accepted and no game fell inside:
 * a bare `--ratings` was `String(true)` → `[NaN]`, and `--ratings 1600,1800` —
 * the bucket syntax `crawl.mjs` takes — parses the same way. Both scanned the
 * whole dump and wrote an empty book. `--ratings 1600` was quieter still: one
 * number, so the maximum fell back to the default and the scan ran a band
 * nobody asked for — and said so only in the meta, hours later.
 */
export function ratingBand(args) {
  const raw = stringFlag(args, 'ratings')
  if (raw === undefined) return undefined
  const band = raw.split('-').map((s) => Number(s.trim()))
  if (band.length !== 2 || band.some((n) => !Number.isFinite(n))) {
    throw new Error(
      `--ratings takes a min-max range, e.g. ${DEFAULTS.minRating}-${DEFAULTS.maxRating} — got "${raw}"` +
        ' (crawl.mjs takes comma-separated explorer buckets; this is not that)',
    )
  }
  if (band[0] > band[1]) throw new Error(`--ratings is min-max, and ${band[0]} is above ${band[1]}`)
  return band
}

/**
 * The time controls `--speeds` names, or undefined for {@link DEFAULTS}.
 *
 * Checked against the speeds a dump actually names, because the scan *excludes
 * known-wrong* speeds rather than requiring a known-right one — so a typo does
 * not narrow the book, it empties it. `--speeds blizt` keeps only games whose
 * Event names no speed at all, which on a Lichess month is none of them: hours
 * of scanning, then a book of nothing, reported as a clean run.
 */
export function speedList(args) {
  const raw = stringFlag(args, 'speeds')
  if (raw === undefined) return undefined
  const speeds = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
  const unknown = speeds.filter((s) => !KNOWN_SPEEDS.includes(s))
  if (!speeds.length || unknown.length) {
    throw new Error(
      `--speeds takes any of ${KNOWN_SPEEDS.join(',')}${unknown.length ? ` — got "${unknown.join(',')}"` : ''}`,
    )
  }
  return speeds
}

/**
 * Where the CLI caches dump bytes: a path, or null for "keep nothing".
 *
 * `--no-cache` is the explicit off switch and absence is not — a plain run
 * caches at {@link DEFAULT_CACHE} and reuses those bytes next time, and getting
 * that backwards means silently re-downloading 27 GB (or silently writing it to
 * a disk that was not offered). `--no-cache` wins over `--cache`, as it always
 * has. It is a boolean, so it does not go through `stringFlag`: a bare
 * `--no-cache` is the only way anyone writes it.
 */
export function cachePath(args) {
  if (args['no-cache']) return null
  return stringFlag(args, 'cache') ?? DEFAULT_CACHE
}

/**
 * Whether to make a counting pass before building.
 *
 * Two passes for a local file: counting first costs a second read and saves
 * most of the memory, which is what lets `--max-ply` go deep. A network month
 * is single-pass — re-reading it means re-downloading it.
 */
export function twoPassBuild(args) {
  return Boolean(stringFlag(args, 'file')) && !args['one-pass']
}

/**
 * The {@link buildBook} options a parsed command line asks for.
 *
 * Everything that decides what ends up in the book is decided here, and all of
 * it is read before a byte is downloaded — a 27 GB month must not begin on a
 * command line that was never going to work. Separated from `main` so a test
 * can drive it without a dump.
 *
 * A flag that was not given is passed as `undefined` on purpose: `buildBook`
 * takes its defaults in the destructuring, which skips `undefined`, so this
 * does not need `crawl.mjs`'s `maybe()` — that exists because `crawl()` merges
 * with a spread, where an explicit `undefined` overwrites the default instead.
 */
export function bookOptions(args) {
  const band = ratingBand(args)
  return {
    month: stringFlag(args, 'month'),
    file: stringFlag(args, 'file'),
    out: stringFlag(args, 'out'),
    minRating: band?.[0],
    maxRating: band?.[1],
    speeds: speedList(args),
    maxPly: numberFlag(args, 'max-ply'),
    maxGames: numberFlag(args, 'max-games'),
    minGames: numberFlag(args, 'min-games'),
    filterBits: numberFlag(args, 'filter-bits'),
    cache: cachePath(args),
  }
}

async function main() {
  const a = parseArgs(process.argv.slice(2), FLAGS)
  if (a.help || !a.out || (!a.month && !a.file)) {
    console.log(HELP)
    process.exit(a.help ? 0 : 1)
  }

  // Read — and reject — the whole command line before anything is opened.
  const options = bookOptions(a)
  const build = twoPassBuild(a) ? buildBookFiltered : buildBook
  const started = Date.now()

  const { meta, pruned } = await build({
    ...options,
    onProgress: ({ phase, seen, kept, positions, transitions, heapMb, live, load }) => {
      if (phase === 'counting') return process.stdout.write('  pass 1: counting positions\n')
      if (phase === 'counted') {
        return process.stdout.write(
          `\n  pass 1 done: ${live.toLocaleString()} slots used, ` +
            `table ${(100 * load).toFixed(1)}% loaded` +
            `${load > 0.5 ? ' — collisions are common at this load; raise --filter-bits' : ''}\n` +
            `  pass 2: building only what can survive the prune\n`,
        )
      }
      process.stdout.write(
        `\r  scanned ${seen} · kept ${kept} · positions ${positions} · transitions ${transitions} · heap ${heapMb} MB   `,
      )
    },
  })

  console.log(
    `\n\nbook written to ${options.out}` +
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
