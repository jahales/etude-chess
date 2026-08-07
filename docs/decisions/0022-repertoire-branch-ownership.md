# 0022 — One repertoire from many crawls: each branch owns its subtree

**Status:** Accepted · 2026-08-06 · **amended 2026-08-06** (depth) and **2026-08-07** (transpositions)
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

3. **Ownership is keyed on the SAN line** — and, since 2026-08-07, **also on the position**.
   The line key is a statement about *this manifest*, which is written in move order. The
   position key is what stops a transposition slipping past it.

   > **Amended 2026-08-07.** This originally said ownership was keyed on the SAN line *and not*
   > the position, on the reasoning that a position reached by a different order is a different
   > line of study. Drilling the result showed that to be wrong in the one way that matters.
   >
   > `1.d4 e6 2.c4 d5` and `1.d4 d5 2.c4 e6` are the same board. The sidelines sweeper answered
   > 3.Nc3; the QGD Exchange branch forces 3.cxd5. En Croissant builds one card per *position*
   > and keeps whichever it walked first, so the trainer demanded one move while the PGN showed
   > the other as a legitimate line — **one position with two answers**, which is the single
   > thing the rest of this ADR exists to prevent. It was reached through a move order, so the
   > line key could not see it.
   >
   > Branches therefore crawl **owners first** — the `role` order already ranks them: curated,
   > sweeper, signpost — and each registers every position it decides, including those in its
   > curated prefix, where a branch like the QGD Exchange keeps its whole point. A later branch
   > that transposes in stops and names the owner. 27 lines defer that way; decisions fell from
   > 336 to 269, because the duplicated study went with it.

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
  least valuable branch in the repertoire.

  > **Amended 2026-08-06.** This originally read "every branch gets the same *crawl*, not the
  > same *depth*", and that is no longer true. Depth is now decided by a **floor**, and the
  > floor by what the branch is *for*.
  >
  > Two measurements forced it. The first built repertoire ended every line around move 5,
  > because a line stops the moment it is *allowed* to and almost every opening position is
  > quiet by move 4 — the floor, not the cap, was deciding depth. Raising it uniformly to 10
  > then cost **467 decisions to memorise**, of which the sweepers and signposts carried 58%
  > while every curated line came to about a hundred between them.
  >
  > So a branch declares a `role`, and the floor follows it: `curated` at the base (10),
  > `sweeper` two plies below, `signpost` four. Offsets rather than absolutes, so the ordering
  > survives the base moving and `--min-ply` raises all three together. That took 467 decisions
  > to 336 while the count of trainable quiet positions fell by three, 193 to 190.
  >
  > The per-branch rule still sets the cap and still prevents a branch stopping on its own root
  > — a role never makes a branch shallower than four plies past its own prefix, so on a deep
  > curated prefix all three roles land on the same number. What changed is that the per-branch
  > rule is now a minimum on top of a role-dependent floor rather than the only rule.
- Move-order coverage is bounded by what the manifest lists: a line reached only by an order no
  branch begins with is not crawled at all.

  > **Amended 2026-08-07.** This used to continue "…and may be crawled twice by two branches.
  > Accepted: duplicate study of a transposition is cheap." Duplicate study is cheap; duplicate
  > **answers** are not, and that is what it turned out to mean in practice. See decision 3.
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
- ~~**Position-keyed ownership across crawls.**~~ Rejected here on 2026-08-06 because ownership
  would depend on which branch ran first, making the repertoire change when you reorder the
  manifest. **Adopted 2026-08-07** once that objection was answered rather than accepted: crawl
  order is not arbitrary, it is the `role` order, so "whichever ran first" is always the branch
  you are actually learning. The objection was sound; the conclusion drawn from it was not.
