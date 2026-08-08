---
name: game-review
description: Review one of the owner's finished chess games with Stockfish and coach from the result. Use when given a PGN, a chess.com game URL or id, or asked to look at "my last game" / "the game I just played". Covers running the engine passes, reading win% swing, WDL, per-piece values and tablebase output, and — importantly — what those numbers do not support saying.
---

# Reviewing one of the owner's games

The goal is not to list engine disagreements. It is to find the **one or two things
that would change the next game**, state them with evidence, and say honestly when
the evidence is thin.

## 1. Get the game

| you were given | do this |
|---|---|
| a chess.com URL or bare game id | `npm run review -- --me <user> <url>` |
| "my last game" | `npm run review -- --me <user> --last` |
| a pasted PGN | write it to the scratchpad, then `--pgn <file>` |
| a `.pgn` file path | `--pgn <path>` |

The owner's chess.com username is not stored in the repo — ask, or take it from
`$CHESSCOM_USER`. If a PGN was pasted, `--me` still has to match the `[White]` or
`[Black]` tag, which is not always the chess.com handle.

## 2. Run the two passes

```bash
npm run review -- --me <user> --last --deep
```

- The main pass grades **every** move by win% swing at 4M nodes/position
  (~2 min for a 50-move game, spread over a pool of single-threaded engines).
  Tier A ≤ 5, Tier B ≤ 15, Tier C above — the trainer's own scale,
  `src/domain/grade.ts`.
- `--deep` re-examines only the imperfect moves at 6M nodes: four alternatives
  with win/draw/loss, which piece changed value, and the tablebase verdict when
  the position is down to seven pieces.

Run the main pass first and read it before deciding whether `--deep` earns its
time. If the owner played a clean game, the deep pass has almost nothing to chew on.

For a position the owner asks about directly, skip the script and drive
`scripts/repertoire/engine.mjs` — `analyse(fen, {nodes, multipv})` and
`pieceValues(fen)`.

## 3. Read it in this order

**The phase-vs-clock table first.** It is the highest-value output and the thing
a move list cannot show: where the win% actually leaked, against where the time
went. A phase with a high per-move error rate and a low seconds-per-move is a
time-allocation problem, not a knowledge problem, and it is usually the most
actionable finding in the whole review.

**Then the opponent's chances.** A punished blunder and a let-off look identical
in a swing table. `chancesGiven` pairs each of their Tier C moves with the reply.

**Then the imperfect moves**, with the deep pass beside them. Each carries two
labels worth using rather than re-deriving:

- **TACTICAL vs positional** (`src/domain/mistakeKind.ts`, SEE). "Left 3 en prise
  on g5" and "the engine's move wins 5 more" are different lessons from "the plan
  was worse", and they point at different training. SEE only ever labels a
  finding the search already made — never treat it as evidence on its own, and
  note its blind spots: no x-rays, no pinned defenders.
- **breadth** — how many of the top five are within 5 win%. Three or more means
  the position was a choice, not a critical moment, and the owner should not be
  told they blundered a position where five moves were equal. Fewer than three
  means only one or two moves held, which is where their clock belongs.

  Breadth is measured in win%, so it **saturates in a decided position**: when
  everything wins, every move compresses near the top and breadth reads five out
  of five. That is not wrong — nothing was at stake — but it is not the whole
  story, and the material label is what still bites. On the reference game's
  move 34 the two read together as "no single move was critical, *and* you
  passed up winning a rook", which is the accurate account. Never let a wide
  breadth talk you out of a material finding.

## 4. What the numbers will not support

These are the ways this analysis has been got wrong before. All of them are easy
to fall into and each one produces a confident, wrong lesson.

- **Tier A is not a mistake.** It means engine-equal. Do not narrate a −3% move
  as an error; the tier boundaries exist precisely to stop that.
- **A swing in a decided position is not a swing in a close one.** Check the WDL.
  If it reads `1000/0/0` before and after, the move cost win% but never risked
  the result — say so plainly instead of implying the game hung on it.
- **Do not invent motifs.** "You always miss back-rank ideas" needs a base rate:
  how often does that pattern appear among *all* moves in that phase, not just
  the bad ones? Without the comparison it is pattern-matching on noise. A whole
  previous analysis of "forcing move" blindness collapsed under this test.
- **One game is one game.** Two Tier B moves are not a trend. Say what this game
  shows and, if a claim needs the season, run it over the archive instead.
- **Piece values are evidence, not verdict.** Stockfish's `eval` grid is roughly
  "how much worse without this piece", so it moves for reasons elsewhere on the
  board and two adjacent positions are not cleanly comparable. Read it across
  several moves before drawing a line — a single-move delta will mislead. It is
  at its best on a trade, where it prices both pieces: "the bishop you gave up
  was worth 4.65, the knight you took was worth 1.92" is a real explanation.
- **Do not lower the node budget to save time.** The failure is the other way
  round from what you would expect: measured on the reference game, 800k against
  4M gave *one false negative and zero phantoms* — a real Tier B move looked
  clean and would never have reached the deep pass — and understated the total
  win% given away by 10%. A cheap pass misses mistakes rather than inventing
  them, which is the worse direction for coaching. If a run must be shortened,
  shorten `--deep-nodes`, not `--nodes`. (Findings *do* also appear and vanish
  around 100k, so never quote a number from a quick run.)
- **The engine's top four being within 1–2% means the position was not critical.**
  That is why a site showed "lots of suggestions". The moments worth the owner's
  clock are where the list is tight *and their move is not on it*.

## 5. Repertoire context

The review says nothing about the opening book yet (issue #102 — it needs a
variation-aware PGN reader). Until then, if the opening matters, check by hand
against `repertoire/*.pgn` and say which branch the game followed and where it
left the book. The book's own comments carry the reason a line stops.

## 6. What to hand back

Lead with the single most useful finding, not a chronological walkthrough.
Then: what happened in the game, the one or two moments that mattered with the
concrete alternative, and — only if the evidence supports it — one thing to
work on. State the caveat inline rather than at the end; the owner would rather
have an honest small finding than an impressive shaky one.
