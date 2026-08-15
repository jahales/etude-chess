---
name: coach
description: Rank the owner's chess weaknesses across his whole chess.com archive and decide where his training time is worth spending. Use when asked "what are my biggest weaknesses", "what should I work on", "where am I losing the most", or anything else that needs the season rather than one game. Covers building the graded archive, reading the ranked report, and — the part that matters — the base-rate checks that decide whether a pattern is a finding or a coincidence.
---

# Coaching off the whole archive

`game-review` answers "what happened in that game". This answers the different
question the owner asks between sessions: *across everything I've played, what
are my biggest weaknesses, and where is my time worth spending?*

**The output of this skill is one or two things to work on, each with the
evidence and the base rate beside it.** A confident finding produced without a
base rate is worse than no finding at all — it costs weeks of training aimed at
noise. §4 is the part of this file to read twice; every rule in it changed or
killed a real conclusion on 2026-08-15.

## 1. Build the graded archive

```bash
node scripts/coach/archive.mjs --me <chess.com user> --limit 5   # try it
node scripts/coach/archive.mjs --me <chess.com user>             # the real run
```

The handle is not stored in the repo — ask, or take it from `$CHESSCOM_USER`.

Every move the owner played is graded at **4M nodes/position**, the same budget
`npm run review` uses, with the same rule (`gradeMove` on two evaluations from
the mover's perspective). That is what makes a number here comparable to a
number in a single-game review.

- **A full run is hours.** It is resumable per game — a crash costs the game in
  flight — so it is meant to be started and left. Do not offer to shorten it by
  lowering `--nodes`: measured on the reference game, a cheap pass errs by
  *missing* real mistakes and understated the win% given away by 10%. Run fewer
  games instead. Kicking off the full run is the owner's call, not yours.
- **`--time-class` defaults to `rapid,daily`** and analysing blitz means a
  separate run and a separate sample. See rule 1.
- Output is JSON-lines at `out/coach/archive.jsonl`, one line per game, and
  `out/` is gitignored. Re-running skips what is already there.

## 2. Read the report

```bash
npm run coach                              # everything in the archive
npm run coach -- --time-class rapid        # one class
npm run coach -- --phase middlegame        # narrow the base-rate check
```

Every table gives **moves, errors, rate, total win% lost, share of the total,
share of the moves, and per-move cost.** Read the last two together or not at
all — see rule 2b.

## 3. Read it in this order

**The ranking, by total win% given away.** This is the headline and it is
deliberately *not* error rate. "Where is my time worth spending" is frequency ×
severity: an endgame bucket losing 65 win% a move over six moves is dramatic and
costs a third of what the middlegame quietly costs over two hundred. Error rate
alone ranks the rare-and-dramatic above the common-and-expensive, which is
exactly the wrong advice to give someone with limited study time.

**Then `share` against `of moves`.** A bucket holding 33% of the loss and 33% of
the moves is not a weakness; it is a third of the game. The finding is in the
gap between the two columns, and `per move` is the size of that gap expressed in
a way that compares across bucket sizes.

**Then the base-rate check at the bottom** — "did you move the engine's piece?"
That block is the whole reason this skill exists; rule 2 is its story.

**Then the seconds-spent table**, which is printed in clock order rather than
ranked because the shape is its only content, and rule 3 for what the shape does
not mean.

Buckets marked `thin` hold fewer than 50 moves. Their rate is noise wearing a
percent sign — quote the total win% lost from them if you must, never the rate.

## 4. What the numbers will not support

Each of these either changed or killed a conclusion on 2026-08-15. They are not
hypothetical, and the wrong reading is the natural one in every case.

### 1. Never pool time controls

The archive at the time was **232 blitz** (all of July, ~840–880), **27 rapid**
(~1090–1220) and **17 daily** (~1449–1496). The owner moved off blitz around
**2026-08-08**.

Pooled, blitz outvotes his current chess 5:1 and the report describes a player
he no longer is — with numbers that look perfectly healthy and a ranking that is
simply about someone else. The tooling refuses to pool (`bucketsBy` throws), but
the refusal only protects the arithmetic: you can still *narrate* across classes,
and that is the same mistake in prose. If a claim is about rapid, say rapid.

Blitz is still worth reading — as its own sample, labelled, and only ever
compared to rapid explicitly rather than merged into it.

### 2. Every pattern claim needs its chance baseline, computed on the same positions

**The worked example.** 82% of his middlegame errors moved a **different piece**
than the engine's best. That reads as clean and teachable — "the right move was
never on his list, this is a candidate-generation problem" — and it had already
been drafted as a coaching conclusion.

Then the baseline. Those positions averaged **29.3 legal moves across 8.8
movable pieces**, and the engine's piece owned enough of them that a **blind
guess lands on it 22% of the time**. He was at **18%**.

**The finding was chance.** Roughly one standard deviation, in the direction
that would have been reported as a discovery.

Three things to carry out of that:

- **The denominator is legal moves of the engine's piece over all legal moves,
  position by position.** Not one over the number of pieces. That version gives
  11% here, against which 18% reads as *above* chance — a null result flipped
  into a finding pointing the opposite way. A queen with nine legal moves is
  nine chances to agree with the engine by accident.
- **"Indistinguishable from chance" is not "nothing is there."** It means this
  sample cannot tell. Say that, rather than either claiming the effect or
  claiming its absence.
- **Every other pattern claim needs the same treatment**, and mostly the report
  already gives it to you: `of moves` is the base rate for `share`. Before
  saying "he blunders with knights", check what share of his moves are knight
  moves. Before "he collapses in the endgame", check what share of his moves are
  endgame moves. A whole earlier analysis of "forcing move" blindness collapsed
  under exactly this test.

### 3. Think-time correlations are confounded in both directions

His error rate rises monotonically with time spent: **3% under 5s → 34% over
60s.**

That is not "thinking causes blunders". Hard positions cause both the long think
*and* the error, so the arrow runs through the position, not from the clock. It
is equally not "he should think longer" — the same confound blocks that reading.

The only claim it supports is the weaker one: **extra time is not converting
into accuracy.** That is still useful, because it rules out "slow down" as
advice, which is the advice a coach reaches for by default.

### 4. Do not diagnose a mechanism from a move list

"Didn't consider the move" and "considered it and misjudged it" are
**indistinguishable in a swing table**, and they point at completely different
training — candidate generation versus evaluation.

Separating them needs the player's stated reason *before* the reveal (#49), not
more engine depth. No node budget will do it. When you have a finding whose
lesson depends on which one it is, say which of the two you cannot rule out
rather than picking the one that makes the better sentence.

### 5. One session is one session

A pattern in this archive is a description of games already played. It becomes a
**training recommendation** only after it survives an independent sample — the
next month, or a slice held out from this one. This is constitution §9's
held-out set applied to coaching rather than to content.

The report says `thin` under 30 games for the same reason. Under that, describe;
do not prescribe.

### 6. Everything in `game-review` §4 still applies

Read [`../game-review/SKILL.md`](../game-review/SKILL.md) §4 before writing any
finding. In particular, at archive scale:

- **Tier A is not a mistake.** Tier A moves are counted in the win%-lost totals
  because that is how `npm run review` totals a game, and over 3,000 moves they
  add up to a large constant. That constant is not a weakness. `errors` and
  `lostOnErrors` are what a finding rests on.
- **A swing in a decided position is not a swing in a close one.** The archive
  pass has no WDL, so it cannot tell you which. Where a bucket's cost rests on a
  handful of big swings, open those games with `npm run review -- --deep` before
  saying the games hung on them.
- **Do not invent motifs.** "He always misses back-rank ideas" is not something
  this data can produce; it does not know what a motif is. It knows phase,
  piece, forcing-ness, clock and material.

## 5. What this tooling cannot see at all

Say so rather than working around it:

- **Openings.** ECO is recorded per game, but there is no repertoire comparison
  (#102 needs a variation-aware PGN reader). If the opening looks implicated,
  check by hand against `repertoire/*.pgn`.
- **Why a move was played.** Rule 4.
- **The opponent.** The archive grades the owner's moves only. Chances he was
  handed, and whether he took them, are a single-game question — `chancesGiven`
  in `npm run review`.
- **Anything about transfer.** Nothing here measures whether working on a bucket
  improves a rated result (constitution §9, §12). The ranking is a claim about
  where win% is being lost, and that is all it is.

## 6. What to hand back

Lead with **one thing**, not a tour of the tables. For it, give:

1. the bucket and its total win% lost, with its share of the moves beside it;
2. the base rate you checked it against, and what it came out at;
3. which of "didn't see it" / "saw it and misjudged it" you cannot rule out;
4. the sample it rests on — time class, games, moves — stated inline.

Then at most one more finding, and the honest list of what came out
indistinguishable from chance. That list is not a failure to report; it is the
most valuable part of the output, because each entry is a training plan the
owner now does not have to spend a month on.

If nothing survives §4, **say that**. "27 rapid games cannot separate these
hypotheses; here is what a held-out month would settle" is a real answer, and
the owner would rather have it than a confident recommendation built on 18%
against a 22% baseline.
