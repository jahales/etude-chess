# 0001 — Organize by decision type, not game phase

**Status:** Accepted · 2026-07-17

## Context
The intuitive top-level axis for a chess trainer is opening / middlegame / endgame. But
that's a book convention, not a training axis: openings contain tactics, endgames contain
positional judgment. It doesn't partition the *task*.

## Decision
Organize the entire system by **decision type** — the kind of judgment a position demands:
**concrete**, **evaluative**, **technique**, **prophylactic**, and **play-it-out**. Each
type gets its own task format, scheduling, metric, and grading. Phase is, at most, a tag.

## Consequences
- Task format follows from type, not from where in the game the position sits.
- "No memorizing book lines" holds everywhere except **technique**, which is deliberately
  exempted (an algorithm with a proof, not a line to recall).
- Openings stop being a special case: they're evaluative + trap-avoidance + structure
  recognition. Transposition becomes a *feature* (family rotation), not a problem.
- Enables ADR [0002](0002-hidden-mode-mixed-queue.md): if the axis is decision type, you
  can hide it.

See [../decision-types.md](../decision-types.md).
