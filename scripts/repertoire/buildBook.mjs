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
import { createReadStream, existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { createGunzip, zstdDecompressSync } from 'node:zlib'
import { Readable } from 'node:stream'
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'
import { Chess } from 'chess.js'
import { fenKey } from '../../src/domain/repertoirePgn.ts'

const DUMP = (month) =>
  `https://database.lichess.org/standard/lichess_db_standard_rated_${month}.pgn.zst`

const SPEED_RE = /\b(ultrabullet|bullet|blitz|rapid|classical)\b/i
const WANTED_HEADERS = new Set(['Event', 'Result', 'WhiteElo', 'BlackElo', 'Variant'])

const ZSTD_FRAME = 0xfd2fb528 // bytes 28 b5 2f fd, read little-endian
const SKIPPABLE_LO = 0x184d2a50
const SKIPPABLE_HI = 0x184d2a5f

const isFrameStart = (buf, i) => {
  if (i + 4 > buf.length) return false
  const m = buf.readUInt32LE(i)
  return m === ZSTD_FRAME || (m >= SKIPPABLE_LO && m <= SKIPPABLE_HI)
}

/**
 * Decompress a **multi-frame, seekable** zstd stream, yielding output buffers.
 *
 * The Lichess dumps are seekable zstd: a leading skippable frame, then many
 * independent ~32 MiB frames, then a skippable seek table. Node's
 * `createZstdDecompress` decodes exactly ONE frame and then rejects the next
 * frame's header with ZSTD_error_prefix_unknown — so piping the whole file
 * through it silently yields only the first 32 MiB. That truncation is
 * invisible: you get a perfectly well-formed book built from 3% of the data.
 *
 * So we frame it ourselves: skip skippable frames, find the next frame
 * boundary, and decompress each frame independently. A frame magic can occur by
 * chance inside compressed data (~1 in 4 billion per offset), so a boundary
 * that fails to decompress is treated as a false positive and we look for the
 * next one — the decode itself is the validation.
 */
async function* decompressFrames(source) {
  const iter = source[Symbol.asyncIterator]()
  let buf = Buffer.alloc(0)
  let sourceDone = false

  const pull = async () => {
    if (sourceDone) return false
    const { value, done } = await iter.next()
    if (done) {
      sourceDone = true
      return false
    }
    buf = buf.length ? Buffer.concat([buf, Buffer.from(value)]) : Buffer.from(value)
    return true
  }

  for (;;) {
    while (buf.length < 8 && (await pull()));
    if (buf.length < 4) return

    const magic = buf.readUInt32LE(0)
    if (magic >= SKIPPABLE_LO && magic <= SKIPPABLE_HI) {
      const size = buf.readUInt32LE(4)
      while (buf.length < 8 + size && (await pull()));
      if (buf.length < 8 + size) return // truncated trailer; nothing left to read
      buf = buf.subarray(8 + size)
      continue
    }
    if (magic !== ZSTD_FRAME) {
      throw new Error(`unexpected zstd magic 0x${magic.toString(16)} — not a zstd stream?`)
    }

    // Find this frame's end: the next frame boundary, or EOF.
    let end = -1
    let from = 4
    for (;;) {
      for (let i = from; i + 4 <= buf.length; i++) {
        if (isFrameStart(buf, i)) {
          end = i
          break
        }
      }
      if (end !== -1) break
      from = Math.max(4, buf.length - 3)
      if (!(await pull())) {
        end = buf.length
        break
      }
    }

    let out
    for (;;) {
      try {
        out = zstdDecompressSync(buf.subarray(0, end))
        break
      } catch (err) {
        // Either a chance magic inside the data, or the frame is still
        // incomplete. Look further; if there is no further, give up loudly.
        let next = -1
        for (let i = end + 1; i + 4 <= buf.length; i++) {
          if (isFrameStart(buf, i)) {
            next = i
            break
          }
        }
        if (next === -1) {
          if (await pull()) continue
          throw new Error('could not decode zstd frame at end of stream', { cause: err })
        }
        end = next
      }
    }

    yield out
    buf = buf.subarray(end)
    if (buf.length === 0 && sourceDone) return
  }
}

/**
 * Accept whatever the caller has: seekable-zstd (the Lichess dumps), gzip, or
 * plain PGN. Sniffed from the leading bytes rather than the file name, so a
 * PGN exported from En Croissant, Chessbase or anywhere else just works.
 *
 * This is why we do not decode En Croissant's own `.db3` move BLOBs: those are
 * an index into shakmaty's legal-move list, whose ordering is undocumented and
 * pinned to a library version. Exporting PGN from En Croissant lands here
 * instead, with no reverse engineering and nothing to break on an upgrade.
 */
async function* sniffAndDecompress(source) {
  const iter = source[Symbol.asyncIterator]()
  const first = await iter.next()
  if (first.done) return
  const head = Buffer.from(first.value)

  // Re-attach the byte we consumed for sniffing.
  async function* rewound() {
    yield head
    for (;;) {
      const next = await iter.next()
      if (next.done) return
      yield Buffer.from(next.value)
    }
  }

  if (head.length >= 4) {
    const magic = head.readUInt32LE(0)
    if (magic === ZSTD_FRAME || (magic >= SKIPPABLE_LO && magic <= SKIPPABLE_HI)) {
      yield* decompressFrames(rewound())
      return
    }
  }
  if (head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b) {
    yield* Readable.from(rewound()).pipe(createGunzip())
    return
  }
  yield* rewound() // plain text
}

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
function decompressedStream(source) {
  const stream = Readable.from(sniffAndDecompress(source))
  stream.on('error', () => {})
  return stream
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
async function* resumableFetch(url, { retries = 8 } = {}) {
  let offset = 0
  let attempt = 0
  let reader = null
  try {
    for (;;) {
      try {
        const res = await fetch(url, offset ? { headers: { Range: `bytes=${offset}-` } } : undefined)
        if (offset === 0 ? !res.ok : res.status !== 206) {
          throw new Error(`HTTP ${res.status} fetching ${url}`)
        }
        reader = res.body.getReader()
        for (;;) {
          const { value, done } = await reader.read()
          if (done) return
          offset += value.length
          attempt = 0 // any progress refreshes the retry budget
          yield Buffer.from(value)
        }
      } catch (err) {
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
async function* streamGames(input) {
  const rl = createInterface({ input: decompressedStream(input), crlfDelay: Infinity })
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
function sans(movetext) {
  return movetext
    .replace(/\{[^}]*\}/g, ' ')
    .replace(/\$\d+/g, ' ')
    .replace(/\d+\.(\.\.)?/g, ' ')
    .replace(/\b(1-0|0-1|1\/2-1\/2|\*)\s*$/, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
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
    onProgress,
  } = opts

  /** @type {Map<string, Map<string, [number,number,number]>>} fenKey → san → [w,d,b] */
  const book = new Map()
  const speedSet = new Set(speeds.map((s) => s.toLowerCase()))

  let aborted = false
  const { stream: source, close } = file
    ? fileSource(file)
    : (() => {
        const stream = Readable.from(resumableFetch(DUMP(month)))
        return { stream, close: () => stream.destroy() }
      })()
  let seen = 0
  let kept = 0
  const chess = new Chess()

  try {
    for await (const { headers, movetext } of streamGames(source)) {
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

      const moves = sans(movetext)
      if (moves.length < 4) continue

      chess.reset()
      for (let i = 0; i < Math.min(maxPly, moves.length); i++) {
        const key = fenKey(chess.fen())
        let node = book.get(key)
        if (!node) book.set(key, (node = new Map()))
        let tally = node.get(moves[i])
        if (!tally) node.set(moves[i], (tally = [0, 0, 0]))
        tally[outcome]++
        try {
          if (!chess.move(moves[i])) break
        } catch {
          break // malformed movetext — abandon this game, keep the book
        }
      }

      kept++
      if (kept % 25_000 === 0) {
        onProgress?.({ seen, kept, positions: book.size })
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
    onProgress: ({ seen, kept, positions }) =>
      process.stdout.write(`\r  scanned ${seen} · kept ${kept} · positions ${positions}   `),
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
