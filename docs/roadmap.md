# Roadmap

> Living document. Provisional and expected to reorder as we learn. The sequencing
> principle is fixed even if the contents aren't: **content and curricula first, the
> adaptive skill model last** (constitution §11, ADR
> [0007](decisions/0007-content-first-adaptive-last.md)).

The reason for this order: adaptivity multiplies the content problem. A fixed curriculum
needs ~1 item per cell; adaptive selection needs a *dense* pool across all of them —
roughly 200 skills × ~30 items × a held-out split ≈ **6,000+ annotated positions**.
Building the model before the data-generating loop exists is the classic ML mistake.

> **Restructured 2026-07-19.** Versions are now the spine (the old Phase 1–4 numbering had
> Phase 1 containing the whole product and the differentiator scheduled *before* the content
> it consumes). Foundations are done; the mid-game intervention and play-it-out were absorbed
> into v0.2/v0.3. The ordering principle (ADR 0007) is unchanged — content still precedes
> the queue and the model.

## Shipped
- **v0.1.0 — 2026-07-18.** Coached **guess-the-move** on master games: commit a move + a
  one-line reason → win%-swing tier → coached reveal. (ADRs
  [0011](decisions/0011-game-review-first.md), [0014](decisions/0014-v0.1.0-guess-the-move.md).)
- **v0.2.0 — 2026-07-18.** **Play vs client-side Maia** (1100–1900) with an ambient in-game
  coach, "Show me", toggleable evaluation, accuracy + take-back count, post-game review with
  by-phase analytics. (ADRs [0013](decisions/0013-v0.1.0-play-vs-maia.md),
  [0016](decisions/0016-maia-onnx-delivery.md), [0017](decisions/0017-in-game-coach.md) —
  0017 absorbed the mid-game "step back and analyze".)

## v0.3.0 — Complete the core loops (next)
Deepen the two existing modes before widening: today both modes end at "understanding" and
drop the thread — a flagged mistake has no path back into practice. v0.3 closes the loop and
makes the app feel like one product. **Full design: [v0.3.0-plan.md](v0.3.0-plan.md)**;
tracked as the **v0.3.0 milestone** on GitHub.
- Persist the coach's data with each game; **game library + replay** (#39) — "Worth another
  look" becomes clickable.
- **Play it out from here** vs Maia (the play-it-out task, arriving early) and the
  **opening picker** (#41) — both ride the same start-from-position plumbing.
- Guess-the-move loop closers: **drill your misses**, your **reason reflected back** at the
  reveal, the same **accuracy** metric as play mode.
- **Click through engine lines on the board**; richer play-mode "why".
- **Curated pack: 3 → ~15 annotated classics** (our own annotations).
- **Attach your own game database (#40)** — PGN import (parse/filter/index locally), browse +
  search, and study any imported game, with its annotations shown when present. Per ADR
  [0018](decisions/0018-games-corpus-and-annotations.md) we **ship no corpus**: users bring
  their own, which is what makes it legally clean *and* gives access to the strongest OTB
  material. Defaults prefer standard/classical over blitz/rapid.
- **Landing redesign** (mode cards + focused setup screens, live stats) and a **theme
  toggle + dark-palette retune** (#42).

## v0.4.0 — Opening safety
Trap avoidance + structure/plans from your opening leaks (v0.2/v0.3 telemetry says where you
bleed; an attached database supplies the material; the v0.3 opening picker supplies the drill
vehicle). *Moved up: the old v0.4 "games corpus" slot is largely answered by bring-your-own
import in v0.3 — the pool now comes from the user, not from us.*

## v0.5.0 — Endgame technique
Tablebase-adjudicated technique curriculum (Syzygy; constitution §7).

## v0.6.0+ — The hidden-mode mixed queue
The differentiator (constitution §2, ADR [0002](decisions/0002-hidden-mode-mixed-queue.md)):
one queue across decision types with the mode concealed. Deliberately last of the curricula —
it is a queue *over a pool*, so it needs the pool (the user's attached database, v0.3) and the
per-type item sources (v0.3 own-game drills, v0.4 opening, v0.5 endgame) to exist first.

## Ongoing / cross-cutting
- **Content pipeline & the evaluative core** (feeds v0.4–v0.6): frequency-weighted-regret
  miner over Lichess data, the "tactics-in-a-trenchcoat" filter, priyome taxonomy seeding,
  LLM justification grading against annotations (#13), family scheduling + held-out sets.
- **Position search / opening explorer** over an attached database ("find games reaching this
  position"). Deferred; the spike found brute-force replay beats a Zobrist index at our scale
  (~2 B/move ⇒ 100k games ≈ 16 MB, smaller than the index).
- **Justification capture** and honest metrics apply from v0.1.0 onward (telemetry seed).

## Last — the learner model & adaptivity
Only once the above generates dense, labeled telemetry: multidimensional IRT skill vector
(ADR [0008](decisions/0008-skill-model-multidim-irt.md)), cold-start from imported games,
ROI-/band-weighted selection, and finally the adaptive queue.

## What "done" is not
There is no phase where we claim to train *all* of chess. The ceiling
([vision.md](vision.md)) is an asymptote. Clock, calculation stamina, and practical
defense stay out of scope regardless of phase.
