# 0017 — Coach *during* the game (coach-every-move), not only after it

**Status:** Accepted · 2026-07-18
**Applies to:** v0.2.0 play-vs-Maia. Amends the timing of ADR
[0013](0013-v0.1.0-play-vs-maia.md) and pulls the mid-game intervention forward from
v0.3 (see [../roadmap.md](../roadmap.md)).

## Context
ADR 0013 chose **play-then-review**: play a full game against Maia, then review the
decisive moments. Its stated reason was to **preserve real-game conditions** —
"interrupting is more lesson-like [and we deferred it] to keep real-game conditions,"
so the mid-game "step back and analyze" intervention was parked for v0.3.

Building v0.2, the owner watched the play loop and asked for the opposite: **coaching you
can watch *in-game*, not just at the end.** Given the choice between ambient feedback, a
blunder-only nudge, and coaching every move, the owner chose **coach every move**.

## Decision
In play-vs-Maia, **every one of your moves is a graded decision, reviewed before Maia
replies.** The loop becomes:

> your move → (Stockfish grades it in the background) → **coach verdict** shown (tier +
> engine-based "why") with **Take back** / **Continue** → on Continue, Maia replies.

Plus an **ambient live eval bar** ("who's ahead") you watch throughout. The full
by-phase review at game end still stands (later increment).

This makes a live game against Maia a stream of retrieval events — the guess-the-move
discipline (commit → graded → learn) applied to *your own* game, with Maia (not a fixed
master) as the opponent. It reuses the v0.1 grading (`gradeAfterMove`), win%-swing tiers,
and reveal components wholesale.

## Why this is coherent with the constitution
- **Concrete/tactical feedback only** — win%-swing tiers, the same signal guess-the-move
  uses; **no speed metric**, no invented transfer claims (constitution §9, §12).
- **Retrieval density** is the whole thesis (learning-science): coach-every-move maximises
  graded decisions per game.
- The "why" is a **code-computed fact** (hanging pieces via SEE, engine best, swing),
  rendered by rules — the LLM, when added, only paraphrases it (ADR 0012).

## Consequences
- **Trades game-realism for lesson-density** — the explicit reversal of ADR 0013's
  reasoning. Real over-the-board conditions (no take-backs, clock, no feedback) are *not*
  what this trains; the honest ceiling (vision.md) already excludes clock/practical
  defense, so this is consistent, not a new overclaim.
- The Maia opponent still reacts to *your actual moves*, so games stay live and varied
  (unlike guess-the-move's fixed master game).
- **Stockfish is now needed during play**, not just at review — one shared analyser worker
  serves both modes (lifted to `App`).
- A per-move **Take back** exists in play mode (it doesn't in guess mode) — this is
  practice, not a rated game.
- The by-phase **post-game review** remains, summarising the moves you were coached on.
- Superseded reasoning is recorded here rather than edited out of ADR 0013.
