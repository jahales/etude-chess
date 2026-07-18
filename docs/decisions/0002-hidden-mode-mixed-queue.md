# 0002 — The hidden-mode mixed queue is the core differentiator

**Status:** Accepted · 2026-07-17

## Context
Every existing trainer pre-announces the mode: "here's a puzzle, find the win." Knowing a
forcing win exists changes how you look — you calculate instead of judging. Real games
never announce the mode. Failing to notice a position has gone concrete, or grinding for a
combination in a position that only wants a plan, is the dominant error class from ~1200
to ~2000.

## Decision
The system's signature feature is a **single review queue where the mode is hidden** — the
position could be any decision type, and the solver must first decide *what kind of
decision this is*. Acquisition may be **blocked** by mode; **transfer** is always tested
with the mode concealed.

## Consequences
- This is the product's reason to exist, not a nice-to-have. It's the one place
  mode-selection can be trained.
- Backed by the interleaving evidence (discriminative contrast; hardest and most valuable
  when categories are confusable) — with the caveat that blocked practice comes *first*
  for acquisition. See [../learning-science.md](../learning-science.md).
- Creates a real UI problem: input affordances (tier buttons vs. entering a move vs.
  playing out) must not leak the mode. Flagged in [../open-questions.md](../open-questions.md).
- v0 ships a crude version (opt-in toggle) to start generating mode-selection telemetry
  early.
