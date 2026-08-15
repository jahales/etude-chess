import { describe, it, expect } from 'vitest'
import {
  DEFAULT_IMPORT_FILTERS,
  dedupKey,
  describeGame,
  filterGame,
  normalizeGame,
  parseTimeControl,
  SKIP_REASON_LABEL,
  type ImportedGame,
  type ParsedPgnGame,
  type ParsedPgnNodeData,
} from './pgnImport'

// ---------- fixtures ----------
//
// These build the *shape* chessops' parser emits, by hand. The point is to test
// our mapping, not chessops (docs/v0.3.0-plan.md §9): a fixture here is a
// statement of the contract we consume, so if chessops ever changes shape the
// content-layer test that feeds it real PGN text is what fails, not this file.

function node(data: ParsedPgnNodeData) {
  return { data }
}

function parsed(
  headers: Record<string, string>,
  moves: (string | ParsedPgnNodeData)[],
  gameComments?: string[],
): ParsedPgnGame {
  const nodes = moves.map((m) => node(typeof m === 'string' ? { san: m } : m))
  return {
    headers: new Map(Object.entries(headers)),
    comments: gameComments,
    moves: { mainlineNodes: () => nodes },
  }
}

const CLASSIC = {
  Event: 'Hastings',
  Site: 'Hastings ENG',
  Date: '1895.08.17',
  White: 'Steinitz, William',
  Black: 'von Bardeleben, Curt',
  Result: '1-0',
  WhiteElo: '2600',
  BlackElo: '2550',
  TimeControl: '5400+30',
  ECO: 'C54',
}

const LONG_GAME: string[] = Array.from({ length: 40 }, (_, i) => (i % 2 ? 'e5' : 'e4'))

function game(headers: Record<string, string> = CLASSIC, sanMoves = LONG_GAME): ImportedGame {
  return { headers, sanMoves }
}

// ---------- normaliser ----------

describe('normalizeGame — chessops parse tree → our own type', () => {
  it('maps headers and the mainline SAN', () => {
    const g = normalizeGame(parsed(CLASSIC, ['e4', 'e5', 'Nf3']))

    expect(g.headers.White).toBe('Steinitz, William')
    expect(g.headers.ECO).toBe('C54')
    expect(g.sanMoves).toEqual(['e4', 'e5', 'Nf3'])
  })

  it('keeps comments, keyed by the ply they sit on', () => {
    // ADR 0018 §3: annotations in a user's own file are preserved, not stripped.
    const g = normalizeGame(
      parsed(CLASSIC, [
        'e4',
        { san: 'e5', comments: ['Black accepts the open game.'] },
        { san: 'Nf3', comments: ['The main line.', 'Also playable: Bc4.'] },
      ]),
    )

    expect(g.comments?.[0]).toBeUndefined()
    expect(g.comments?.[1]).toBe('Black accepts the open game.')
    // Several comments on one move are joined rather than losing all but one.
    expect(g.comments?.[2]).toBe('The main line. Also playable: Bc4.')
  })

  it('keeps a comment written before a move on that move', () => {
    // `{ ... } 12. Rxe7` — chessops files this as a *starting* comment on Rxe7.
    const g = normalizeGame(parsed(CLASSIC, ['e4', { san: 'e5', startingComments: ['Diagram.'] }]))
    expect(g.comments?.[1]).toBe('Diagram.')
  })

  it('keeps NAGs by ply', () => {
    const g = normalizeGame(parsed(CLASSIC, ['e4', { san: 'e5', nags: [2, 14] }]))
    expect(g.nags?.[1]).toEqual([2, 14])
  })

  it('omits the comment and NAG maps entirely when there are none', () => {
    // These travel to storage with every game; an empty object per game is 100k
    // objects that say nothing on a large import.
    const g = normalizeGame(parsed(CLASSIC, ['e4', 'e5']))
    expect(g.comments).toBeUndefined()
    expect(g.nags).toBeUndefined()
  })

  it('drops the "?" placeholders the PGN standard uses for unknown tags', () => {
    // We keep "unknown" as *absent* so a filter can tell it apart from a value,
    // rather than storing the literal "?" and having each reader re-learn it.
    const g = normalizeGame(parsed({ White: '?', Black: 'Lasker', Date: '????.??.??' }, ['e4']))
    expect(g.headers.White).toBeUndefined()
    expect(g.headers.Date).toBeUndefined()
    expect(g.headers.Black).toBe('Lasker')
  })

  it('survives a game with no moves at all', () => {
    const g = normalizeGame(parsed(CLASSIC, []))
    expect(g.sanMoves).toEqual([])
  })
})

// ---------- derived facts ----------

describe('describeGame', () => {
  it('reads the players, year, result and ECO', () => {
    const facts = describeGame(game())
    expect(facts.white).toBe('Steinitz, William')
    expect(facts.black).toBe('von Bardeleben, Curt')
    expect(facts.year).toBe(1895)
    expect(facts.result).toBe('1-0')
    expect(facts.eco).toBe('C54')
  })

  it('reports the *lower* of the two ratings, which is what a minimum filters on', () => {
    expect(describeGame(game()).minElo).toBe(2550)
  })

  it('leaves the rating unknown when either player has none', () => {
    const { WhiteElo: _drop, ...noWhiteElo } = CLASSIC
    expect(describeGame(game(noWhiteElo)).minElo).toBeUndefined()
    expect(describeGame(game(noWhiteElo)).blackElo).toBe(2550)
  })

  it('counts plies and full moves', () => {
    const facts = describeGame(game(CLASSIC, ['e4', 'e5', 'Nf3']))
    expect(facts.plies).toBe(3)
    expect(facts.fullMoves).toBe(2) // a game ending on White's move still reached move 2
  })

  it('takes the year from a partial date, and reports none from a malformed one', () => {
    expect(describeGame(game({ ...CLASSIC, Date: '1972.??.??' })).year).toBe(1972)
    expect(describeGame(game({ ...CLASSIC, Date: 'last tuesday' })).year).toBeUndefined()
  })

  it('normalises an unrecognised result to "*" rather than inventing one', () => {
    expect(describeGame(game({ ...CLASSIC, Result: 'gibberish' })).result).toBe('*')
    expect(describeGame(game({ ...CLASSIC, Result: '1/2-1/2' })).result).toBe('1/2-1/2')
  })

  it('names an unknown player rather than leaving the field blank', () => {
    const { White: _drop, ...noWhite } = CLASSIC
    expect(describeGame(game(noWhite)).white).toBe('Unknown')
  })
})

// ---------- time control ----------

describe('parseTimeControl', () => {
  it('reads seconds plus increment', () => {
    expect(parseTimeControl('300+3')).toMatchObject({ baseSeconds: 300, incrementSeconds: 3 })
  })

  it('reads a bare base', () => {
    expect(parseTimeControl('600')).toMatchObject({ baseSeconds: 600, speed: 'rapid' })
  })

  it('reads the moves/seconds form and the first of several periods', () => {
    expect(parseTimeControl('40/9000')).toMatchObject({ baseSeconds: 9000, speed: 'classical' })
    expect(parseTimeControl('40/7200:1800+30')).toMatchObject({ baseSeconds: 7200 })
  })

  it('reads a sandclock', () => {
    expect(parseTimeControl('*180')).toMatchObject({ baseSeconds: 180, speed: 'blitz' })
  })

  it('classifies by base seconds alone, which is the rule we can explain', () => {
    expect(parseTimeControl('60').speed).toBe('bullet')
    expect(parseTimeControl('179').speed).toBe('bullet')
    expect(parseTimeControl('180').speed).toBe('blitz')
    expect(parseTimeControl('599').speed).toBe('blitz')
    expect(parseTimeControl('600').speed).toBe('rapid')
    expect(parseTimeControl('1499').speed).toBe('rapid')
    expect(parseTimeControl('1500').speed).toBe('classical')
    expect(parseTimeControl('86400').speed).toBe('correspondence')
  })

  it('marks an absent, unknown or unparseable control unknown — never a guess', () => {
    // ADR 0018 §4: "Where a PGN lacks TimeControl/Event detail we keep the game
    // but mark the control unknown rather than guessing."
    for (const raw of [undefined, '', '?', '-', 'about an hour']) {
      const tc = parseTimeControl(raw)
      expect(tc.speed).toBe('unknown')
      expect(tc.baseSeconds).toBeUndefined()
    }
  })

  it('keeps the raw string so the UI can show what the file actually said', () => {
    expect(parseTimeControl('40/7200:1800+30').raw).toBe('40/7200:1800+30')
  })

  it('names a speed from the event when there is no clock to read', () => {
    expect(parseTimeControl('?', 'World Blitz Championship').speed).toBe('blitz')
    expect(parseTimeControl(undefined, 'Rated Bullet game').speed).toBe('bullet')
    expect(parseTimeControl(undefined, 'FIDE Grand Prix').speed).toBe('unknown')
  })

  it('lets an explicit clock beat the event name', () => {
    // "Blitz Open" playing a classical schedule is odd, but the clock is data
    // and the name is prose. Prefer the data.
    expect(parseTimeControl('5400+30', 'Blitz Open').speed).toBe('classical')
  })
})

// ---------- filters ----------

describe('filterGame — defaults from docs/v0.3.0-plan.md §9', () => {
  const keep = (g: ImportedGame, filters = DEFAULT_IMPORT_FILTERS) =>
    filterGame(describeGame(g), filters)

  it('keeps a strong classical game', () => {
    expect(keep(game())).toEqual({ keep: true })
  })

  it('drops a game whose base time is under ten minutes', () => {
    expect(keep(game({ ...CLASSIC, TimeControl: '180+2' }))).toEqual({
      keep: false,
      reason: 'fast-time-control',
    })
  })

  it('drops a rapid game the clock alone would have let through, by its name', () => {
    // 600s is not under the 600s floor, so only the naming rule catches this —
    // which is why §9 asks for both.
    const rapid = game({ ...CLASSIC, TimeControl: '600+0', Event: 'Rated Rapid game' })
    expect(keep(rapid)).toEqual({ keep: false, reason: 'fast-time-control' })
  })

  it('keeps a game with no time control at all, marked unknown', () => {
    const { TimeControl: _drop, ...noTc } = CLASSIC
    expect(keep(game(noTc))).toEqual({ keep: true })
    expect(describeGame(game(noTc)).timeControl.speed).toBe('unknown')
  })

  it('drops a game below the minimum rating', () => {
    const weak = game({ ...CLASSIC, WhiteElo: '2600', BlackElo: '1400' })
    expect(keep(weak)).toEqual({ keep: false, reason: 'below-min-rating' })
  })

  it('keeps an unrated game rather than guessing at a rating', () => {
    const { WhiteElo: _w, BlackElo: _b, ...unrated } = CLASSIC
    expect(keep(game(unrated))).toEqual({ keep: true })
  })

  it('drops a stub', () => {
    expect(keep(game(CLASSIC, ['e4', 'e5', 'Nf3', 'Nc6']))).toEqual({
      keep: false,
      reason: 'too-short',
    })
  })

  it('drops a game with no moves', () => {
    expect(keep(game(CLASSIC, []))).toEqual({ keep: false, reason: 'no-moves' })
  })

  it('drops a non-standard variant, which we could not replay anyway', () => {
    expect(keep(game({ ...CLASSIC, Variant: 'Crazyhouse' }))).toEqual({
      keep: false,
      reason: 'variant',
    })
    expect(keep(game({ ...CLASSIC, Variant: 'Standard' }))).toEqual({ keep: true })
  })

  it('reports one reason in a fixed order when a game fails several', () => {
    // A four-ply blitz game is both too short and too fast. The reported reason
    // must not depend on evaluation order, or the same file would explain itself
    // differently on a refactor. Shape of the game first, then its conditions.
    const both = game({ ...CLASSIC, TimeControl: '60+0' }, ['e4', 'e5'])
    expect(keep(both)).toEqual({ keep: false, reason: 'too-short' })
  })

  it('honours overridden filters', () => {
    const blitz = game({ ...CLASSIC, TimeControl: '180+2' })
    const off = { ...DEFAULT_IMPORT_FILTERS, minBaseSeconds: 0, excludeFastSpeeds: false }
    expect(keep(blitz, off)).toEqual({ keep: true })

    const strict = { ...DEFAULT_IMPORT_FILTERS, minElo: 2700 }
    expect(keep(game(), strict)).toEqual({ keep: false, reason: 'below-min-rating' })
  })

  it('has a human label for every reason it can return', () => {
    for (const reason of Object.keys(SKIP_REASON_LABEL)) {
      expect(SKIP_REASON_LABEL[reason as keyof typeof SKIP_REASON_LABEL]).toBeTruthy()
    }
  })
})

// ---------- dedup ----------

describe('dedupKey', () => {
  it('is the same for the same game imported twice', () => {
    expect(dedupKey(game())).toBe(dedupKey(game()))
  })

  it('ignores case and stray whitespace in the names', () => {
    const messy = game({ ...CLASSIC, White: '  STEINITZ,   William ' })
    expect(dedupKey(messy)).toBe(dedupKey(game()))
  })

  it('separates two games that differ only after the opening', () => {
    const a = game(CLASSIC, ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'c3', 'Nf6', 'd4', 'exd4'])
    const b = game(CLASSIC, ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'c3', 'Nf6', 'd3', 'd6'])
    expect(dedupKey(a)).not.toBe(dedupKey(b))
  })

  it('separates two games identical through the opening but not beyond', () => {
    // This used to be the documented trade — the key ended at ten plies, so
    // these two collided and one silently overwrote the other. That reasoning
    // leaned on the *date* to discriminate, and an undated corpus has none.
    const prefix = LONG_GAME.slice(0, 10)
    const a = game(CLASSIC, [...prefix, 'Qh5'])
    const b = game(CLASSIC, [...prefix, 'Qf3'])
    expect(dedupKey(a)).not.toBe(dedupKey(b))
  })

  it('separates undated games of the same players out of the same opening', () => {
    // The case that made the old key lose games: a match collection with no
    // dates, one opening, several games. `normalizeGame` strips `????.??.??`,
    // so the date contributed nothing and the key was players + result + first
    // ten plies for every one of them.
    const undated = { White: 'Steinitz', Black: 'Zukertort', Result: '1-0' }
    const prefix = LONG_GAME.slice(0, 10)
    const keys = new Set(
      [['Qh5'], ['Qf3'], ['Be2'], ['O-O']].map((tail) => dedupKey(game(undated, [...prefix, ...tail]))),
    )
    expect(keys.size).toBe(4)
  })

  it('still treats the same game imported twice as one', () => {
    // The property the key exists for: re-attaching a file after an eviction
    // overwrites row for row rather than doubling the database.
    expect(dedupKey(game(CLASSIC, LONG_GAME))).toBe(dedupKey(game(CLASSIC, LONG_GAME)))
  })

  it('separates two games that differ only by event', () => {
    const base = dedupKey(game({ ...CLASSIC, Event: 'Hastings' }))
    expect(dedupKey(game({ ...CLASSIC, Event: 'London' }))).not.toBe(base)
  })

  it('separates games that differ in players, date or result', () => {
    const base = dedupKey(game())
    expect(dedupKey(game({ ...CLASSIC, Black: 'Lasker' }))).not.toBe(base)
    expect(dedupKey(game({ ...CLASSIC, Date: '1896.01.01' }))).not.toBe(base)
    expect(dedupKey(game({ ...CLASSIC, Result: '0-1' }))).not.toBe(base)
  })

  it('does not collide when a field is missing rather than different', () => {
    // "a|b|" and "a|" must not be the same key: a delimiter that can appear in
    // a name would let one game's fields spill into the next field.
    const { Date: _d, ...noDate } = CLASSIC
    expect(dedupKey(game(noDate))).not.toBe(dedupKey(game()))
  })
})
