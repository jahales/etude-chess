# 0025 — Curated lines run to the structure, not to the first quiet position

**Status:** Accepted · 2026-08-10
**Amends:** ADR [0021](0021-opening-repertoire-generator.md), which ends a line when the position
goes quiet
**Relates to:** ADR [0024](0024-gate-on-a-local-evaluation-index.md) (the gate that makes deeper
crawling affordable) · issue #88

## Context

ADR 0021 stops a line at the first *quiet* position — shallow and deep evaluation agree, several
moves are playable, the position is roughly balanced — on the reasoning that this terminal
position is the item worth training and the moves before it are scaffolding. That reasoning is
sound and is not being withdrawn.

What it does not do is reach a **pawn structure**. v1's deepest line is ply 13 and most stop
around 10; a Carlsbad, an IQP or a French chain does not form until roughly ply 16–25. Measured
directly: CQL structure queries run against the three shipped repertoire PGNs match **nothing**,
because the games end before the structures exist. A repertoire that stops at the first quiet
position teaches which moves to play and nothing about the middlegame those moves are *for*.

This also blocks the annotation work [development-focus.md](../development-focus.md) names as the
project's one real bottleneck: a priyome/structure taxonomy needs positions that have structures.

## Decision

Raise the base floor from **10 to 16**, for `curated` branches only.

The roles are **offsets** from one base — deliberately, so the ordering cannot invert when the
base moves. Raising the base alone would therefore have dragged sweepers from 8 plies to 14 and
signposts from 6 to 12, which is the opposite of what is wanted: sweepers and signposts were
measured carrying **58% of the memorisation load for the least value**, and none of the
structural argument applies to a branch whose job is to meet 1...c5 at all. So the offsets widen
in step — `{curated: 0, sweeper: -8, signpost: -10}` — holding sweepers at 8 and signposts at 6
exactly where they were.

Two consequences had to be handled rather than discovered later.

**The depth cap now needs real headroom.** The cap is tested *before* the quiet test, so the gap
between floor and cap is the whole search window for a quiet position. It was `minPly + 2`, which
was ample when `forced.length + CRAWL_PLIES` set the cap for most branches; with the floor at 16
the floor dominates for any prefix under 14 plies, and 2 plies became the entire window. It is
now a named `QUIET_HEADROOM = 6`. A side effect worth knowing: on the shipped constants the
prefix term can no longer win at any depth, so only an explicit `--crawl-plies` moves the cap.

**Hand-pinned caps from the old base are now underneath the floor.** `qga` pinned `maxPly: 13`
and its own note warned that "if minPly ever rises past 11 this branch can no longer reach its
own priority line" — which came true. Rather than fix the one branch and leave the trap for next
time, `badDepths` now rejects any branch whose cap is at or below its floor, in the `--check`
that runs before any engine is started. It is a silent failure otherwise: every line ends on the
cap, the branch ships with no trainable content, and every unit test passes.

## Cost, and why it is affordable now

Deeper curated lines mean more to memorise, and that is the real price. It is paid for by two
things that did not exist when 0021 was written: the evaluation index (ADR 0024) removes the
engine from the gate where the position is known, and the candidate fan-out at each node now runs
across a pool of single-threaded engines instead of one at a time — the searches at a *single*
node are independent, which is the case `enginePool.mjs` was written for and had ruled out for
crawls. Together they buy a 10× node budget in comparable wall-clock.

The honest number is not yet known: the build reports `to memorise`, and it will be compared
against v1's 341 + 210. If it climbs past what one person can hold, ADR 0021's own remedy
applies — cut branches from the manifest, do not crawl shallower — because a shallower crawl buys
the same repertoire with the trainable positions chopped off.

## Consequences

- `DEFAULTS.minPly` 10 → 16 and `DEFAULTS.maxPly` 14 → 24 in crawl.mjs; `ROLE_DEPTH_OFFSET`
  widened in build.mjs. `--min-ply` still raises all three roles together.
- Per-branch `minNodeGames`/`minCanonGames` overrides are now forwarded, because a branch that
  exists to cover a rare trap needs a lower floor than one covering a main line — the 2.Ne2
  Caro-Kann is 0.21% of replies to 1...c6 and has 11 games behind the critical position.
- Structure work becomes possible from the repertoire's own terminal positions rather than only
  from a master corpus.
- Lines that run out of band data before ply 16 will terminate `out-of-book` rather than `quiet`.
  The band book was rebuilt from ply 12 to ply 20 for exactly this reason, and the count is
  reported per build; a rise there is the signal that the floor has outrun the evidence.
