# 0021 — Generate an opening repertoire from explorer data + engine, terminating at quiet positions

**Status:** Accepted · 2026-08-05
**Relates to:** constitution §1 (train judgment, not memory of lines), §4 (distractors from human
frequency), §6 (filter tactics wearing a trenchcoat) · ADR
[0018](0018-games-corpus-and-annotations.md) (we ship no corpus) ·
[backlog.md](../backlog.md) `epic:opening`

## Context

The owner needs an opening repertoire now, for two reasons that are independent of this app:
En Croissant is installed and has a working spaced-repetition trainer, but it **requires a
repertoire as input** and does not supply one; and a repertoire is the one piece of opening
preparation that has to exist before any of the opening work in `epic:opening` can be evaluated.

Three things make this awkward against the current plan:

1. **Constitution §1 forbids training openings as move sequences to recall.** A repertoire is,
   naively, exactly that.
2. **`epic:opening` sits fifth in the backlog**, gated behind the database epic (for material)
   and the review loop (for targets).
3. **ADR 0018 says we ship no corpus.** Generating opening data looks adjacent to shipping one.

## Decision

1. **Build a repertoire *generator*, as an offline pipeline, not a mode.** It lives in
   `scripts/repertoire/` (IO, crawling, engine driving) with its scoring logic as pure functions
   in [`src/domain/repertoire.ts`](../../src/domain/repertoire.ts). It ships no UI. The curated
   input spec is [repertoire-v1.md](../repertoire-v1.md).

2. **A line terminates at a *quiet position*, and that position is the item.** Quiet means:
   shallow and deep evaluation agree (no hidden tactic — constitution §6's filter, reused
   verbatim), at least three moves fall within the Tier-A window of best, and the position is
   roughly balanced. Depth is variable — floor ~6 ply, cap ~10 ply — not fixed.

   This is what reconciles the work with §1. What gets trained is the terminal position, where
   several moves are playable and judgment decides; the moves leading to it are scaffolding for
   *reaching* a position you can think in. A repertoire that ended on a single forced move would
   be the memorisation §1 rules out, and the quiet test is what mechanically prevents it.

3. **Two sources, two jobs.** The Lichess **masters** explorer supplies the main-line spine;
   the **amateur** explorer, filtered to the owner's rating band, supplies deviation coverage.
   This split is load-bearing: a master database contains almost no Englund, Wayward Queen or
   Fried Liver, which is precisely what a 1400 actually faces. Constitution §4 already names
   Lichess/masters human frequency as the sanctioned candidate source.

4. **Opponent deviations are selected by frequency mass plus `trapValue`.** We cover moves in
   frequency order up to a target share of games actually played at the band, and *additionally*
   include any move that is objectively bad yet **outperforms its own evaluation** in practice:

   ```
   trapValue = frequency × swing × max(0, practicalScore − expectedScore)
   ```

   This is constitution §4's frequency-weighted regret pointed at the opponent instead of the
   solver. A move played often, losing real evaluation, and *still* scoring well means the
   refutation is not common knowledge at this band — which is exactly where study time pays.

5. **Our own moves are chosen partly by branching cost.** Among moves that pass a soundness
   gate, prefer the one that leaves fewer distinct replies to prepare. A repertoire's real cost
   is its branching factor, and optimising only for evaluation produces one nobody can learn.

6. **Output is dual: PGN-with-variations and annotated JSON.** The PGN imports into En
   Croissant's SRS today; the JSON becomes etude-chess content when `epic:opening` comes up.
   One pipeline, value now, no wasted work either way.

7. **This does not reorder the backlog.** `epic:opening` stays fifth. This is a **content
   generator** that runs offline and produces a file, not a mode, a screen, or a queue. It has
   no dependency on the database or review-loop epics because it sources from a public API
   rather than from the owner's own games — which is also why it can be built now.

## Consequences

- The owner gets a usable repertoire in En Croissant without waiting on any etude-chess UI.
- `epic:opening`, when it arrives, starts with an annotated pool of quiet positions and a ranked
  trap list rather than from nothing. The generator is the annotation-labour attack the backlog
  calls for, applied to one domain.
- **ADR 0018 is not weakened.** We ship no games corpus. The generator produces *positions and
  statistics* derived from a public API, computed locally, and the output is the owner's.
- We take on a dependency on the Lichess explorer API being available and rate-limit-friendly.
  Mitigated by an on-disk cache: re-runs and threshold tuning cost no requests.
- `trapValue` and the quiet test are pure and tested, so both are reusable by the app later —
  the trap metric in particular generalises well beyond openings.

## Alternatives rejected

- **Hand-author the repertoire.** It is what the backlog names as the project's bottleneck
  (annotation labour) and it produces no reusable machinery. The point is to attack the labour.
- **Fixed depth for every line.** Simple, and wrong in both directions: it truncates sharp lines
  mid-tactic and pads quiet ones with moves that carry no decision. Variable depth with a quiet
  terminal is strictly better and is what makes the output trainable.
- **Decode Caissabase and use it as the primary source.** Its `Moves` BLOB is a legal-move index
  in the generator's own ordering; decoding means replicating shakmaty's bitboard iteration order
  exactly, including promotions and castling. Fragile, and it still would not answer the question
  that matters — what a 1400 faces — because it is a strong-player database. Kept as an optional
  offline cross-check.
- **Engine-top-N as the candidate source.** Forbidden by constitution §4, and it would produce a
  repertoire against opponents who do not exist at this band.
