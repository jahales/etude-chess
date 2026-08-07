// Decompression for the corpora we read: seekable zstd, gzip, or plain PGN.
//
// The Lichess dumps are *seekable* zstd — a leading skippable frame, many
// independent ~32 MiB frames, and a trailing seek table. Node's
// `createZstdDecompress` decodes exactly ONE frame and then stops, **without an
// error**, so piping a dump straight through it yields a perfectly well-formed
// book built from 3% of the games. Measured on a real dump: Node's binding
// decoded 0 MB and reported nothing wrong; libzstd decoded 902 MB across the
// same input.
//
// This file used to split the frames by hand to work around that, which cost
// three separate faults — a silent 97% data loss, an unbounded buffer that
// presented as a hang, and quadratic frame assembly. libzstd's streaming
// decoder consumes concatenated frames natively, so none of that machinery is
// ours to own any more. What remains is the sniffing and the consumed-bytes
// accounting the download cache depends on.

import { DecompressStream } from 'zstd-napi'

export const ZSTD_FRAME = 0xfd2fb528 // bytes 28 b5 2f fd, read little-endian
export const SKIPPABLE_LO = 0x184d2a50
export const SKIPPABLE_HI = 0x184d2a5f

/** Whether these leading bytes open a zstd stream — frame or skippable frame. */
export function looksLikeZstd(head) {
  if (head.length < 4) return false
  const magic = head.readUInt32LE(0)
  return magic === ZSTD_FRAME || (magic >= SKIPPABLE_LO && magic <= SKIPPABLE_HI)
}

/**
 * How far behind the feed position a mid-stream "this much is good" mark stays.
 *
 * A mark is only useful if it is *safe*: the next run truncates the download
 * cache to it and resumes, so a mark that lands inside corrupt bytes wedges
 * every later run at the same offset. That happened, for a day.
 *
 * The decoder buffers, so the feed position proves nothing on its own — bytes
 * accepted by `write()` may be rejected several chunks later. There is no exact
 * answer available through a Transform, so this is an honest margin rather than
 * a proof: comfortably beyond zstd's ~8 MB window for these dumps, and the cost
 * of being wrong in the safe direction is re-downloading 16 MB of a 27 GB file.
 *
 * A stream that ends cleanly is marked in full, so a small month is not held
 * back by this — an earlier throttle at 32 MB meant the 17 MB 2013-01 dump was
 * never marked at all and re-downloaded on every run.
 */
export const SAFETY_MARGIN = 16 << 20

function damaged(why, cause) {
  return new Error(
    `${why} — the stream looks damaged. ` +
      `If this is a cached dump, delete it under db/cache and let it re-download.`,
    cause ? { cause } : undefined,
  )
}

/**
 * Decompress a zstd stream of any number of frames, yielding output buffers.
 *
 * @param {AsyncIterable<Buffer>|Iterable<Buffer>} source
 * @param {{onConsumed?: (bytes: number) => void}} [opts]
 *   `onConsumed` reports how many *input* bytes are known to have decoded
 *   cleanly, which is what lets the caller record how much of a download cache
 *   is trustworthy. See the lag below for why it is not simply the feed
 *   position.
 */
export async function* decompressZstd(source, opts = {}) {
  const { onConsumed } = opts
  const stream = new DecompressStream()

  const ready = []
  let failure = null
  let finished = false
  /** Resolved by a real stream event — never on a timer, or this becomes a spin. */
  let wake = null
  const nudge = () => {
    const w = wake
    wake = null
    w?.()
  }
  const nextEvent = () =>
    failure || finished ? Promise.resolve() : new Promise((resolve) => (wake = resolve))

  // The 'data' listener also puts the readable side in flowing mode, which is
  // what lets 'end' fire at all.
  stream.on('data', (c) => {
    ready.push(c)
    nudge()
  })
  stream.on('error', (e) => {
    failure = e
    nudge()
  })
  stream.on('end', () => {
    finished = true
    nudge()
  })

  let fed = 0

  const drain = function* () {
    while (ready.length) yield ready.shift()
  }

  // The write callback, not 'drain': a stream that has errored never drains, so
  // waiting on that hangs forever on the very input we most want to reject.
  // The callback fires either way, and still applies backpressure — which
  // matters when the source is a 27 GB download.
  const write = (chunk) => new Promise((resolve) => stream.write(chunk, () => resolve()))

  try {
    for await (const value of source) {
      const chunk = Buffer.from(value)
      if (chunk.length === 0) continue
      await write(chunk)
      if (failure) throw damaged(`zstd failed to decode after ${fed} bytes`, failure)
      fed += chunk.length
      yield* drain()
      onConsumed?.(Math.max(0, fed - SAFETY_MARGIN))
    }

    stream.end()
    while (!finished && !failure) {
      await nextEvent()
      yield* drain()
    }
    // zstd returns partial output for truncated input *without* error, so a
    // successful decode proves nothing on its own. Only the end of the stream
    // says whether the last frame was whole — which is the check that catches a
    // torn dump, and the one every silent-truncation bug here got past.
    if (failure) throw damaged(`zstd stream ends mid-frame after ${fed} bytes`, failure)
    yield* drain()
    onConsumed?.(fed)
  } finally {
    stream.destroy()
  }
}

/**
 * Accept whatever the caller has: seekable zstd, gzip, or plain PGN. Sniffed
 * from the leading bytes rather than the file name, so a PGN exported from En
 * Croissant, ChessBase or SCID just works.
 */
export async function* sniffAndDecompress(source, opts = {}) {
  const iter = source[Symbol.asyncIterator]
    ? source[Symbol.asyncIterator]()
    : source[Symbol.iterator]()
  const first = await iter.next()
  if (first.done) return
  const head = Buffer.from(first.value)

  async function* rewound() {
    yield head
    for (;;) {
      const next = await iter.next()
      if (next.done) return
      yield Buffer.from(next.value)
    }
  }

  if (looksLikeZstd(head)) {
    yield* decompressZstd(rewound(), opts)
    return
  }
  if (head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b) {
    const { createGunzip } = await import('node:zlib')
    const { Readable } = await import('node:stream')
    yield* Readable.from(rewound()).pipe(createGunzip())
    return
  }
  yield* rewound() // plain text
}
