# 0007 — Build content/curricula first, adaptive engine last

**Status:** Accepted · 2026-07-17

## Context
The temptation is to build the clever part first: the classifier, the skill vector, the
adaptive selector. But the actual bottleneck was never the tooling — it's the **content**:
defining priyome/structure families and writing the justifications we grade against.
Adaptivity also *multiplies* that content need: a fixed curriculum needs ~1 item per cell;
adaptive selection needs a dense pool (~200 skills × ~30 items × a held-out split ≈ 6,000+
annotated positions). Building the model before the data-generating loop exists is the
classic ML mistake.

## Decision
Sequence the build **content-first**:
1. Ship **band-fixed curricula** (v0) that are useful immediately and instrument every
   attempt through the justification channel.
2. Build the **content pipeline** and evaluative core.
3. Add **sparring** (Maia).
4. Build the **skill model and adaptivity last**, on top of the telemetry the earlier
   phases generate.

## Consequences
- v0 has no classifier, no skill model, no adaptivity — and that's correct, not a shortcut.
- The strategic bet is to attack the **content/labor** bottleneck (seed taxonomy from
  *Woodpecker Method 2*, generate candidate annotations from engine lines over annotated
  master games, human spot-check) rather than the engineering one.
- Drives the whole [../roadmap.md](../roadmap.md). Constitution §11.
