# The decision-type taxonomy

> Living document. This is the top-level axis of the whole system.
> Supersedes the opening/middlegame/endgame framing. See ADR
> [0001](decisions/0001-decision-types-not-phases.md).

A position is classified by **what kind of decision it demands**, which determines
the task format, the scheduling, the metric, and how it's graded. A single position
can be reclassified as understanding of it deepens; the classifier is a heuristic
(see [glossary.md](glossary.md) → *mode classifier*), not ground truth.

| Type | The question | Task format | Scheduling | Metric | Graded by |
|------|--------------|-------------|-----------|--------|-----------|
| **Concrete** | "What's the forcing line?" | Find the move / line | Short cycles (Woodpecker math); mistake-review at 1/3/7/14/30d | Seconds per position; accuracy | Engine (exact line) |
| **Evaluative** | "What does this position want?" | Tier candidates A/B/C **and name the feature** | Family rotation, long intervals, held-out test set | Correct tier assignment; can you name the feature before moving | Engine (tier) + LLM (justification vs. annotation) |
| **Technique** | "Execute the procedure." | Play out the known algorithm vs. best defense | Plain declarative SRS | Pass/fail on procedure; then speed | Engine / tablebase |
| **Prophylactic** | "What does *he* want?" | Identify opponent's threat/plan before choosing | Family rotation | Did you name the threat | Engine + annotation |
| **Play-it-out** | "Convert it." | From a critical moment, play to resolution vs. Maia | Situational | Conversion vs. reference outcome | Maia (opponent) + engine (referee) |

## Notes per type

**Concrete.** Recognition → automaticity. This is classic tactics done well: curated,
motif-dense sets so a theme is drilled 40× across 40 boards; the position is a
disposable vehicle for the motif. Forgetting *between* cycles is load-bearing.

**Evaluative.** The heart of the differentiator and the hard content problem. No
forcing resolution, so "wrong" is usually a *reasonable* move that isn't the priyome.
Grading is slow (2–5 min/position), which caps set size at ~150–250. Tier + justify.
Never reuse the tactics dashboard here (constitution §9).

**Technique.** This is where "no memorizing" is deliberately relaxed — Philidor isn't
a book line, it's an algorithm with a proof. ~15% of what separates 1600 from 2000,
cheap and permanent. Quarantine it; don't fight it.

**Prophylactic.** Aagaard's "what does he want?" prompt. Trainable, usually omitted by
existing trainers, cheap to add once we have annotated positions. Likely a *lens* over
evaluative items in early phases rather than a separate content pool.

**Play-it-out.** Plugs the biggest hole in single-move trainers: they structurally
cannot train calculation stamina or grinding technique. From the critical moment,
against a *human-like* opponent (Maia), to conversion. Depends on a Maia backend, so
it lands in a later phase (see [roadmap.md](roadmap.md)).

## The classifier (heuristic)

- Does any forcing move swing eval > ~0.5? → **concrete**
- Few enough pieces / tablebase-reachable & procedural? → **technique**
- Quiet position with shallow-vs-deep eval disagreement? → **evaluative**
- (Prophylactic and play-it-out are usually assigned by curation, not auto-classified.)

Good enough to bootstrap; wrong sometimes; improved as content is curated by hand.
