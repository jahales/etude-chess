import { describe, it, expect } from 'vitest'
import { zstdCompressSync, zstdDecompressSync, gzipSync } from 'node:zlib'
import { randomBytes } from 'node:crypto'
import {
  decompressFrames,
  sniffAndDecompress,
  isFrameStart,
  declaredContentSize,
} from './zstdFrames.mjs'

/** A zstd skippable frame carrying `size` bytes of payload, as Lichess prefixes. */
function skippable(size = 4) {
  const head = Buffer.alloc(8)
  head.writeUInt32LE(0x184d2a50, 0)
  head.writeUInt32LE(size, 4)
  return Buffer.concat([head, Buffer.alloc(size, 0xab)])
}

const frame = (text) => zstdCompressSync(Buffer.from(text))

/** Feed a buffer through in `chunkSize` pieces, as a stream would. */
async function* chunked(buf, chunkSize = 64 * 1024) {
  for (let i = 0; i < buf.length; i += chunkSize) yield buf.subarray(i, i + chunkSize)
}

async function collect(source, opts) {
  const out = []
  for await (const chunk of decompressFrames(source, opts)) out.push(chunk)
  return Buffer.concat(out).toString('utf8')
}

describe('isFrameStart', () => {
  it('recognises a zstd frame magic', () => {
    expect(isFrameStart(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), 0)).toBe(true)
  })
  it('recognises the whole skippable magic range', () => {
    for (const low of [0x50, 0x55, 0x5f]) {
      expect(isFrameStart(Buffer.from([low, 0x2a, 0x4d, 0x18]), 0)).toBe(true)
    }
  })
  it('rejects anything else, and refuses to read past the end', () => {
    expect(isFrameStart(Buffer.from([1, 2, 3, 4]), 0)).toBe(false)
    expect(isFrameStart(Buffer.from([0x28, 0xb5]), 0)).toBe(false)
  })
})

describe('decompressFrames', () => {
  it('decodes a single frame', async () => {
    expect(await collect(chunked(frame('hello')))).toBe('hello')
  })

  it('decodes every frame of a multi-frame stream', async () => {
    // The regression that mattered most: Node's own decompressor stops after
    // the first frame, which silently loses ~97% of a Lichess dump.
    const stream = Buffer.concat([frame('alpha '), frame('beta '), frame('gamma')])
    expect(await collect(chunked(stream))).toBe('alpha beta gamma')
  })

  it('skips a leading skippable frame', async () => {
    expect(await collect(chunked(Buffer.concat([skippable(), frame('payload')])))).toBe('payload')
  })

  it('skips a trailing seek table', async () => {
    const stream = Buffer.concat([skippable(), frame('a'), frame('b'), skippable(64)])
    expect(await collect(chunked(stream))).toBe('ab')
  })

  it('is unaffected by how the bytes are chunked', async () => {
    const stream = Buffer.concat([skippable(), frame('one '), frame('two')])
    for (const size of [1, 7, 64, 4096, stream.length]) {
      expect(await collect(chunked(stream, size))).toBe('one two')
    }
  })

  it('reports consumed bytes only on frame boundaries', async () => {
    const a = frame('first')
    const b = frame('second')
    const marks = []
    await collect(chunked(Buffer.concat([a, b])), { onConsumed: (n) => marks.push(n) })
    // Exactly the two boundaries, in order — this is what makes a cache
    // resumable: every mark is a byte offset known to decode cleanly.
    expect(marks).toEqual([a.length, a.length + b.length])
  })

  it('fails loudly on a damaged stream instead of consuming it forever', async () => {
    // A frame magic followed by bytes that never yield a boundary. Before the
    // ceiling this accumulated the entire file into one buffer and presented as
    // a hang — the failure that cost a day.
    const junk = Buffer.concat([Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), Buffer.alloc(300_000, 7)])
    await expect(collect(chunked(junk), { maxFrameBytes: 64 * 1024 })).rejects.toThrow(/damaged/)
  })

  it('names the cache in the damage message, since that is the fix', async () => {
    const junk = Buffer.concat([Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), Buffer.alloc(300_000, 7)])
    await expect(collect(chunked(junk), { maxFrameBytes: 64 * 1024 })).rejects.toThrow(/db\/cache/)
  })

  it('rejects a stream that is not zstd at all', async () => {
    await expect(collect(chunked(Buffer.alloc(64, 9)))).rejects.toThrow(/not a zstd stream/)
  })

  it('yields nothing for an empty stream', async () => {
    expect(await collect(chunked(Buffer.alloc(0)))).toBe('')
  })

  it('detects truncation the decoder itself does not report', async () => {
    // zstdDecompressSync returns partial output for a torn frame and calls it
    // success — at 10%, 50%, 90%, every level. The declared content size in the
    // header is the only thing that gives it away.
    const data = randomBytes(300_000)
    const full = zstdCompressSync(data)
    expect(declaredContentSize(full)).toBe(data.length)
    const half = full.subarray(0, Math.floor(full.length / 2))
    expect(zstdDecompressSync(half).length).toBeLessThan(data.length) // no throw!
    await expect(collect(chunked(half))).rejects.toThrow(/truncated|damaged/)
  })

  it('reads the declared size, or reports none when absent', async () => {
    expect(declaredContentSize(zstdCompressSync(Buffer.from('abc')))).toBe(3)
    expect(declaredContentSize(Buffer.alloc(2))).toBeNull()
  })

  it('reports a truncated trailing frame, after delivering the good ones', async () => {
    // Exactly what an interrupted cache write leaves behind. Two properties
    // matter: the complete frames before the tear must still be delivered, and
    // the tear itself must raise rather than pass for a clean end of stream.
    // (Incompressible payload — 5,000 identical bytes compress to under 40, so
    // "truncating" repetitive data leaves the frame intact.)
    const good = frame('keep this')
    const torn = zstdCompressSync(randomBytes(300_000))
    const stream = Buffer.concat([good, torn.subarray(0, Math.floor(torn.length / 2))])

    const delivered = []
    let threw = null
    try {
      for await (const chunk of decompressFrames(chunked(stream))) delivered.push(chunk)
    } catch (err) {
      threw = err
    }
    expect(threw).not.toBeNull()
    expect(Buffer.concat(delivered).toString('utf8')).toBe('keep this')
  })
})

describe('sniffAndDecompress', () => {
  const read = async (buf) => {
    const out = []
    for await (const chunk of sniffAndDecompress(chunked(buf))) out.push(Buffer.from(chunk))
    return Buffer.concat(out).toString('utf8')
  }

  it('handles seekable zstd', async () => {
    expect(await read(Buffer.concat([skippable(), frame('zstd here')]))).toBe('zstd here')
  })

  it('handles gzip', async () => {
    expect(await read(gzipSync(Buffer.from('gzip here')))).toBe('gzip here')
  })

  it('passes plain text through untouched', async () => {
    // A PGN exported from En Croissant or ChessBase arrives this way.
    expect(await read(Buffer.from('[Event "Plain PGN"]\n\n1. d4 d5'))).toBe(
      '[Event "Plain PGN"]\n\n1. d4 d5',
    )
  })

  it('detects by content, not by file name', async () => {
    // Lumbra ships both PGN and Scid builds; trusting an extension is how you
    // feed a binary database to a text parser and get "0 games" with no error.
    expect(await read(gzipSync(Buffer.from('x')))).toBe('x')
  })

  it('yields nothing for an empty source', async () => {
    expect(await read(Buffer.alloc(0))).toBe('')
  })
})
