# 0022 — One repertoire from many crawls: each branch owns its subtree

**Status:** Accepted · 2026-08-06
**Extends:** ADR [0021](0021-opening-repertoire-generator.md) (the generator itself)
**Relates to:** [repertoire-v1.md](../repertoire-v1.md) (the spec) · issue #92

## Context

ADR 0021 built a crawler that produces **one** branch. The repertoire in
[repertoire-v1.md](../repertoire-v1.md) is 25 of them, and they overlap: the Queen's Gambit
sweeper starting at `1.d4 d5 2.c4` reaches 2...e6, and so does the curated QGD Exchange branch
starting at `1.d4 d5 2.c4 e6 3.cxd5`.

Left alone, the sweeper picks its own answer to 2...e6 from the data — 3.Nc3, say — while the
Exchange branch forces 3.cxd5. Both are sound; the generator is behaving correctly in both. But
a repertoire containing both has **two answers to one position**, and the single property a
repertoire must have is that you know which move you play. Running the crawls in a shell loop
produces this silently, and it looks like 25 successful builds.

Two smaller problems come with it. Curated prefixes create **coverage holes**: a sweeper that
stops at `1.e4 c6 2.d4` and hands the rest to a branch opening `2...d5 3.e5` leaves 3.Nc3 and
3.exd5 — the two most common continuations — covered by nothing, and the result looks complete.
And rebuilding one branch against a filtered list would give it a subtree another branch already
owns, so an incremental rebuild could reintroduce the contradiction the full build avoided.

## Decision

1. **A manifest is the unit of a repertoire**, not a crawl.
   [`manifest.v1.json`](../../scripts/repertoire/manifest.v1.json) is the machine-readable form
   of repertoire-v1.md: id, colour, curated prefix, and *why the branch is in the repertoire*.
   The `why` is emitted as the comment before the first move, so a drill states what it drills.

2. **Each branch owns its subtree.** Any other branch reaching in stops at the boundary and
   names the owner, in the JSON and in the PGN (`{covered in the "qga" line}`). The boundary is
   **derived, not written**: one ply past a branch's own prefix — the first position where two
   branches could differ — with ownership to the *shortest* branch reaching through it, so
   `1.d4` hands 1...d5 to the Queen's Gambit sweeper and not to the QGD Exchange beneath it.

3. **Ownership is keyed on the SAN line, not the position.** It is a statement about *this
   manifest*, which is written in move order; a position reached by a different order is a
   different line of study even when the boards match. Within a crawl, transpositions still
   collapse on the FEN key exactly as before.

4. **The plan is validated before any engine time is spent**, and a coverage gap is an error,
   not a warning. A gap is safe only when every ply the owner forces past the boundary is *our*
   move — a single choice we were going to make anyway. Any opponent ply there is a hole, and
   the error names the entry that closes it.

5. **Boundaries always come from the whole manifest**, including under `--only`. Rebuilding one
   branch cannot produce something that contradicts the branches it skipped.

6. **A trap whose subtree is delegated is not reported as unverified.** The owning branch does
   that verification. Printing "punishment not verified" over a line that has in fact been
   checked trains you to ignore the warning that matters — which would undo the whole point of
   distinguishing verified from unverified in the first place.

## Consequences

- The repertoire is **internally consistent by construction**. There is no position with two
  answers, and no branch silently duplicating another's work.
- Coverage holes are caught by `--check` in milliseconds rather than by losing a game to
  3.Nc3. This is constitution §9's held-out-set instinct applied to the *plan* rather than the
  data: state what should be true, then check it mechanically.
- Depth becomes per-branch. A flat cap is wrong in both directions — too shallow for a branch
  starting at ply 6 to reach a quiet position, and far too deep for a "don't be surprised by
  1...c5" sweeper, which at half a second per engine search is most of an hour spent on the
  least valuable branch in the repertoire. Every branch gets the same *crawl*, not the same
  *depth*.
- Move-order coverage is bounded by what the manifest lists. A line reached only by an unusual
  order is crawled by whichever branch reaches it, and may be crawled twice by two branches.
  Accepted: duplicate study of a transposition is cheap, and the alternative — position-keyed
  ownership across separate crawls — makes ownership depend on crawl order.
- The **theory-load numbers** fall out for free: decisions of ours, replies of theirs, quiet
  targets, per branch and in total. repertoire-v1.md cut the London on the promise of "a number
  we will have, not a guess"; this is where that number comes from.

## Alternatives rejected

- **A shell loop over `crawl.mjs`.** What this ADR exists to prevent. It produces contradictions
  that look like success, which is this pipeline's characteristic failure mode.
- **No sweepers — only curated branches.** Removes the overlap by removing the coverage. The
  rare replies are exactly where the traps live: both of the repertoire's confirmed traps are
  2nd-move bishop sorties that no curated line would have named.
- **Let the last write win in the merged PGN.** Hides the contradiction instead of resolving it,
  and makes the repertoire depend on manifest order.
- **Position-keyed ownership across crawls.** Would collapse transpositions between branches,
  but ownership would then depend on which branch ran first — a repertoire that changes when
  you reorder the manifest.
