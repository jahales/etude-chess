# 0004 — Tier candidates (A/B/C); never grade a ranking

**Status:** Accepted · 2026-07-17

## Context
Asking a learner to *rank* candidate moves is better than move-finding (an ordering is
harder to memorize than "the answer is Nd5"). But a fine-grained ranking over moves scoring
+0.35 / +0.31 / +0.28 / +0.22 isn't real — the order flips with engine depth, hardware, and
version. Grading it teaches people to reproduce engine artifacts.

## Decision
Bucket candidates into **tiers with a gap requirement**, and grade the *tier assignment*:
- **A** — within ~0.15 of best (playable, essentially equivalent)
- **B** — a real concession, ~0.15–0.5
- **C** — structurally bad, > ~0.5

Grade with Kendall's tau **with ties**. Weight **A-vs-C** discrimination heavier than
A-vs-B — telling "fine" from "bad" is the skill that shows up in games. Ranking *within* a
tier is never graded.

## Consequences
- Thresholds (0.15 / 0.5) are heuristics and may need tuning per structure; they are not
  sacred, but the *principle* (tiers with a gap, not permutations) is (constitution §3).
- Pairs with a stated **justification** (ADR [0005](0005-justification-as-telemetry.md)):
  you can tier correctly "on vibes" and learn nothing, so the reason must be graded too.
