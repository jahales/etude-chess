# 0011 — Lead v0.1.0 with a personalized game-review loop, not a puzzle trainer

**Status:** Accepted · 2026-07-17 · **game source superseded by ADR
[0013](0013-v0.1.0-play-vs-maia.md)** (play-vs-Maia instead of import; review-first thesis stands)

## Context
The original [../first-deliverable.md](../first-deliverable.md) led with a three-mode drill
trainer (tactics / opening survival / endgame), tactics first because tactics dominate results
below 1800. Then the **Southwick et al. 2026** study (*Psychological Science*, N=44,213,
time-stamped Chess.com activity vs. rating) landed
(https://journals.sagepub.com/doi/full/10.1177/09567976261452568): per-hour rating gains were
**video lessons ≈ 5.2, game review ≈ 4.4, playing ≈ 0.86, and tactics puzzles ≈ 0.73 —
puzzles statistically no better than just playing.** See
[../research/effectiveness.md](../research/effectiveness.md).

## Decision
**v0.1.0 is a personalized game-review loop**: import the user's own games → surface the 2–4
decisive mistakes per game → **commit a better move + a one-line reason before the reveal** →
explain the engine's answer in plain language. Tactics/opening/endgame drills move to later
0.x releases and are **sourced from the user's own mistakes**, which is what the evidence says
makes them transfer.

## Why this is coherent, not a pivot
- **Highest evidence-backed yield** — review is ~5–6× puzzles per hour and the most
  under-served feature in the market.
- **It's still "make a judgment from a real position"** — squarely inside the constitution
  (judgment over memory; retrieval-first; **justification as telemetry**, ADR
  [0005](0005-justification-as-telemetry.md)).
- **It dissolves the content bottleneck for v0.1.0** — the user's own games are the content,
  so we ship value with *no* curated ontology (consistent with content-first sequencing, ADR
  [0007](0007-content-first-adaptive-last.md)).
- **It builds the reusable core** (engine-as-referee, win% grading, board UI, attempt capture)
  that every later mode needs.
- **Personalization drives transfer** — the puzzle→game gap shrinks when the material is the
  player's own recurring errors.

## Consequences
- [../first-deliverable.md](../first-deliverable.md) is now the *medium-term* multi-mode
  picture; [../v0.1.0-plan.md](../v0.1.0-plan.md) is the concrete first release and takes
  precedence where they differ. The three modes are reframed as v0.2–v0.4, fed by review.
- The tactics-first instinct isn't wrong about *what a 1200 needs to fix* — it's wrong about
  the most efficient *delivery*. Review finds the weaknesses; drills fix them.
- Caveat honestly recorded: the study measures puzzles *as casually used*, not our
  anti-overfitting design — but it's a strong prior against "build a better puzzle grinder."
