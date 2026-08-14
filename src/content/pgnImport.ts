/**
 * PGN import: reading the file.
 *
 * The user attaches their own PGN and we parse, filter and index it locally
 * (ADR 0018, docs/v0.3.0-plan.md §9). This module is the streaming half — the
 * rules it applies are pure and live in `domain/pgnImport.ts`.
 *
 * **Streaming is the whole point.** A user's database can be hundreds of
 * megabytes; reading it into one string is not a slow version of this, it is a
 * crashed tab. So:
 *
 * - the file is consumed through `stream()` and never `text()`/`arrayBuffer()`;
 * - parsing uses **chessops' async streaming PGN parser**, which is the only JS
 *   parser that doesn't need the whole file at once and which preserves
 *   comments, NAGs and variations (docs/spikes/games-corpus.md §5). A
 *   hand-rolled `[Event ` splitter is whole-file-in-memory by construction;
 * - games are handed on in batches and the reader **waits** for each batch, so a
 *   parser that outruns the writer can't queue a whole database in memory.
 *
 * `pgnImport.test.ts` asserts all three, including that a game is delivered
 * before the last chunk has been pulled. Those assertions are the guard against
 * a future refactor quietly putting the whole-file read back.
 */

import { PgnParser, emptyHeaders, type Game, type PgnNodeData } from 'chessops/pgn'
import {
  DEFAULT_IMPORT_FILTERS,
  describeGame,
  filterGame,
  normalizeGame,
  type GameFacts,
  type ImportFilters,
  type ImportedGame,
  type SkipReason,
} from '../domain/pgnImport'

/** Anything we can stream bytes out of — a `File`, a `Blob`, or a test double. */
export interface PgnSource {
  stream(): ReadableStream<Uint8Array>
  /** Total bytes, when known, so progress can be a fraction rather than a count. */
  size?: number
}

/** One game that survived the filters, with the facts already derived from it. */
export interface ImportedRecord {
  game: ImportedGame
  facts: GameFacts
}

export interface ImportProgress {
  /** Games the parser produced, whether or not we kept them. */
  parsed: number
  kept: number
  skipped: number
  bytesRead: number
  /** Absent when the source didn't say how big it is. */
  totalBytes?: number
  skippedByReason: Partial<Record<SkipReason, number>>
}

export interface StreamPgnOptions {
  filters?: ImportFilters
  /** How many games to hand over at once. Dexie's sweet spot is 500–1000 (§9). */
  batchSize?: number
  /**
   * Handle a batch. **Awaited**: while it is running the file is not read, which
   * is what keeps a 100k-game import bounded in memory.
   */
  onBatch: (games: ImportedRecord[]) => void | Promise<void>
  onProgress?: (progress: ImportProgress) => void
  /**
   * Per-game complexity budget for the parser (chessops' DoS guard). Exposed
   * for tests; the default is chessops' own and no real game approaches it.
   */
  maxGameBudget?: number
}

export const DEFAULT_BATCH_SIZE = 500

/** chessops' own default. A game costing this much is pathological, not long. */
const DEFAULT_GAME_BUDGET = 1_000_000

/**
 * Read a PGN file end to end, keeping the games that pass the filters.
 *
 * Resolves with the final totals. Never throws for bad *content* — a game we
 * can't use is counted against a reason and the import carries on (§9:
 * "malformed games are skipped with a reason, never fatal"). It does reject if
 * the underlying stream fails, because that means the file is gone.
 */
export async function streamPgn(
  source: PgnSource,
  options: StreamPgnOptions,
): Promise<ImportProgress> {
  const filters = options.filters ?? DEFAULT_IMPORT_FILTERS
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE
  const budget = options.maxGameBudget ?? DEFAULT_GAME_BUDGET

  const progress: ImportProgress = {
    parsed: 0,
    kept: 0,
    skipped: 0,
    bytesRead: 0,
    ...(source.size === undefined ? {} : { totalBytes: source.size }),
    skippedByReason: {},
  }

  const skip = (reason: SkipReason) => {
    progress.skipped++
    progress.skippedByReason[reason] = (progress.skippedByReason[reason] ?? 0) + 1
  }

  let batch: ImportedRecord[] = []

  // chessops calls this synchronously from inside `parse`, so it only ever
  // buffers — everything async happens between reads, below.
  let brokenParser = false
  const emit = (parsed: Game<PgnNodeData>, err: unknown) => {
    progress.parsed++
    if (err) {
      // The parser has thrown and will now ignore everything: it must be
      // replaced before the next line, or the rest of the file is lost.
      brokenParser = true
      skip('malformed')
      return
    }
    const game = normalizeGame(parsed)
    const facts = describeGame(game)
    const verdict = filterGame(facts, filters)
    if (!verdict.keep) return skip(verdict.reason)
    progress.kept++
    batch.push({ game, facts })
  }

  const newParser = () => new PgnParser((game, err) => emit(game, err), emptyHeaders, budget)
  let parser = newParser()

  const flush = async () => {
    if (batch.length === 0) return
    const handing = batch
    batch = []
    await options.onBatch(handing)
  }

  /**
   * Feed the parser one line at a time.
   *
   * Whole chunks would be fewer calls, but chessops' budget guard is terminal —
   * once a game throws, `parse` returns immediately forever — so feeding a whole
   * chunk means one pathological game costs every game after it in that chunk.
   * Line at a time, a fresh parser resumes on the very next line. The remains of
   * the broken game then read as a game with no headers, which the filters drop.
   */
  const feed = (line: string) => {
    parser.parse(line, { stream: true })
    if (brokenParser) {
      brokenParser = false
      parser = newParser()
    }
  }

  const reader = source.stream().getReader()
  const decoder = new TextDecoder('utf-8')
  // A line, and a multi-byte character, can both straddle a chunk boundary. The
  // decoder handles the character; this holds the line.
  let pending = ''

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      progress.bytesRead += value.byteLength

      const text = pending + decoder.decode(value, { stream: true })
      const lines = text.split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) feed(line + '\n')

      if (batch.length >= batchSize) await flush()
      options.onProgress?.({ ...progress, skippedByReason: { ...progress.skippedByReason } })
    }
  } finally {
    reader.releaseLock()
  }

  // Flush the decoder, then the last line, then the parser itself: `parse('')`
  // without `stream` is what tells chessops the file is over and emits the game
  // in hand.
  const tail = pending + decoder.decode()
  if (tail) feed(tail)
  parser.parse('')
  await flush()

  return progress
}
