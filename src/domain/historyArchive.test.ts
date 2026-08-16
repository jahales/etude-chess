import { describe, it, expect } from 'vitest'
// Reaches into `app` on purpose: the analysis merge rule below has to agree with
// `supersedes`, which is the rule the rest of the app decides *reuse* with, and
// a test is the only place the two can be pinned together. Test files are exempt
// from the layering check for exactly this (src/architecture.test.ts).
import { supersedes } from '../app/gameAnalysis'
import {
  ARCHIVE_FORMAT,
  ARCHIVE_VERSION,
  analysisApplies,
  analysisWins,
  attemptIdentity,
  canonicalJson,
  changedNothing,
  emptyCounts,
  emptyReport,
  estimateSection,
  footerLine,
  hasAnalysis,
  headerLine,
  placeGame,
  readBodyLine,
  readHeader,
  recordLine,
  sameGame,
} from './historyArchive'

// ---------- the format ----------

describe('the archive header', () => {
  it('round-trips what it wrote', () => {
    const read = readHeader(headerLine(1_700_000_000_000, '0.3.0'))
    expect(read).toMatchObject({ ok: true, value: { version: ARCHIVE_VERSION, app: '0.3.0' } })
  })

  it('refuses a file that is not one of ours, before anything is read', () => {
    for (const line of ['{"hello":"world"}', 'not json at all', '[]', '']) {
      const read = readHeader(line)
      expect(read.ok).toBe(false)
      expect(read.ok === false && read.error).toMatch(/not an étude history file/)
    }
  })

  it('refuses a file from a newer étude rather than dropping what it does not know', () => {
    // The dangerous direction: its records would parse and most of their fields
    // would apply, so whatever the new version added would vanish in silence.
    const line = JSON.stringify({ format: ARCHIVE_FORMAT, version: ARCHIVE_VERSION + 1 })
    const read = readHeader(line)
    expect(read.ok).toBe(false)
    expect(read.ok === false && read.error).toMatch(/newer version of étude/)
    expect(read.ok === false && read.error).toMatch(/nothing has been imported/i)
  })

  it('refuses a file with no usable version', () => {
    for (const version of [undefined, 'one', 1.5, 0]) {
      const read = readHeader(JSON.stringify({ format: ARCHIVE_FORMAT, version }))
      expect(read.ok).toBe(false)
    }
  })

  it('every refusal says that nothing was imported', () => {
    // The natural fear on seeing an error from an import is that it got half way.
    const refusals = [
      readHeader('{}'),
      readHeader(JSON.stringify({ format: ARCHIVE_FORMAT, version: 99 })),
      readBodyLine(JSON.stringify({ t: 'wat', r: {} })),
      readBodyLine(JSON.stringify({ t: 'attempt', r: { gameId: 'g' } })),
    ]
    for (const read of refusals) {
      expect(read.ok).toBe(false)
      expect(read.ok === false && read.error).toMatch(/nothing has been imported/i)
    }
  })
})

describe('archive body lines', () => {
  it('round-trips a record and drops the auto-increment id', () => {
    const line = recordLine('attempt', { id: 7, gameId: 'g', sessionId: 's', createdAt: 1 })
    const read = readBodyLine(line)
    expect(read).toMatchObject({ ok: true, value: { t: 'attempt' } })
    expect(read.ok === true && read.value).not.toHaveProperty('r.id')
  })

  it('refuses a record type this version does not know', () => {
    // Within a version we know every table there is, so an unknown one means the
    // file is not what its header claims — and the header would still say 1.
    const read = readBodyLine(JSON.stringify({ t: 'skillModel', r: { x: 1 } }))
    expect(read.ok).toBe(false)
    expect(read.ok === false && read.error).toMatch(/does not know/)
  })

  it('refuses a record it could not file, rather than dropping it', () => {
    const read = readBodyLine(JSON.stringify({ t: 'dbAnalysis', r: { evalByPly: [] } }))
    expect(read.ok).toBe(false)
    expect(read.ok === false && read.error).toMatch(/missing its key/)
  })

  it('does not validate the rest of a row, so a new field is never an error', () => {
    // Stored records are forward-compatible: absent means "not recorded" and a
    // schema check would turn the next added field into a refused file.
    const read = readBodyLine(
      JSON.stringify({ t: 'game', r: { gameId: 'g', sanHistory: [], somethingNew: 42 } }),
    )
    expect(read.ok).toBe(true)
    expect(read.ok === true && (read.value as { r: Record<string, unknown> }).r.somethingNew).toBe(42)
  })

  it('reads the footer and its counts', () => {
    const counts = { ...emptyCounts(), attempt: 3, dbGame: 12 }
    const read = readBodyLine(footerLine(counts))
    expect(read).toMatchObject({ ok: true, value: { end: ARCHIVE_FORMAT, counts } })
  })

  it('brings a sparse evalByPly back as gaps, not as nulls', () => {
    // `evalByPly` is deliberately sparse — a gap is a position the pass could not
    // score and must stay distinguishable from a score of zero — and JSON has no
    // hole, so stringify writes null.
    const sparse: (unknown | undefined)[] = []
    sparse[2] = { whitePct: 55, label: '+0.3' }
    const read = readBodyLine(recordLine('game', { gameId: 'g', sanHistory: [], evalByPly: sparse }))
    expect(read.ok).toBe(true)
    const evals = read.ok === true ? ((read.value as unknown as { r: { evalByPly: unknown[] } }).r.evalByPly) : []
    expect(evals).toHaveLength(3)
    expect(evals[0]).toBeUndefined()
    expect(evals[1]).toBeUndefined()
    expect(evals[2]).toMatchObject({ whitePct: 55 })
  })

  it('keeps a null on an object property, because that one means something', () => {
    // `CoachEntry.bestMoveSan` is `string | null` — "the engine offered no best
    // move" is not the same as "not recorded".
    const read = readBodyLine(
      recordLine('game', {
        gameId: 'g',
        sanHistory: ['e4'],
        coachLog: [{ ply: 0, san: 'e4', bestMoveSan: null }],
      }),
    )
    const log = read.ok === true ? (read.value as unknown as { r: { coachLog: { bestMoveSan: unknown }[] } }).r.coachLog : []
    expect(log[0]?.bestMoveSan).toBeNull()
  })
})

// ---------- identity ----------

describe('canonicalJson', () => {
  it('does not depend on the order the keys happen to be in', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }))
    expect(canonicalJson({ a: { y: 1, x: 2 } })).toBe(canonicalJson({ a: { x: 2, y: 1 } }))
  })

  it('treats an absent field and an undefined one as the same thing', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }))
  })

  it('is stable across the trip through JSON, holes and all', () => {
    const sparse: unknown[] = []
    sparse[1] = 'x'
    const before = canonicalJson({ list: sparse })
    const after = canonicalJson(JSON.parse(JSON.stringify({ list: sparse })))
    expect(after).toBe(before)
  })
})

describe('attempt identity', () => {
  const attempt = {
    id: 4,
    gameId: 'opera',
    sessionId: 's1',
    createdAt: 1000,
    itemIndex: 3,
    moveNumber: 12,
    sideToMove: 'w',
    fen: 'fen',
    userMoveSan: 'Nf3',
    masterMoveSan: 'Bc4',
    reason: 'develops with tempo',
    tier: 'B',
    swing: 4.2,
  }

  it('ignores the auto-increment id, which means nothing on another machine', () => {
    expect(attemptIdentity(attempt)).toBe(attemptIdentity({ ...attempt, id: 99 }))
    expect(attemptIdentity(attempt)).toBe(attemptIdentity({ ...attempt, id: undefined }))
  })

  it('separates two attempts that differ by one character of the typed reason', () => {
    // The reasons are the part of this data with no other source anywhere, so the
    // identity errs towards keeping both rather than collapsing them.
    expect(attemptIdentity({ ...attempt, reason: 'develops with tempo.' })).not.toBe(
      attemptIdentity(attempt),
    )
  })

  it('separates two attempts at the same item in the same session', () => {
    expect(attemptIdentity({ ...attempt, userMoveSan: 'Bc4' })).not.toBe(attemptIdentity(attempt))
  })

  it('survives the round trip through the file', () => {
    const line = recordLine('attempt', attempt)
    const read = readBodyLine(line)
    expect(read.ok).toBe(true)
    expect(attemptIdentity(read.ok === true ? (read.value as { r: object }).r : {})).toBe(
      attemptIdentity(attempt),
    )
  })
})

// ---------- played games ----------

describe('placing a played game', () => {
  const here = { gameId: 'm1000', createdAt: 1000, sanHistory: ['e4', 'e5'] }

  it('merges onto the row that is the same game', () => {
    const placed = placeGame(here, (id) => (id === 'm1000' ? here : undefined))
    expect(placed).toMatchObject({ gameId: 'm1000', onto: here, renamed: false })
  })

  it('lands beside a different game that happens to share the id', () => {
    // `gameId` is `m${Date.now()}`: unique on one machine, not across two. A
    // merge that trusted it would overwrite one game with the other, which is
    // the single thing an import is forbidden to do.
    const other = { gameId: 'm1000', createdAt: 1000, sanHistory: ['d4', 'd5'] }
    const placed = placeGame(other, (id) => (id === 'm1000' ? here : undefined))
    expect(placed.gameId).toBe('m1000~1')
    expect(placed.renamed).toBe(true)
    expect(placed.onto).toBeUndefined() // beside it, never on top of it
  })

  it('finds its own renamed row the second time, so a re-import adds nothing', () => {
    const other = { gameId: 'm1000', createdAt: 1000, sanHistory: ['d4', 'd5'] }
    const stored: Record<string, typeof here> = { m1000: here, 'm1000~1': { ...other, gameId: 'm1000~1' } }
    const placed = placeGame(other, (id) => stored[id])
    expect(placed.gameId).toBe('m1000~1')
    expect(placed.onto).toBeDefined()
  })

  it('tells two games apart by when they were played and what was played', () => {
    expect(sameGame(here, { ...here, createdAt: 1001 })).toBe(false)
    expect(sameGame(here, { ...here, sanHistory: ['e4', 'c5'] })).toBe(false)
    expect(sameGame(here, { ...here, gameId: 'anything' })).toBe(true)
  })
})

// ---------- analysis ----------

describe('which analysis wins', () => {
  const complete = (nodes: number) => ({ analysedAt: 1, analysisNodes: nodes, evalByPly: [1] })
  const partial = (nodes: number) => ({ analysisNodes: nodes, evalByPly: [1] })

  it('never lets an empty record replace real engine work', () => {
    expect(analysisWins(complete(400_000), undefined)).toBe(false)
    expect(analysisWins(complete(400_000), {})).toBe(false)
    expect(hasAnalysis({})).toBe(false)
  })

  it('takes work where there was none', () => {
    expect(analysisWins(undefined, complete(250_000))).toBe(true)
    expect(analysisWins({}, partial(250_000))).toBe(true)
  })

  it('prefers a completed pass to an unfinished deeper one', () => {
    expect(analysisWins(partial(4_000_000), complete(250_000))).toBe(true)
    expect(analysisWins(complete(250_000), partial(4_000_000))).toBe(false)
  })

  it('prefers the deeper of two completed passes', () => {
    expect(analysisWins(complete(400_000), complete(4_000_000))).toBe(true)
    expect(analysisWins(complete(4_000_000), complete(400_000))).toBe(false)
  })

  it('keeps what is here when the two are equal, which is what makes a re-import a no-op', () => {
    expect(analysisWins(complete(400_000), complete(400_000))).toBe(false)
    expect(analysisWins(partial(400_000), partial(400_000))).toBe(false)
  })

  it('agrees with gameAnalysis.supersedes about what a deeper pass means', () => {
    // #144 hangs `supersedes` off `analysisNodes`, so an import that lost the
    // budget would make a 4M off-app pass look like a 400k one. The two rules
    // read the same field the same way, and this says so.
    const deep = complete(4_000_000)
    const shallow = complete(400_000)
    expect(supersedes(deep, 400_000)).toBe(true)
    expect(supersedes(shallow, 4_000_000)).toBe(false)
    expect(analysisWins(shallow, deep)).toBe(true)
    // A partial pass supersedes nothing, and loses the merge to a completed one.
    expect(supersedes(partial(4_000_000), 400_000)).toBe(false)
    expect(analysisWins(partial(4_000_000), shallow)).toBe(true)
  })
})

describe('whether an analysis is about the game it is filed against', () => {
  it('rejects a pass computed from a different starting position', () => {
    // #133's trap: the dedup key hashes movetext but not the [FEN] tag, so a
    // study collection can put a different game under the same key.
    expect(analysisApplies({ startFen: '8/8/8/8/8/8/8/K1k5 w - - 0 1' }, { startFen: undefined })).toBe(
      false,
    )
    expect(analysisApplies({ startFen: undefined }, { startFen: '8/8/8/8/8/8/8/K1k5 w - - 0 1' })).toBe(
      false,
    )
  })

  it('accepts one from the same position, standard or not', () => {
    expect(analysisApplies({ startFen: undefined }, { startFen: undefined })).toBe(true)
    expect(analysisApplies({ startFen: 'x' }, { startFen: 'x' })).toBe(true)
  })

  it('does not call a game we do not have a mismatch', () => {
    // The file may be attached later, and the row is checked again on read.
    expect(analysisApplies({ startFen: 'x' }, undefined)).toBe(true)
  })
})

// ---------- reporting ----------

describe('the merge report', () => {
  it('knows a second import of the same file changed nothing', () => {
    const report = emptyReport()
    report.sections.attempt.unchanged = 412
    report.sections.dbGame.unchanged = 41_238
    expect(changedNothing(report)).toBe(true)
    report.sections.attempt.added = 1
    expect(changedNothing(report)).toBe(false)
  })
})

describe('sizing a section before it is written', () => {
  it('scales a sample of real rows up to the whole table', () => {
    const size = estimateSection(1000, [100, 200, 300], 3)
    expect(size).toEqual({ rows: 1000, bytes: 200_000, exact: false })
  })

  it('is exact when every row was measured', () => {
    expect(estimateSection(2, [10, 20], 2)).toEqual({ rows: 2, bytes: 30, exact: true })
  })

  it('is zero and exact over nothing', () => {
    expect(estimateSection(0, [], 0)).toEqual({ rows: 0, bytes: 0, exact: true })
  })
})
