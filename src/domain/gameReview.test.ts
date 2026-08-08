import { describe, expect, it } from 'vitest'
import {
  chancesGiven,
  parseTimeControl,
  reviewGame,
  secondsPerMove,
  summariseByPhase,
  type PositionEval,
  type ReviewedMove,
} from './gameReview'

const cp = (value: number): PositionEval => ({ kind: 'eval', score: { type: 'cp', value } })
const over = (result: 'checkmate' | 'draw'): PositionEval => ({ kind: 'over', result })

describe('reading the time control off a PGN', () => {
  it('takes a start and an increment', () => {
    expect(parseTimeControl('900+10')).toEqual({ startSeconds: 900, incrementSeconds: 10 })
  })

  it('treats a missing increment as zero', () => {
    expect(parseTimeControl('600')).toEqual({ startSeconds: 600, incrementSeconds: 0 })
  })

  it("refuses chess.com's correspondence form rather than misreading it", () => {
    // "1/259200" is three days *per move*, not a game budget. Reading the 1 as a
    // starting clock would make every move look like a colossal think.
    expect(parseTimeControl('1/259200')).toBeNull()
    expect(parseTimeControl('nonsense')).toBeNull()
  })
})

describe('turning clock readings into time spent', () => {
  const tc = { startSeconds: 900, incrementSeconds: 10 }

  it('measures against the same side two plies back, not the opponent one ply back', () => {
    // The opening of the real game: 1. e4 c6 2. Bc4 d5.
    const spent = secondsPerMove([899.3, 907.9, 901.8, 915.4], tc)
    expect(spent[0]!).toBeCloseTo(10.7, 5) // 900 + 10 − 899.3
    expect(spent[1]!).toBeCloseTo(2.1, 5) // 900 + 10 − 907.9
    expect(spent[2]!).toBeCloseTo(7.5, 5) // 899.3 + 10 − 901.8, White's own previous
    expect(spent[3]!).toBeCloseTo(2.5, 5) // 907.9 + 10 − 915.4
  })

  it('reports nothing rather than guessing when a reading is missing', () => {
    expect(secondsPerMove([899.3, null, 901.8, 915.4], tc)[3]).toBeNull()
    expect(secondsPerMove([null], tc)[0]).toBeNull()
  })

  it('never reports negative time', () => {
    // A clock rounded up a tenth can outrun the arithmetic on an instant move.
    expect(secondsPerMove([910.4], tc)[0]).toBe(0)
  })
})

describe('grading every move of a finished game', () => {
  it('negates the evaluation after the move, because it is the opponent to play', () => {
    // Equal before; +300 for the opponent after. That is −300 for the mover, and
    // reading it unnegated would score a blunder as a brilliancy.
    const rows = reviewGame({ sans: ['Nf3'], positions: [cp(0), cp(300)], myColor: 'w' })
    expect(rows[0]!.before).toBeCloseTo(50, 4)
    expect(rows[0]!.after).toBeCloseTo(24.89, 1)
    expect(rows[0]!.swing).toBeCloseTo(25.11, 1)
    expect(rows[0]!.tier).toBe('C')
  })

  it('gives full credit to a move that holds the evaluation', () => {
    const rows = reviewGame({ sans: ['Nf3'], positions: [cp(0), cp(0)], myColor: 'w' })
    expect(rows[0]!.swing).toBe(0)
    expect(rows[0]!.tier).toBe('A')
  })

  it('never scores a move as better than best', () => {
    // The opponent's reply can be worse than expected; that is not the mover's credit.
    const rows = reviewGame({ sans: ['Nf3'], positions: [cp(0), cp(-300)], myColor: 'w' })
    expect(rows[0]!.swing).toBe(0)
  })

  it('grades a mating move on the mate, not on an evaluation that does not exist', () => {
    const rows = reviewGame({ sans: ['Qh7#'], positions: [cp(900), over('checkmate')], myColor: 'w' })
    expect(rows[0]!.after).toBe(100)
    expect(rows[0]!.swing).toBe(0)
    expect(rows[0]!.tier).toBe('A')
  })

  it('scores a move into a draw as a half point, so throwing a win shows up', () => {
    const rows = reviewGame({ sans: ['Qg6'], positions: [cp(900), over('draw')], myColor: 'w' })
    expect(rows[0]!.after).toBe(50)
    expect(rows[0]!.tier).toBe('C')
  })

  it('marks whose moves are whose, and numbers them from White', () => {
    const rows = reviewGame({
      sans: ['e4', 'c6', 'Bc4'],
      positions: [cp(0), cp(0), cp(0), cp(0)],
      myColor: 'b',
    })
    expect(rows.map((r) => [r.moveNumber, r.color, r.mine])).toEqual([
      [1, 'w', false],
      [1, 'b', true],
      [2, 'w', false],
    ])
  })

  it('expresses the eval curve from the reviewed side, whoever just moved', () => {
    // +200 for White to move is a 68% position; Black sees the same one as 32%.
    const rows = reviewGame({
      sans: ['e4', 'c6'],
      positions: [cp(200), cp(-200), cp(200)],
      myColor: 'b',
    })
    expect(rows[0]!.before).toBeCloseTo(67.6, 1)
    expect(rows[0]!.beforeMine).toBeCloseTo(32.4, 1) // White's move, seen from Black
    expect(rows[1]!.beforeMine).toBeCloseTo(rows[1]!.before, 5) // Black's own move
  })

  it('carries the engine preference and the clock through when given them', () => {
    const rows = reviewGame({
      sans: ['e4'],
      positions: [cp(0), cp(0)],
      myColor: 'w',
      best: ['d4'],
      seconds: [12.5],
    })
    expect(rows[0]!.best).toBe('d4')
    expect(rows[0]!.seconds).toBe(12.5)
  })

  it('leaves them null rather than inventing them when not given', () => {
    const rows = reviewGame({ sans: ['e4'], positions: [cp(0), cp(0)], myColor: 'w' })
    expect(rows[0]!.best).toBeNull()
    expect(rows[0]!.seconds).toBeNull()
  })

  it('rejects a positions array that does not line up with the moves', () => {
    // Off by one here would silently shift every grade onto the wrong move.
    expect(() => reviewGame({ sans: ['e4', 'c6'], positions: [cp(0), cp(0)], myColor: 'w' })).toThrow(
      /expected 3 positions for 2 moves/,
    )
  })

  it('does not grade a move made from a position the game already ended in', () => {
    const rows = reviewGame({
      sans: ['Qh7#', 'Kxh7'],
      positions: [cp(900), over('checkmate'), cp(0)],
      myColor: 'w',
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.san).toBe('Qh7#')
  })
})

describe('where the win% leaked, against where the time went', () => {
  const row = (moveNumber: number, swing: number, seconds: number | null): ReviewedMove => ({
    ply: moveNumber * 2 - 1,
    moveNumber,
    color: 'b',
    san: '--',
    mine: true,
    before: 50,
    after: 50 - swing,
    swing,
    tier: 'A',
    best: null,
    seconds,
    beforeMine: 50,
  })

  it('buckets by move number and reports a rate, not just a total', () => {
    // Phases of different lengths are only comparable per move.
    const summary = summariseByPhase([row(1, 2, 30), row(16, 4, 30), row(31, 6, 5), row(40, 10, 5)])
    expect(summary.map((p) => [p.name, p.moves, p.swing])).toEqual([
      ['opening', 1, 2],
      ['middlegame', 1, 4],
      ['endgame', 2, 16],
    ])
    expect(summary[2]!.swingPerMove).toBe(8)
    expect(summary[2]!.secondsPerMove).toBe(5)
  })

  it('runs the last phase to the end of the game', () => {
    expect(summariseByPhase([row(120, 1, 1)])[2]!.moves).toBe(1)
  })

  it('withholds the time column when any move in the phase lacks a clock', () => {
    // A partial sum would read as a real total and understate the thinking time.
    const summary = summariseByPhase([row(1, 2, 30), row(2, 2, null)])
    expect(summary[0]!.seconds).toBeNull()
    expect(summary[0]!.secondsPerMove).toBeNull()
    expect(summary[0]!.swing).toBe(4)
  })

  it('reports an empty phase as zero rather than dividing by it', () => {
    const summary = summariseByPhase([row(1, 2, 30)])
    expect(summary[1]!).toMatchObject({ moves: 0, swing: 0, swingPerMove: 0, secondsPerMove: null })
  })
})

describe('the chances the opponent handed over', () => {
  it('pairs each of their blunders with what was actually played next', () => {
    // A punished blunder and a let-off are indistinguishable in a swing table.
    const rows = reviewGame({
      sans: ['e4', 'c6', 'Qh5', 'Nf6'],
      positions: [cp(0), cp(0), cp(0), cp(400), cp(-400)],
      myColor: 'b',
    })
    const chances = chancesGiven(rows)
    expect(chances).toHaveLength(1)
    expect(chances[0]!.blunder.san).toBe('Qh5')
    expect(chances[0]!.reply?.san).toBe('Nf6')
  })

  it('leaves the reply absent when the blunder ended the game', () => {
    const rows = reviewGame({ sans: ['Kf1'], positions: [cp(0), cp(900)], myColor: 'b' })
    expect(chancesGiven(rows)[0]!.reply).toBeNull()
  })

  it("ignores the reviewed player's own blunders", () => {
    const rows = reviewGame({ sans: ['e4'], positions: [cp(0), cp(400)], myColor: 'w' })
    expect(chancesGiven(rows)).toEqual([])
  })
})
