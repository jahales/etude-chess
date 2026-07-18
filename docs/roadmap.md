# Roadmap

> Living document. Provisional and expected to reorder as we learn. The sequencing
> principle is fixed even if the contents aren't: **content and curricula first, the
> adaptive skill model last** (constitution §11, ADR
> [0007](decisions/0007-content-first-adaptive-last.md)).

The reason for this order: adaptivity multiplies the content problem. A fixed curriculum
needs ~1 item per cell; adaptive selection needs a *dense* pool across all of them —
roughly 200 skills × ~30 items × a held-out split ≈ **6,000+ annotated positions**.
Building the model before the data-generating loop exists is the classic ML mistake.

## Phase 0 — Foundations (now)
Planning docs, constitution, ADRs, agent files. **You are here.** No app code.
- [x] Capture the design as living docs
- [ ] Agree the v0 scope in [first-deliverable.md](first-deliverable.md)
- [ ] Pick the v0 tech stack (proposal exists; not locked)

## Phase 1 — v0.1.0: coached guess-the-move on master games (first buildable deliverable)
Play through a curated public-domain classic from the winner's side → at each non-trivial move,
**commit a move + a one-line reason** → graded by win%-swing tier (engine-equal alternatives get
full credit) → reveal the master's move + a plain-language why. **Every move is a retrieval
event** (~25–35 per game, ~10× the density of playing), it's the self-serve analog of *lessons*
(the top-yield activity in Southwick 2026), and it needs none of the risky components. Full spec:
[v0.1.0-plan.md](v0.1.0-plan.md); rationale: ADRs [0011](decisions/0011-game-review-first.md) +
[0014](decisions/0014-v0.1.0-guess-the-move.md). Then:
- **v0.2.0** — **play vs client-side Maia** + the same coached review on your own games;
  by-phase leak analytics begin (ADR [0013](decisions/0013-v0.1.0-play-vs-maia.md)). The
  client-side-Maia delivery risk is **de-risked** — a spike proves Maia-1 runs in-browser
  (ADR [0016](decisions/0016-maia-onnx-delivery.md), [spike report](spikes/maia-onnx.md)).
- **v0.3.0** — tactics from *your own missed tactics* (fresh instances, untimed). _(The
  mid-game "step back and analyze" intervention moved **into v0.2** as coach-every-move —
  ADR [0017](decisions/0017-in-game-coach.md).)_
- **v0.4.0** — opening *safety*: trap avoidance + structure/plan from your opening leaks
- **v0.5.0** — endgame technique curriculum (tablebase-adjudicated)
- **v0.6.0+** — the hidden-mode mixed queue (the differentiator); dedicated play-it-out

The three drill modes are detailed in [first-deliverable.md](first-deliverable.md).
**Justification capture** and honest metrics apply from v0.1.0 (telemetry seed).

## Phase 2 — Content pipeline & the evaluative core
Turn "we hand-picked some positions" into a repeatable curation pipeline.
- Frequency-weighted-regret miner over Lichess data → candidate evaluative items & traps
- The "tactics-in-a-trenchcoat" filter (forcing-line search / shallow-deep disagreement)
- Seed the priyome taxonomy from *Woodpecker Method 2* Part 1; generate candidate
  annotations from engine lines over annotated master games; human spot-check a sample
- LLM justification grading against annotations
- Family scheduling + held-out test sets, properly

## Phase 3 — Sparring & play-it-out (Maia already client-side from v0.2.0)
- Dedicated **play-it-out** task: from a critical moment to conversion (reuses the v0.2.0 Maia
  opponent — no new engine work)
- Dual-signal feedback (human-likelihood via Maia + eval via Stockfish); the Maia Platform's
  "blunder meter" is the reference
- Prophylactic-mode lens over the evaluative pool

## Phase 4 — The learner model & adaptivity
Only once phases 1–3 are generating dense, labeled telemetry.
- Multidimensional IRT skill vector with a hierarchical prior (ADR
  [0008](decisions/0008-skill-model-multidim-irt.md))
- Cold-start from imported games (run ~200 Lichess/Chess.com games through the classifier
  → hundreds of pre-labeled decision points → a skill prior, no placement test)
- ROI-/band-weighted item selection; learn the weights by correlating skill-vector
  components against real game results across users
- Close the loop: adaptive queue driven by the model

## What "done" is not
There is no phase where we claim to train *all* of chess. The ceiling
([vision.md](vision.md)) is an asymptote. Clock, calculation stamina, and practical
defense stay out of scope regardless of phase.
