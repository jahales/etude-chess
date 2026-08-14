# Repertoire v2 — staged study decks

Four files, of which **two are ever in use**. Import the pair for the tier you
are on, one per colour, into En Croissant (Files → Add New → from PGN) and point
the repertoire trainer at whichever side you are drilling.

| file | games | decisions |
|---|---|---|
| `etude-white-standard.pgn` · `etude-black-standard.pgn` | 2 · 6 | **500** — start here |
| `etude-white-complete.pgn` · `etude-black-complete.pgn` | 2 · 8 | 2,299 |

**Import the two colours separately.** En Croissant trains from one side's point
of view, so a file holding both is importable as neither — it would drill you as
White in the Caro-Kann.

**`complete` is a superset of `standard`**, so moving up never means relearning
anything. When you do move up, remove the previous import first: keeping both
means every line is drilled twice and the scheduler treats them as separate
items.

There was a 150-decision `core` tier between these and it was dropped: 150 is
roughly the first four plies of what you meet most, which is thin enough that
you meet an unprepared position in most games. The step from 500 straight to
everything is steep, but it is a step taken once, against a first deck that can
actually stand on its own. Re-cut at any time with `npm run rep:decks` and a
different `--sizes`.

White holds **both** first moves as two games — 1.d4 and 1.e4 are alternatives
at the board, so they sit in one file and you drill whichever you play. Black is
six games because its roots are *White's* first moves, which really are separate
entry points.

Every manifest branch is grafted into these, rather than shipping one game per
branch: the core White deck was otherwise 26 games for 144 decisions, seventeen
of them five moves or fewer. A branch is the unit the *build* needs — it is what
makes branch ownership work — and the wrong unit for drilling.

## How the tiers were chosen

Ranked by `studyOrder.mjs`: how often you reach a position (band-book frequency)
× what playing the *natural* move instead would cost (from the evaluation index).
A decision where instinct is already right is worth nothing to study however
common — you will find it at the board.

Then made **prefix-closed**: a decision is admitted together with every decision
on the path to it, and the budget pays for the ancestors too. You cannot drill
move 12 of the Carlsbad without moves 1 to 11, so a tier is a set of complete
lines rather than a well-ranked list of positions.

`tiers.json` records which decision landed in which tier.

## What is in here

Built 2026-08-11 from an 8M-game band book (Lichess 1300–1800 blitz/rapid,
ply 20) and 2.82M Lumbra OTB games, gated on a local index of 401M Lichess
evaluations at median depth 34–50 (ADR 0024), with curated lines run to ply 16
(ADR 0025).

```
1.d4 + Black   1,331 decisions · 423 quiet targets · deepest ply 19
1.e4             934 decisions · 195 quiet targets · deepest ply 20
```

against v1's 551 decisions and 266 quiet targets.

## Caveat — the trap annotations are provisional

The **moves** are gated at depth 34–50 and sound. The `?!`/`?` trap commentary is
not yet confirmed: trap values shifted when the deeper evaluation baseline landed,
and `replicate.mjs` against a second month's book is what separates a real trap
from one month's noise. The June 2026 dump is downloaded for exactly that and the
pass has not been run. Drill the moves; do not yet trust a `?` to mean the move
is refuted.
