# 0026 — The tactic-gap filter is off by default, and why that is not a repeal

**Status:** Accepted · 2026-08-10
**Amends:** ADR [0021](0021-opening-repertoire-generator.md)'s use of constitution §6's filter as
an unconditional part of the quiet test
**Relates to:** ADR [0024](0024-gate-on-a-local-evaluation-index.md) · ADR
[0025](0025-curated-lines-run-to-the-structure.md)

## Context

A line stops when the position goes **quiet**, and `quietness` requires three things: several
playable moves (breadth), a position still in the balance, and **no hidden tactic** — the last
tested by running a *second, shallower* search and asking whether it disagrees with the deep one.
That third test costs an entire extra engine search at every assessed position.

Once ADR 0024 moved every absolute judgment onto the evaluation index, this became the crawl's
**only** remaining engine cost besides the deep multi-PV search itself. So it is worth knowing
whether it still decides anything.

## The measurement

Instrumented, then measured on positions the crawl genuinely assessed at `--nodes 4000000`:

```
qgd-exchange   tested 177 · skipped 44 · decided 0
qga            tested 235 · skipped 67 · decided 0
```

**412 positions where the gap could have changed the verdict, and it changed none.** The observed
gaps are not marginal, they are nowhere near: mean **0.45** win%, maximum **1.34**, against a
threshold of 5.

An earlier sample of 96 positions also found zero, but that one was drawn from the *shipped*
repertoire — positions selected for having already been quiet — so it was biased toward exactly
the answer it gave. These 412 are not: they are what the crawler looked at, including everything
it rejected.

## Decision

`tacticGap` defaults to **false**. `--tactic-gap` turns it back on.

## Why this is not a repeal of constitution §6

The filter is not wrong. It is a test of **whether the deep search is deep enough**, and the
answer changed when the budget did.

v1 ran the crawl at **120,000 nodes** against a 20,000-node shallow search. At that depth the two
readings genuinely disagree, and the test was doing real work — it is why §6 exists. At 4M against
667k, both readings are past the horizon of the tactics that arise in an opening position, so they
agree essentially always.

So the honest statement is not "this test is useless" but "this test is redundant **at this
budget**". Deleting the code would have thrown away something a future low-budget run needs.
`DEFAULTS.tacticGap` says so, and `report.tacticGap` keeps recording whenever the test runs, so
re-enabling it produces fresh evidence for its own worth rather than an assertion.

**Turn it back on for any run below roughly 1M nodes.** That crossover is not measured — the two
data points are "fires at 120k" and "does not fire at 4M" — so it is a caution, not a threshold.

## Consequences

- One engine search per assessed position instead of two, on top of the ~22-to-2 reduction ADR
  0024 already bought. What remains is the deep multi-PV search, which ADR 0024 established the
  index cannot replace: an index-only verdict agrees with the engine's only 66.7% of the time,
  because breadth at depth 34 is a different measurement from breadth at depth 26.
- The quiet test now rests on breadth and balance alone at default settings. Both come from the
  same deep search, so it stays internally consistent.
- A repertoire built with the flag and one built without are **not** comparable on their
  `quiet` counts. `report.tacticGap.enabled` records which was used.
- The risk accepted: a position with a tactic beyond depth ~26 but inside the breadth and balance
  windows would now be called quiet. Nothing in 412 positions looked like that, and the swing
  would have to exceed 5 win% to have registered — but it is the failure mode to look for if a
  drilled "quiet" position ever turns out to have a concrete refutation.
