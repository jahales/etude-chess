# 0024 — Gate repertoire moves on a local evaluation index, not the crawl's own search

**Status:** Accepted · 2026-08-09
**Amends:** ADR [0021](0021-opening-repertoire-generator.md), which gates our own moves on a
fixed-node Stockfish search
**Relates to:** issue #106 (the gate) · issue #102 (reading repertoire PGNs back)

## Context

`crawl.mjs` picks our move in three steps: candidates from master games, a **soundness gate**
rejecting anything more than `SOUNDNESS_MAX_SWING` (5 win%) below the engine's best, and a
ranking of the survivors by branching cost and popularity. Issue #106 argued the gate runs too
shallow to be trusted at 400,000 nodes. The shipped repertoire is thinner still: `summary.json`
records **120,000**, roughly depth 15.

Lichess publishes a bulk evaluation dump — 401,283,893 positions at median depth 50, CC0. It
covers **585 of 585** positions our repertoire prescribes a move in. Openings are the
best-covered region of any evaluation database, and this repertoire stops at ply 13.

## Decision

The gate consults a local index of that dump first, and falls back to the crawl's own search
where a position is absent or shallower than `MIN_INDEX_DEPTH` (25). Which source decided each
move is recorded as `gatedBy` on the node, the way `bookSource` already records where the
candidates came from.

Three boundaries make this narrower than it sounds, and all three are load-bearing.

**Both halves of the subtraction come from one source.** A depth-50 best against a depth-15
candidate manufactures swings out of depth disagreement rather than measuring anything. If the
index cannot score both, the whole comparison falls back to the engine's numbers.

**Only the gate moves.** Trap scoring and the quiet test stay on the engine. `trapValue` is a
statistic whose distribution was calibrated by the cross-month replication, and the quiet test is
a *shallow-versus-deep* comparison that a single cloud number cannot take part in. Neither has
any quarrel with this change and neither is touched by it.

**Candidates still come from human frequency.** ADR [0003](0003-human-frequency-not-engine-topn.md)
governs where moves come from; this governs only which are rejected. The index never proposes a
move — an evaluation database scores positions, it does not suggest candidates.

## Why the bulk file, when the API would have done

Issue #106 planned to query `cloud-eval` with `multiPv=5` per decision, and to defer the 21.7 GB
download. The API path has a blind spot the file does not: it can only see our move if our move
is in the stored top five, which is exactly where a bad move would not be. Holding the dump
locally makes the *after-move* lookup free, so a move outside the pvs is still scored — and
**132 of the 585** were scored that way, including most of the failures. The file earned its
keep, though not for the reason predicted: not crawl throughput, but the absence of that gap.

## What the audit found, and why this is still worth doing

Re-grading all 585 prescribed moves found **6 that concede more than 5 win%, all Tier B, none
Tier C**. The 120k gate held up. This change is therefore not a rescue — it is removing a known
weak basis for a decision that gets baked into a repertoire and drilled for months, at no
recurring cost now that the index exists.

Two conventions of the dump were **measured**, because both fail silently and neither is
documented. Scores are **White-relative**, not side-to-move — over the first 400,082 positions,
Black-to-move entries average +857cp where White is up material and −356cp where Black is; #106
assumed the opposite, which would have inverted every verdict. And the **en-passant square
appears only when a capture is legal** (0.17% of positions), so foreign FENs are normalised
before they are hashed.

## Consequences

- A crawl without `--eval-index` behaves exactly as before. The flag is opt-in on `crawl.mjs`
  and `build.mjs`.
- Reproducibility now depends on the index as well as the engine, so `manifest.json` records the
  dump it was built from and how many positions survived.
- `verifyEvalDb.mjs` gates use of an index, in the spirit of `verifyBook.mjs`: of the defects
  found building this pipeline, none were caught by unit tests and every one produced a
  plausible-looking artifact. A build killed midway leaves buckets that look perfectly
  well-formed and answers "not in the database" for everything.
- The audit re-grades moves we **prescribe**. It cannot see candidates the shallow gate wrongly
  **rejected**, and since the ranking ignores evaluation, a deeper gate admits a different
  candidate set and could reorder choices that all pass. That is a separate measurement, not a
  claim this ADR makes.
