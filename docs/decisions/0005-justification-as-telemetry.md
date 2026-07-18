# 0005 — A justification is required, and it is telemetry

**Status:** Accepted · 2026-07-17

## Context
You can assign the right tier "on vibes" and learn nothing. And a binary pass/fail can't
tell *why* an attempt failed — did you miss the motif, see it and miscalculate, or just
guess? Without that, the skill model updates on noise (the **credit-assignment** problem).

## Decision
The solver must **state the key feature / plan** with the move ("this concedes d5
permanently"). This is graded (LLM against an annotation, once we have annotations), and —
more importantly — it is a **second signal channel**:
- right feature, wrong move → **calculation** failure
- wrong feature, right move → a **guess**; don't credit it
- right feature, right move, slow → recognition not yet **automatic**

## Consequences
- The justification isn't pedagogy, it's **telemetry** — it's what makes the multidimensional
  skill model (ADR [0008](0008-skill-model-multidim-irt.md)) identifiable at all. No other
  trainer has this channel; it's a core asset.
- Requires an annotation to grade against → ties the project to the content/ontology
  bottleneck (ADR [0007](0007-content-first-adaptive-last.md)).
- Captured from v0 day one, even when grading is only coarse, so the data exists when the
  model is built.
