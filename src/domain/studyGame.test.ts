import { describe, it, expect } from 'vitest'
import {
  annotationAt,
  planStudy,
  studyBlurb,
  studySides,
  studyPgn,
  studyTitle,
  type DatabaseGame,
} from './studyGame'
import { parseGame } from './harness'

// The mapping from a stored database row into a game the guess session can run
// (#55, plan §11). Everything here is our own mapping — the session machine is
// tested in app/sessionMachine.test.ts and is not re-tested through this.

const MORPHY =
  'e4 e5 Nf3 d6 d4 Bg4 dxe5 Bxf3 Qxf3 dxe5 Bc4 Nf6 Qb3 Qe7 Nc3 c6 Bg5 b5 Nxb5 cxb5 ' +
  'Bxb5+ Nbd7 O-O-O Rd8 Rxd7 Rxd7 Rd1 Qe6 Bxd7+ Nxd7 Qb8+ Nxb8 Rd8#'

const row = (patch: Partial<DatabaseGame> = {}): DatabaseGame => ({
  key: 'morphy-key',
  white: 'Paul Morphy',
  black: 'Duke Karl / Count Isouard',
  event: 'Paris Opera',
  date: '1858.??.??',
  year: 1858,
  result: '1-0',
  movetext: MORPHY,
  source: 'sample.pgn',
  ...patch,
})

/** A legal game of any length: the knights walk out and back. */
const shuffle = (plies: number) =>
  Array.from({ length: plies }, (_, i) => ['Nc3', 'Nc6', 'Nb1', 'Nb8'][i % 4]!).join(' ')

describe('naming an imported game', () => {
  it('titles it from the players, the event and the year', () => {
    expect(studyTitle(row())).toBe(
      'Paul Morphy vs Duke Karl / Count Isouard, Paris Opera 1858',
    )
  })

  it('leaves out what the file never said rather than leaving a hole', () => {
    expect(studyTitle(row({ event: undefined, year: undefined }))).toBe(
      'Paul Morphy vs Duke Karl / Count Isouard',
    )
    expect(studyTitle(row({ event: undefined }))).toBe(
      'Paul Morphy vs Duke Karl / Count Isouard, 1858',
    )
  })

  it('says in the blurb what the game was and where it came from', () => {
    expect(studyBlurb(row())).toBe('White won · 17 moves · from sample.pgn')
    expect(studyBlurb(row({ result: '1/2-1/2' }))).toMatch(/^Drawn · /)
    expect(studyBlurb(row({ result: '*' }))).toMatch(/^No result recorded · /)
  })
})

describe('rebuilding a PGN from a stored row', () => {
  it('round-trips the stored movetext through the parser the session uses', () => {
    const parsed = parseGame(studyPgn(row()))
    expect(parsed.sanMoves).toEqual(MORPHY.split(' '))
    expect(parsed.result).toBe('1-0')
    expect(parsed.white).toBe('Paul Morphy')
  })

  it('survives a name containing a quote, which PGN tags have no escape for', () => {
    // chess.js' tag grammar rejects `\"` outright and the failure is total —
    // the whole game stops parsing, not just that tag. A player or event named
    // with a double quote is rare and a database full of them is not, so the
    // character is replaced rather than escaped.
    const quoted = row({ white: 'He said "check"', event: 'The \\ Open' })
    const parsed = parseGame(studyPgn(quoted))
    expect(parsed.sanMoves.length).toBe(33)
    expect(parsed.white).not.toContain('"')
  })
})

describe('whose side you take', () => {
  it('takes the winner’s side of a decisive game, as the curated pack does', () => {
    expect(studySides('1-0')).toEqual(['w'])
    expect(studySides('0-1')).toEqual(['b'])
  })

  it('offers both sides — and picks neither — when there is no winner', () => {
    // The failure this pins: falling back to White would quietly quiz you as
    // White for every drawn game in a database, which is most of the strong ones.
    expect(studySides('1/2-1/2')).toEqual(['w', 'b'])
    expect(studySides('*')).toEqual(['w', 'b'])
    expect(studySides('')).toEqual(['w', 'b'])
  })
})

describe('planning a study session', () => {
  it('builds a game the session can run, from the side asked for', () => {
    const plan = planStudy(row(), 'w')
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.positions).toBe(13)
    expect(plan.game.heroColor).toBe('w')
    expect(plan.game.id).toContain('morphy-key')
    expect(plan.game.title).toBe(studyTitle(row()))
  })

  it('plans either side of a drawn game, and the two differ', () => {
    const drawn = row({ result: '1/2-1/2' })
    const white = planStudy(drawn, 'w')
    const black = planStudy(drawn, 'b')
    expect(white.ok && white.positions).toBeGreaterThan(0)
    expect(black.ok && black.positions).toBeGreaterThan(0)
    expect(white.ok && white.game.heroColor).toBe('w')
    expect(black.ok && black.game.heroColor).toBe('b')
  })

  it('reports how many positions a long game will ask for rather than capping it', () => {
    // A database row is whatever was in the file. A 100-move game is a long
    // session, not a broken one — so the count is stated and the user decides.
    const plan = planStudy(row({ movetext: shuffle(200), result: '*' }), 'w')
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.positions).toBeGreaterThan(90)
  })
})

describe('games that cannot be studied', () => {
  it('refuses a record with no moves', () => {
    expect(planStudy(row({ movetext: '' }), 'w')).toEqual({ ok: false, reason: 'no-moves' })
  })

  it('refuses moves that do not replay, instead of throwing at the session', () => {
    // An import stores movetext as text and deliberately never replays it
    // (docs/spikes/games-corpus.md §5), so illegality is discovered here — and
    // if it were discovered inside the reducer it would take the screen with it.
    expect(planStudy(row({ movetext: 'e4 e5 Nf6 d5' }), 'w')).toEqual({
      ok: false,
      reason: 'unreadable',
    })
    expect(planStudy(row({ movetext: 'not a game at all' }), 'w')).toEqual({
      ok: false,
      reason: 'unreadable',
    })
  })

  it('refuses a game that is over before the quiz would start', () => {
    expect(planStudy(row({ movetext: 'f3 e5 g4 Qh4#', result: '0-1' }), 'w')).toEqual({
      ok: false,
      reason: 'no-decisions',
    })
  })

  it('refuses a side that never gets a move past the opening cutoff', () => {
    // Black is mated on ply 3 here, so Black has no decision to be quizzed on.
    expect(planStudy(row({ movetext: 'f3 e5 g4 Qh4#', result: '0-1' }), 'b')).toEqual({
      ok: false,
      reason: 'no-decisions',
    })
  })
})

describe('annotations that came with the file', () => {
  it('carries the file’s comments, attributed to the file they came from', () => {
    const plan = planStudy(row({ comments: { 8: 'Recaptures and keeps the initiative.' } }), 'w')
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.game.annotations).toEqual({
      byPly: { 8: 'Recaptures and keeps the initiative.' },
      source: 'sample.pgn',
    })
  })

  it('carries none at all for a game the file did not annotate', () => {
    // Absent rather than empty: a reveal must be able to ask "is there a note?"
    // and get the same answer for a game with no comments as for a pack game.
    const plan = planStudy(row(), 'w')
    expect(plan.ok && plan.game.annotations).toBeUndefined()
    expect(plan.ok && annotationAt(plan.game, 8)).toBeNull()
  })

  it('hands back a note only at its own ply, and never without its source', () => {
    const game = { annotations: { byPly: { 8: 'The point.' }, source: 'mygames.pgn' } }
    expect(annotationAt(game, 8)).toEqual({ text: 'The point.', source: 'mygames.pgn' })
    expect(annotationAt(game, 9)).toBeNull()
    expect(annotationAt({}, 8)).toBeNull()
  })

  it('ignores a comment that is only whitespace', () => {
    expect(annotationAt({ annotations: { byPly: { 8: '   ' }, source: 'f.pgn' } }, 8)).toBeNull()
  })
})

describe('a game that does not start from move 1', () => {
  // Studies, endgame collections and puzzle sets carry a SetUp/FEN pair, and
  // many carry no Variant tag at all — so the variant check never sees them and
  // they import like any other game. Discarding the position made the movetext
  // replay from the standard start: usually illegal at once and reported as
  // "unreadable", occasionally legal and quietly a different game.
  const ENDGAME = '8/8/8/4k3/8/8/4KP2/8 w - - 0 1'
  const ENDGAME_MOVES = 'Ke1 Ke6 Ke2 Ke5 Ke1 Ke6 Ke2 Ke5 f4+ Kd5 f5 Ke5 f6 Kxf6'
  const fromFen = (patch: Partial<DatabaseGame> = {}) =>
    row({ startFen: ENDGAME, movetext: ENDGAME_MOVES, ...patch })

  it('writes SetUp and FEN, which is the pair chess.js reads', () => {
    const pgn = studyPgn(fromFen())
    expect(pgn).toContain('[SetUp "1"]')
    expect(pgn).toContain(`[FEN "${ENDGAME}"]`)
  })

  it('replays from that position rather than from the initial one', () => {
    // Every one of these moves is illegal from the standard start, so parsing
    // at all is the assertion — before the FEN was stored this threw.
    const parsed = parseGame(studyPgn(fromFen()))
    expect(parsed.sanMoves).toEqual(ENDGAME_MOVES.split(' '))
    expect(parsed.headers.FEN).toBe(ENDGAME)
  })

  it('is studiable rather than refused', () => {
    // Before the FEN was stored this failed as 'unreadable', blaming the file
    // for what import had thrown away.
    expect(planStudy(fromFen(), 'w').ok).toBe(true)
  })

  it('says nothing about a start position for an ordinary game', () => {
    const pgn = studyPgn(row())
    expect(pgn).not.toContain('SetUp')
    expect(pgn).not.toContain('FEN')
  })
})
