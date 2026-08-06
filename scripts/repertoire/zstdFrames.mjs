// Multi-frame (seekable) zstd decoding, extracted so it can be tested.
//
// This code has been the source of three separate faults — a silent 97% data
// loss, an unbounded buffer that presented as a hang, and quadratic frame
// assembly — so it does not live inline in a build script any more.
//
// Node's `createZstdDecompress` decodes exactly ONE frame and then rejects the
// next frame's header. The Lichess dumps are a leading skippable frame, many
// independent ~32 MiB frames, and a trailing seek table, so piping one straight
// through it yields a perfectly well-formed book built from the first 32 MiB
// with no error at all. Hence framing it ourselves.

import { zstdDecompressSync } from 'node:zlib'

export const ZSTD_FRAME = 0xfd2fb528 // bytes 28 b5 2f fd, read little-endian
export const SKIPPABLE_LO = 0x184d2a50
export const SKIPPABLE_HI = 0x184d2a5f

/**
 * How far we will search for a frame boundary before declaring the stream
 * damaged. Real frames here are ~7 MB compressed; without a ceiling the search
 * consumes the whole file into one buffer, which from outside looks exactly
 * like slow progress rather than a fault.
 */
export const MAX_FRAME_BYTES = 64 << 20

/** Batch size for staging input. Joining per 64 KB chunk is quadratic. */
export const PULL_BATCH = 4 << 20

/**
 * The decompressed size a zstd frame *claims* in its header, or null if it
 * doesn't declare one.
 *
 * This exists because `zstdDecompressSync` does not fail on a truncated frame —
 * it returns whatever it managed to decode. Measured across truncation levels:
 * a frame cut to 10% yields 10% of the bytes, 90% yields 90%, all reported as
 * success. So decode success is *not* evidence of a complete frame, and every
 * silent-truncation bug in this pipeline traces back to assuming it was.
 * Comparing against the declared size is what actually detects a torn stream.
 *
 * Header layout per the zstd spec: magic(4), descriptor(1), then optional
 * window descriptor, dictionary id, and the content-size field.
 */
export function declaredContentSize(buf) {
  if (buf.length < 5) return null
  const descriptor = buf[4]
  const fcsFlag = descriptor >> 6
  const singleSegment = (descriptor >> 5) & 1
  const dictIdFlag = descriptor & 3

  let off = 5
  if (!singleSegment) off += 1 // window descriptor
  off += [0, 1, 2, 4][dictIdFlag]

  const fcsBytes = fcsFlag === 0 ? (singleSegment ? 1 : 0) : [0, 2, 4, 8][fcsFlag]
  if (fcsBytes === 0 || buf.length < off + fcsBytes) return null

  if (fcsBytes === 1) return buf[off]
  if (fcsBytes === 2) return buf.readUInt16LE(off) + 256
  if (fcsBytes === 4) return buf.readUInt32LE(off)
  return Number(buf.readBigUInt64LE(off))
}

export function isFrameStart(buf, i) {
  if (i + 4 > buf.length) return false
  const magic = buf.readUInt32LE(i)
  return magic === ZSTD_FRAME || (magic >= SKIPPABLE_LO && magic <= SKIPPABLE_HI)
}

/**
 * Decompress a multi-frame zstd stream, yielding output buffers.
 *
 * @param {AsyncIterable<Buffer>|Iterable<Buffer>} source
 * @param {{onConsumed?: (bytes: number) => void, maxFrameBytes?: number}} [opts]
 *   `onConsumed` fires after each frame with the total number of *input* bytes
 *   consumed so far, always on a frame boundary. That is what lets the caller
 *   record how much of a cache file is known-good.
 */
export async function* decompressFrames(source, opts = {}) {
  const { onConsumed, maxFrameBytes = MAX_FRAME_BYTES } = opts
  const iter = source[Symbol.asyncIterator]
    ? source[Symbol.asyncIterator]()
    : source[Symbol.iterator]()

  let buf = Buffer.alloc(0)
  let pending = []
  let pendingLen = 0
  let sourceDone = false
  let consumed = 0

  const stage = async () => {
    if (sourceDone) return false
    const { value, done } = await iter.next()
    if (done) {
      sourceDone = true
      return false
    }
    const chunk = Buffer.from(value)
    pending.push(chunk)
    pendingLen += chunk.length
    return true
  }

  const materialise = () => {
    if (pendingLen === 0) return
    buf = buf.length
      ? Buffer.concat([buf, ...pending], buf.length + pendingLen)
      : Buffer.concat(pending, pendingLen)
    pending = []
    pendingLen = 0
  }

  /** Stage at least `min` bytes (or reach the end), then join once. */
  const pullAtLeast = async (min) => {
    const before = buf.length + pendingLen
    while (pendingLen < min && (await stage()));
    materialise()
    return buf.length > before
  }

  const damaged = (why, cause) =>
    new Error(
      `${why} within ${maxFrameBytes >> 20} MB — the stream looks damaged. ` +
        `If this is a cached dump, delete it under db/cache and let it re-download.`,
      cause ? { cause } : undefined,
    )

  for (;;) {
    while (buf.length < 8 && (await pullAtLeast(1)));
    if (buf.length < 4) return

    const magic = buf.readUInt32LE(0)

    if (magic >= SKIPPABLE_LO && magic <= SKIPPABLE_HI) {
      const size = buf.readUInt32LE(4)
      while (buf.length < 8 + size && (await pullAtLeast(PULL_BATCH)));
      if (buf.length < 8 + size) return // truncated trailer; nothing usable left
      buf = buf.subarray(8 + size)
      consumed += 8 + size
      onConsumed?.(consumed)
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
      if (!(await pullAtLeast(PULL_BATCH))) {
        end = buf.length
        break
      }
      if (buf.length > maxFrameBytes) throw damaged('no zstd frame boundary')
    }

    // A frame magic can occur by chance inside compressed data (~1 in 4 billion
    // per offset), so a boundary that fails to decode is treated as a false
    // positive and we look past it. The decode itself is the validation.
    let out
    for (;;) {
      try {
        const candidate = buf.subarray(0, end)
        const decoded = zstdDecompressSync(candidate)
        // Decode "success" is not enough — see declaredContentSize. If the
        // frame says how big it should be and we got less, the stream is torn,
        // and continuing would quietly build a book from partial data.
        const declared = declaredContentSize(candidate)
        if (declared !== null && decoded.length !== declared) {
          if (sourceDone) {
            throw damaged(
              `frame decoded to ${decoded.length} bytes but declares ${declared}; truncated`,
            )
          }
          // More bytes may still arrive for this frame; treat the boundary as a
          // false positive and keep looking.
          throw new Error('incomplete frame')
        }
        out = decoded
        break
      } catch (err) {
        if (err.message?.startsWith('frame decoded to')) throw err
        let next = -1
        for (let i = end + 1; i + 4 <= buf.length; i++) {
          if (isFrameStart(buf, i)) {
            next = i
            break
          }
        }
        if (next === -1) {
          if (buf.length > maxFrameBytes) throw damaged('could not decode a zstd frame', err)
          if (await pullAtLeast(PULL_BATCH)) continue
          throw new Error('could not decode zstd frame at end of stream', { cause: err })
        }
        end = next
      }
    }

    yield out
    buf = buf.subarray(end)
    consumed += end
    onConsumed?.(consumed)
    if (buf.length === 0 && sourceDone) return
  }
}

/**
 * Accept whatever the caller has: seekable-zstd, gzip, or plain PGN. Sniffed
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

  if (head.length >= 4) {
    const magic = head.readUInt32LE(0)
    if (magic === ZSTD_FRAME || (magic >= SKIPPABLE_LO && magic <= SKIPPABLE_HI)) {
      yield* decompressFrames(rewound(), opts)
      return
    }
  }
  if (head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b) {
    const { createGunzip } = await import('node:zlib')
    const { Readable } = await import('node:stream')
    yield* Readable.from(rewound()).pipe(createGunzip())
    return
  }
  yield* rewound() // plain text
}
