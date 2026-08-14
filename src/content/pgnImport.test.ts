import { describe, it, expect, vi } from 'vitest'
import { DEFAULT_IMPORT_FILTERS, type ImportFilters } from '../domain/pgnImport'
import { streamPgn, type ImportedRecord, type PgnSource } from './pgnImport'

// ---------- fixtures ----------

/** A game long enough and slow enough to clear the default filters. */
function pgn(headers: Record<string, string>, moves = LONG_MOVETEXT): string {
  const tags = Object.entries(headers)
    .map(([k, v]) => `[${k} "${v}"]`)
    .join('\n')
  return `${tags}\n\n${moves} ${headers.Result ?? '*'}\n\n`
}

// 12 full moves — over the 10-move floor.
const LONG_MOVETEXT =
  '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 ' +
  '7. Bb3 d6 8. c3 O-O 9. h3 Nb8 10. d4 Nbd7 11. Nbd2 Bb7 12. Bc2 Re8'

const MASTER = {
  Event: 'Candidates',
  Site: 'Curacao',
  Date: '1962.05.02',
  White: 'Keres, Paul',
  Black: 'Fischer, Robert James',
  Result: '1-0',
  WhiteElo: '2600',
  BlackElo: '2650',
  TimeControl: '40/9000:1800',
}

/** A source that hands out `text` in fixed-size chunks and counts the pulls. */
function chunkedSource(text: string, chunkSize: number) {
  const bytes = new TextEncoder().encode(text)
  const state = { pulls: 0, chunks: Math.ceil(bytes.byteLength / chunkSize) }
  const source: PgnSource = {
    size: bytes.byteLength,
    stream() {
      let offset = 0
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          if (offset >= bytes.byteLength) return controller.close()
          state.pulls++
          controller.enqueue(bytes.slice(offset, offset + chunkSize))
          offset += chunkSize
        },
      })
    },
  }
  return { source, state }
}

/** The whole file in one chunk — the common case, and the simplest to assert on. */
const wholeFile = (text: string): PgnSource => chunkedSource(text, Math.max(text.length, 1)).source

async function importAll(
  source: PgnSource,
  filters: ImportFilters = DEFAULT_IMPORT_FILTERS,
): Promise<{ games: ImportedRecord[]; progress: Awaited<ReturnType<typeof streamPgn>> }> {
  const games: ImportedRecord[] = []
  const progress = await streamPgn(source, {
    filters,
    onBatch: (batch) => {
      games.push(...batch)
    },
  })
  return { games, progress }
}

// ---------- parsing ----------

describe('streamPgn — parsing a real PGN file', () => {
  it('reads every game in a multi-game file', async () => {
    const file = [
      pgn({ ...MASTER, White: 'Keres, Paul' }),
      pgn({ ...MASTER, White: 'Tal, Mikhail', Date: '1962.05.03' }),
      pgn({ ...MASTER, White: 'Petrosian, Tigran', Date: '1962.05.04' }),
    ].join('')

    const { games, progress } = await importAll(wholeFile(file))

    expect(progress.parsed).toBe(3)
    expect(progress.kept).toBe(3)
    expect(games.map((g) => g.facts.white)).toEqual([
      'Keres, Paul',
      'Tal, Mikhail',
      'Petrosian, Tigran',
    ])
    expect(games[0]!.game.sanMoves.slice(0, 3)).toEqual(['e4', 'e5', 'Nf3'])
    expect(games[0]!.game.sanMoves).toHaveLength(24)
  })

  it('preserves the comments a user annotated their file with', async () => {
    // ADR 0018 §3, and what §11 will read back at the reveal.
    const annotated = pgn(
      MASTER,
      '1. e4 { The best by test. } e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 ' +
        '6. Re1 b5 7. Bb3 d6 8. c3 O-O 9. h3 { $14 } Nb8 10. d4 Nbd7',
    )

    const { games } = await importAll(wholeFile(annotated))

    expect(games).toHaveLength(1)
    expect(games[0]!.game.comments?.[0]).toBe('The best by test.')
    expect(games[0]!.game.comments?.[16]).toBe('$14')
  })

  it('reads a file that does not end in a newline', async () => {
    const { progress } = await importAll(wholeFile(pgn(MASTER).trimEnd()))
    expect(progress.kept).toBe(1)
  })

  it('imports nothing, without complaint, from an empty file', async () => {
    const { games, progress } = await importAll(wholeFile(''))
    expect(games).toEqual([])
    expect(progress).toMatchObject({ parsed: 0, kept: 0, skipped: 0 })
  })
})

// ---------- streaming ----------

describe('streamPgn — the import path is streaming', () => {
  it('delivers a game before it has read the last chunk', async () => {
    // The assertion that stops a refactor quietly reintroducing a whole-file
    // read: if the file were buffered first, nothing could be delivered until
    // every chunk had been pulled (docs/v0.3.0-plan.md §9).
    const file = Array.from({ length: 6 }, (_, i) =>
      pgn({ ...MASTER, Date: `1962.05.0${i + 1}` }),
    ).join('')
    const { source, state } = chunkedSource(file, 200)
    expect(state.chunks).toBeGreaterThan(4) // the fixture is genuinely multi-chunk

    let pullsAtFirstGame = Infinity
    await streamPgn(source, {
      batchSize: 1,
      onBatch: () => {
        pullsAtFirstGame = Math.min(pullsAtFirstGame, state.pulls)
      },
    })

    expect(pullsAtFirstGame).toBeLessThan(state.chunks)
  })

  it('never materialises the file as one string', async () => {
    // A `[Event ` splitter — or a stray `await file.text()` — is whole-file-in-
    // memory by construction. These throw rather than return, so any such
    // refactor fails here instead of at 300 MB in someone's browser.
    const file = pgn(MASTER) + pgn({ ...MASTER, Date: '1962.05.03' })
    const { source } = chunkedSource(file, 64)
    const text = vi.fn(() => {
      throw new Error('read the whole file into a string')
    })
    const arrayBuffer = vi.fn(() => {
      throw new Error('read the whole file into a buffer')
    })
    Object.assign(source, { text, arrayBuffer })

    const { progress } = await importAll(source)

    expect(progress.kept).toBe(2)
    expect(text).not.toHaveBeenCalled()
    expect(arrayBuffer).not.toHaveBeenCalled()
  })

  it('waits for each batch to be handled before parsing on', async () => {
    // Back-pressure: without it a fast parser queues every game in memory while
    // the slower writer works through them, which is the 100k-game failure mode.
    // A driver that fired batches without awaiting would have several in flight.
    const file = Array.from({ length: 8 }, (_, i) =>
      pgn({ ...MASTER, Date: `1962.05.0${i + 1}` }),
    ).join('')
    const { source } = chunkedSource(file, 150)

    let inFlight = 0
    let mostInFlight = 0
    let handled = 0
    await streamPgn(source, {
      batchSize: 2,
      onBatch: async () => {
        inFlight++
        mostInFlight = Math.max(mostInFlight, inFlight)
        await new Promise((r) => setTimeout(r, 0))
        inFlight--
        handled++
      },
    })

    expect(handled).toBeGreaterThan(1)
    expect(mostInFlight).toBe(1)
  })

  it('decodes a player name split across a chunk boundary', async () => {
    // UTF-8 is multi-byte and chunk edges do not respect characters.
    const file = pgn({ ...MASTER, White: 'Réti, Richard' })
    for (const chunkSize of [1, 7, 13]) {
      const { games } = await importAll(chunkedSource(file, chunkSize).source)
      expect(games[0]?.facts.white).toBe('Réti, Richard')
    }
  })

  it('reports progress as it goes, ending on the totals it returns', async () => {
    const file = Array.from({ length: 5 }, (_, i) =>
      pgn({ ...MASTER, Date: `1962.05.0${i + 1}` }),
    ).join('')
    const { source } = chunkedSource(file, 120)

    const seen: number[] = []
    const total = await streamPgn(source, {
      onBatch: () => {},
      onProgress: (p) => seen.push(p.bytesRead),
    })

    expect(seen.length).toBeGreaterThan(1)
    expect(seen).toEqual([...seen].sort((a, b) => a - b)) // monotonic
    expect(total.bytesRead).toBe(new TextEncoder().encode(file).byteLength)
    expect(total.totalBytes).toBe(total.bytesRead)
    expect(total.kept).toBe(5)
  })
})

// ---------- filtering ----------

describe('streamPgn — filtering', () => {
  it('keeps the classical game and skips the blitz one, with reasons', async () => {
    const file = [
      pgn(MASTER),
      pgn({ ...MASTER, Date: '1962.05.03', TimeControl: '180+2' }),
      pgn({ ...MASTER, Date: '1962.05.04', WhiteElo: '1400', BlackElo: '1350' }),
      pgn({ ...MASTER, Date: '1962.05.05' }, '1. e4 e5 2. Nf3 Nc6'),
    ].join('')

    const { games, progress } = await importAll(wholeFile(file))

    expect(progress).toMatchObject({ parsed: 4, kept: 1, skipped: 3 })
    expect(progress.skippedByReason).toEqual({
      'fast-time-control': 1,
      'below-min-rating': 1,
      'too-short': 1,
    })
    expect(games).toHaveLength(1)
  })

  it('keeps a game whose time control is unknown, and marks it so', async () => {
    const { TimeControl: _drop, ...noTimeControl } = MASTER
    const { games, progress } = await importAll(wholeFile(pgn(noTimeControl)))

    expect(progress.kept).toBe(1)
    expect(games[0]!.facts.timeControl.speed).toBe('unknown')
    expect(games[0]!.facts.timeControl.baseSeconds).toBeUndefined()
  })

  it('imports everything when the filters are turned off', async () => {
    const file = pgn(MASTER) + pgn({ ...MASTER, Date: '1962.05.03', TimeControl: '60+0' })
    const off: ImportFilters = {
      minBaseSeconds: 0,
      excludeFastSpeeds: false,
      minElo: 0,
      minFullMoves: 0,
    }
    const { progress } = await importAll(wholeFile(file), off)
    expect(progress).toMatchObject({ parsed: 2, kept: 2, skipped: 0 })
  })
})

// ---------- malformed input ----------

describe('streamPgn — malformed games are skipped, never fatal', () => {
  it('imports the good games either side of junk', async () => {
    const file = [
      pgn(MASTER),
      'this is not a chess game at all\n\n',
      '[Event "headers but no moves"]\n[White "A"]\n[Black "B"]\n\n*\n\n',
      pgn({ ...MASTER, Date: '1962.05.09' }),
    ].join('')

    const { games, progress } = await importAll(wholeFile(file))

    expect(progress.kept).toBe(2)
    expect(progress.skippedByReason['no-moves']).toBe(2)
    expect(games).toHaveLength(2)
  })

  it('keeps going after a game blows the parser budget', async () => {
    // chessops' streaming parser is DoS-resistant: a pathological game throws
    // and *stays* thrown, so the driver has to start a fresh parser rather than
    // stop importing (§9: "skipped with a reason, never fatal").
    const file = pgn(MASTER) + pgn({ ...MASTER, Date: '1962.05.03' })
    const { games, progress } = await importAll(wholeFile(file))
    expect(progress.kept).toBe(2)

    const tiny = await streamPgn(wholeFile(file), {
      onBatch: () => {},
      maxGameBudget: 300, // smaller than one game: every game is "too complex"
    })
    expect(tiny.kept).toBe(0)
    expect(tiny.skippedByReason.malformed).toBeGreaterThan(0)
    expect(games).toHaveLength(2) // and the normal run was unaffected
  })

  it('recovers and imports later games after one blows the budget', async () => {
    // The budget is per game, so the games *after* a pathological one must still
    // arrive. A whole-chunk feed would lose all of them — the parser refuses to
    // do any more work once it has thrown — which is why the driver feeds lines.
    const file = [
      pgn({ ...MASTER, Site: 'x'.repeat(5000) }), // one absurd header
      pgn({ ...MASTER, Date: '1962.05.03' }),
      pgn({ ...MASTER, Date: '1962.05.04' }),
    ].join('')

    // Comfortably over an ordinary game, well under the absurd one.
    const summary = await streamPgn(wholeFile(file), { onBatch: () => {}, maxGameBudget: 6000 })

    expect(summary.skippedByReason.malformed).toBe(1)
    expect(summary.kept).toBeGreaterThanOrEqual(2) // the two good games survived
  })
})
