# Vision

> Living document. Provisional. Last meaningful update: 2026-07-17.

## The problem this exists to solve

Two things a chess game structurally cannot give you, no matter how many you play:

1. **Density.** A 30-minute rated game contains maybe 3–5 genuinely instructive
   decisions. The rest is execution of things you already know.
2. **Retrieval.** The post-mortem is *study*, not *practice*. You read the answer;
   nothing ever tests whether you'd find it next time. And after 200 games you
   still have one bit of feedback (win/loss/draw) for ~40 decisions each — no usable
   signal about *which* skills are failing.

Everything in this system is in service of restoring density and retrieval, or of
*measuring* skill so training can be aimed. That is the entire value proposition,
and it is more modest than "universal trainer" implies. We state it plainly so we
don't oversell it to ourselves.

## The reframe that makes it coherent

Chess training is conventionally split by **phase** (opening / middlegame / endgame).
That is a book convention, not a training axis — openings contain tactics, endgames
contain positional judgment. The axis that actually partitions the *task* is the
**decision type** the position demands. See [decision-types.md](decision-types.md).

The payoff of unifying the types into one system is **the mixed queue with the mode
hidden**. Every existing trainer announces the mode ("here's a puzzle, find the win"),
which means you already know a forcing win exists before you look — so you calculate.
Real games never tell you. *Failing to notice a position has gone concrete, or
grinding for a combination in a position that only wants a plan, is the dominant
error class from 1200 to 2000.* A single queue where the position could be anything
is the only place that skill can be trained. It is the differentiator, not a
convenience feature. (ADR [0002](decisions/0002-hidden-mode-mixed-queue.md).)

## Who it's for

Players roughly **USCF 1200 and above**. The first deliverable is built for a
**~1200 player specifically** (see [first-deliverable.md](first-deliverable.md)),
because below ~1800 the results-limiting skills are concentrated and well understood:
tactics, not dying in the opening, and basic endgame technique.

## The honest ceiling

Estimated share of *trainable* skill this can touch:

- **~75%** at 1200–1600
- **~65%** at 1600–2000
- Erodes fast above 2000.

What it **cannot** train, and where we should not pretend otherwise:

- **Clock / time management** — no representation of it in single-position tasks.
- **Calculation depth & tree management** — holding and pruning a move tree without
  moving pieces is a distinct skill from pattern recognition. Woodpecker doesn't
  train it; neither does this. (The *play-it-out* task type is our partial hedge.)
- **Practical decisions in bad positions** — "objectively worse but sets a trap" is
  unrepresentable to an engine grader, which will actively misteach it.
- **Concrete opening prep above ~1900** — real theory memorization, which we
  deliberately refuse to build (ADR [0001](decisions/0001-decision-types-not-phases.md)).

The "n% of chess" figure is an **asymptote**, not a near-term plateau — worth
expanding toward, never worth claiming we've reached.

## Is it better than "just play rated games + post-mortem"?

Yes, but not either/or, and the gain is concentrated at the bottom of the range.
The expertise literature (Charness et al. on chess specifically) finds that serious,
solitary *study* predicts rating better than tournament-play hours do — structured
study beating "just play more" is about as well-supported as anything in this field.
Caveat: in those samples "serious study" meant analyzing master games and prep, *not*
puzzle drilling — so the evidence supports the **category**, not our specific
instantiation. That gap is exactly what our held-out test sets exist to measure.
See [learning-science.md](learning-science.md).

## The real bottleneck (say it out loud)

The hard part was never the scheduler or the UI. It is the **ontology and content**:
someone has to define the priyome/structure families and write the justifications we
grade against. Axel Smith spent years on 1,000 positions for *The Woodpecker Method 2*.
That labor — not the engineering — is why a system like this doesn't already exist.
Our bet is to attack the *content* bottleneck (seed a taxonomy, generate candidate
annotations, human-spot-check) rather than the tooling one. This is why the roadmap
builds curricula first and the adaptive engine last. (ADR
[0007](decisions/0007-content-first-adaptive-last.md).)
