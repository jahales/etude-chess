# 0003 — Source candidates from human frequency, not engine top-N

**Status:** Accepted · 2026-07-17
**Applies to:** evaluative-mode candidates and trap curation (not concrete-mode tactics).

## Context
The obvious way to generate candidate moves for a "rank these" task is Stockfish's top-N.
But engine top-N gives you four *good* moves and no temptation — nothing to teach against.
The pedagogically valuable distractor is the natural human move that's a quiet concession:
the pawn push that weakens a square, the trade that helps the opponent, the passive
developing move.

## Decision
Source candidate moves from **human move frequency** (Lichess open DB, masters DB), then
score them all with the engine. The curation signal is **frequency-weighted regret** =
`human_frequency × eval_drop`. A move 30% of players make that costs 0.6 is a far better
exercise than the engine's fourth choice.

## Consequences
- Traps need no separate curriculum — a trap *is* a high-frequency, high-regret move. The
  candidate sourcing emits them for free.
- Requires the "tactics wearing a trenchcoat" filter (ADR context / constitution §6): some
  moves lose eval to a 5-move forcing line — that's a concrete item, not evaluative.
  Filter via forcing-line search or shallow-vs-deep eval disagreement.
- Also the right resolution of the original "engine-delta" idea: the question isn't "is one
  move much better," it's "does the *obvious* move quietly cost something."
