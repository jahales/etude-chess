# 0008 — Learner model is a multidimensional-IRT skill vector

**Status:** Deferred (Phase 4) · 2026-07-17

## Context
"Learns your skill level" is the eventual goal, but skill isn't scalar. A single puzzle
rating (Chess.com-style) is useless for *prescription*: the same position is easy for a
tactician and hard for a positional player. And "balance your skills" is the wrong
objective — below ~1800, tactics dominate results, so balanced training for a 1300 is
malpractice.

## Decision (intended, not yet built)
Model the learner as a **vector over ~200 skill dimensions** (per-motif, per-priyome,
per-technique, per-structure), estimated with **multidimensional Item Response Theory** and
a **hierarchical prior** that partially pools evidence across the taxonomy (evidence about
one deflection informs related overloading). Item selection is **ROI-weighted and
band-conditional**, and the ROI weights are *learned* by correlating skill-vector components
against real game results.

## Why deferred
- It needs dense, labeled telemetry that only exists after Phases 1–3 run
  (ADR [0007](0007-content-first-adaptive-last.md)).
- **Credit assignment** — which skill does a fail update? — is only tractable because of the
  justification channel (ADR [0005](0005-justification-as-telemetry.md)).
- **Cold start** is solved without a placement test: import ~200 games, run them through the
  mode classifier → hundreds of pre-labeled decision points → a skill prior.
- Open question whether ~200 dims identify from one hobbyist's sparse data or need many
  users ([../open-questions.md](../open-questions.md)).

## Consequences
- Nothing in v0 depends on this; don't let it leak forward into early phases.
