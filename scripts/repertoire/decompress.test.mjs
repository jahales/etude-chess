import { describe, it, expect } from 'vitest'
import { gzipSync } from 'node:zlib'
import { compress } from 'zstd-napi'
import { randomBytes } from 'node:crypto'
import { decompressZstd, sniffAndDecompress, looksLikeZstd, SAFETY_MARGIN } from './decompress.mjs'

// Decompression for the Lichess dumps, which are *seekable* zstd: a leading
// skippable frame, many independent ~32 MiB frames, and a trailing seek table.
//
// This file used to test a hand-rolled frame splitter, because Node's
// `createZstdDecompress` decodes exactly ONE frame and then stops — silently, so
// a dump piped through it yields a perfectly well-formed book built from 3% of
// the games. libzstd handles concatenated frames natively, so the splitter is
// gone; what survives is every behaviour the caller actually depends on.

/** A zstd skippable frame carrying `size` bytes of payload, as Lichess prefixes. */
function skippable(size = 4) {
  const head = Buffer.alloc(8)
  head.writeUInt32LE(0x184d2a50, 0)
  head.writeUInt32LE(size, 4)
  return Buffer.concat([head, Buffer.alloc(size, 0xab)])
}

// Built with libzstd, not node:zlib — `zstdCompressSync` only exists from Node
// 22.15, so fixtures built with it fail on any older runtime. CI runs Node 20
// and had been red for three merges before anyone looked.
const frame = (text) => compress(Buffer.from(text))

/** Feed a buffer through in `chunkSize` pieces, as a stream would. */
async function* chunked(buf, chunkSize = 64 * 1024) {
  for (let i = 0; i < buf.length; i += chunkSize) yield buf.subarray(i, i + chunkSize)
}

async function collect(source, opts) {
  const out = []
  for await (const chunk of decompressZstd(source, opts)) out.push(chunk)
  return Buffer.concat(out).toString('utf8')
}

describe('looksLikeZstd', () => {
  it('recognises a zstd frame magic', () => {
    expect(looksLikeZstd(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]))).toBe(true)
  })

  it('recognises the whole skippable magic range, which is how the dumps open', () => {
    for (const low of [0x50, 0x55, 0x5f]) {
      expect(looksLikeZstd(Buffer.from([low, 0x2a, 0x4d, 0x18]))).toBe(true)
    }
  })

  it('rejects anything else, and refuses to read past the end', () => {
    expect(looksLikeZstd(Buffer.from([1, 2, 3, 4]))).toBe(false)
    expect(looksLikeZstd(Buffer.from([0x28, 0xb5]))).toBe(false)
    expect(looksLikeZstd(Buffer.alloc(0))).toBe(false)
  })
})

describe('decompressZstd', () => {
  it('decodes a single frame', async () => {
    expect(await collect(chunked(frame('hello')))).toBe('hello')
  })

  it('decodes every frame of a multi-frame stream', async () => {
    // THE test. Node's own decoder stops after the first frame and reports
    // success, which is how a book got built from 3% of the games.
    const stream = Buffer.concat([frame('one '), frame('two '), frame('three')])
    expect(await collect(chunked(stream))).toBe('one two three')
  })

  it('decodes far more frames than a single-frame decoder would', async () => {
    const parts = Array.from({ length: 50 }, (_, i) => frame(`${i};`))
    expect(await collect(chunked(Buffer.concat(parts)))).toBe(
      Array.from({ length: 50 }, (_, i) => `${i};`).join(''),
    )
  })

  it('skips a leading skippable frame', async () => {
    expect(await collect(chunked(Buffer.concat([skippable(), frame('payload')])))).toBe('payload')
  })

  it('skips a trailing seek table', async () => {
    const stream = Buffer.concat([frame('body'), skippable(32)])
    expect(await collect(chunked(stream))).toBe('body')
  })

  it('is unaffected by how the bytes are chunked', async () => {
    const stream = Buffer.concat([skippable(), frame('alpha'), frame('beta'), skippable(16)])
    for (const size of [1, 3, 17, 1024, stream.length * 2]) {
      expect(await collect(chunked(stream, size)), `chunk size ${size}`).toBe('alphabeta')
    }
  })

  it('handles a frame larger than one chunk', async () => {
    const big = randomBytes(3 << 20).toString('hex')
    expect(await collect(chunked(frame(big), 64 * 1024))).toBe(big)
  })

  it('yields nothing for an empty stream', async () => {
    expect(await collect(chunked(Buffer.alloc(0)))).toBe('')
  })

  it('rejects a stream that is not zstd at all', async () => {
    await expect(collect(chunked(Buffer.from('just some text here')))).rejects.toThrow()
  })

  it('fails loudly on a truncated stream rather than returning a short book', async () => {
    // The whole reason this module is guarded: zstd returns partial output for
    // truncated input *without error*, so "it decoded" proves nothing. The
    // stream must end at a frame boundary or we have to hear about it.
    const stream = frame('a'.repeat(4096))
    await expect(collect(chunked(stream.subarray(0, stream.length - 8)))).rejects.toThrow(/damaged|incomplete|middle/i)
  })

  it('delivers the good frames before reporting a torn trailing one', async () => {
    const good = frame('keep-this')
    const torn = frame('b'.repeat(4096))
    const out = []
    await expect(async () => {
      for await (const c of decompressZstd(chunked(Buffer.concat([good, torn.subarray(0, torn.length - 8)])))) {
        out.push(c)
      }
    }).rejects.toThrow()
    expect(Buffer.concat(out).toString('utf8')).toContain('keep-this')
  })

  it('names the cache in the failure, since deleting it is the fix', async () => {
    const stream = frame('c'.repeat(4096))
    await expect(collect(chunked(stream.subarray(0, stream.length - 8)))).rejects.toThrow(/db\/cache/)
  })
})

describe('decompressZstd — how much of the input is trustworthy', () => {
  // `onConsumed` is what lets a build record how far its download cache is
  // known-good. A mark that runs ahead of what actually decoded is worse than
  // no mark: the next run trusts a prefix ending mid-corruption, resumes after
  // it, and wedges at the same offset every time. That cost a day.
  const seen = () => {
    const marks = []
    return { marks, onConsumed: (n) => marks.push(n) }
  }

  it('marks the whole input once the stream has ended cleanly', async () => {
    // A stream that finished is provably good all the way through, so a small
    // month is marked in full rather than being held back by the margin.
    const stream = Buffer.concat([frame('one'), frame('two')])
    const { marks, onConsumed } = seen()
    await collect(chunked(stream, 16), { onConsumed })
    expect(marks.at(-1)).toBe(stream.length)
  })

  it('never runs ahead of the input, and never goes backwards', async () => {
    const stream = Buffer.concat([skippable(), frame('alpha'), frame('beta')])
    const { marks, onConsumed } = seen()
    await collect(chunked(stream, 7), { onConsumed })
    for (const m of marks) expect(m).toBeLessThanOrEqual(stream.length)
    expect([...marks].sort((a, b) => a - b)).toEqual(marks)
  })

  it('stays a safety margin behind the feed position while streaming', async () => {
    // The decoder buffers, so bytes accepted by write() may be rejected several
    // chunks later. A mark that ran ahead of what actually decoded is worse
    // than no mark: the next run truncates the cache to it, resumes after the
    // corruption, and wedges at the same offset every time.
    const big = Buffer.from(frame(randomBytes(200_000).toString('hex')))
    const { marks, onConsumed } = seen()
    await collect(chunked(big, 4096), { onConsumed })
    const midStream = marks.slice(0, -1)
    for (const m of midStream) expect(m).toBeLessThanOrEqual(Math.max(0, big.length - SAFETY_MARGIN))
  })

  it('marks nothing mid-stream for a file smaller than the margin', async () => {
    const small = frame(randomBytes(50_000).toString('hex'))
    const { marks, onConsumed } = seen()
    await collect(chunked(small, 4096), { onConsumed })
    expect(marks.slice(0, -1).every((m) => m === 0)).toBe(true)
    expect(marks.at(-1)).toBe(small.length) // ...and everything at the end
  })

  it('never marks a torn stream as complete', async () => {
    // The end-of-stream mark is the only unconditional one, so it must not fire
    // when the stream did not actually finish.
    const stream = Buffer.from(frame(randomBytes(200_000).toString('hex')))
    const { marks, onConsumed } = seen()
    await expect(
      collect(chunked(stream.subarray(0, stream.length - 100), 4096), { onConsumed }),
    ).rejects.toThrow()
    expect(marks.at(-1) ?? 0).toBeLessThan(stream.length - 100)
  })

  it('is optional', async () => {
    await expect(collect(chunked(frame('fine')))).resolves.toBe('fine')
  })
})

describe('sniffAndDecompress', () => {
  const read = async (source) => {
    const out = []
    for await (const chunk of sniffAndDecompress(source)) out.push(Buffer.from(chunk))
    return Buffer.concat(out).toString('utf8')
  }

  it('handles seekable zstd', async () => {
    const stream = Buffer.concat([skippable(), frame('[Event "x"]'), frame(' 1. d4')])
    expect(await read(chunked(stream))).toBe('[Event "x"] 1. d4')
  })

  it('handles gzip', async () => {
    expect(await read(chunked(gzipSync(Buffer.from('[Event "gz"]'))))).toBe('[Event "gz"]')
  })

  it('passes plain text through untouched', async () => {
    expect(await read(chunked(Buffer.from('[Event "plain"]')))).toBe('[Event "plain"]')
  })

  it('detects by content, not by file name', async () => {
    // A PGN exported from En Croissant, ChessBase or SCID just works, whatever
    // it is called.
    expect(await read(chunked(frame('1. e4 e5')))).toBe('1. e4 e5')
    expect(await read(chunked(Buffer.from('1. e4 e5')))).toBe('1. e4 e5')
  })

  it('yields nothing for an empty source', async () => {
    expect(await read(chunked(Buffer.alloc(0)))).toBe('')
  })

  it('survives a first chunk too short to identify', async () => {
    expect(await read(chunked(Buffer.from('ab')))).toBe('ab')
  })
})
