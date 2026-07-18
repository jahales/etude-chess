# First deliverable — the multi-mode drill trainer (medium-term)

> Living document — a **proposal**, not a locked spec.
>
> **⚠️ Superseded as the *literal first* release.** After the Southwick et al. 2026 evidence
> (game review ≫ tactics puzzles per hour), the concrete first release is now the
> **personalized game-review loop** in [v0.1.0-plan.md](v0.1.0-plan.md) (ADR
> [0011](decisions/0011-game-review-first.md)). This document remains the picture of the
> **three drill modes** — they're still built, as v0.2–v0.4, and *fed by* the review loop
> (drills sourced from your own mistakes). Read v0.1.0-plan.md first; read this for where the
> modes are heading.

## Who it's for
**You: a USCF ~1200 player.** Not a generic audience. That focuses v0 hard: below
~1800, results are dominated by a short list of skills, so v0 trains exactly those and
nothing else. This also means v0 is *band-fixed* (~1000–1400) — no skill model, no
adaptivity, just the right curriculum for this band.

## Why these three skills, in this order
Grounded in [learning-science.md](learning-science.md) and the stated need to "navigate
openings without taking too much damage":

1. **Tactics (concrete)** — highest ROI at this level, full stop. Results below 1800 are
   decided by who hangs less and who spots the shot. Most proven, most buildable.
2. **Opening survival (evaluative + trap-avoidance)** — directly addresses "don't take
   too much damage." *Not* memorizing lines: reach a playable middlegame, don't walk into
   common traps, know the basic plan of your structures.
3. **Endgame technique (procedural)** — cheap, permanent, high-ROI. A handful of
   algorithms (opposition, Lucena, Philidor, basic pawn endings, K+Q/K+R mates) that
   simply convert half-points into points for the rest of your chess life.

## Scope of v0

### Mode 1 — Tactics (concrete)
- **Content:** Lichess puzzle DB (tagged by theme + rating) filtered to ~1000–1400 and to
  a chosen set of motifs. *We do not build our own classifier yet* — the Lichess tags are
  good enough to start (ADR [0003](decisions/0003-human-frequency-not-engine-topn.md) is
  about evaluative candidates, not this).
- **Format:** find the move/line; graded by the engine.
- **Scheduling:** Woodpecker-style set cycles over a fixed 200–400 puzzle set, plus a
  mistake-review queue resurfacing misses at 1/3/7/14/30 days.
- **Metric:** seconds/position + accuracy (this is the one mode where a speed dashboard
  is *correct*).

### Mode 2 — Opening survival (evaluative + trap-avoidance)
- **Content:** derived from *your* actual openings (import a handful of games, or pick a
  starter repertoire). From the Lichess opening explorer, mine positions where a
  high-frequency human move carries a real eval drop → **frequency-weighted regret** →
  traps and quiet concessions. Small curated set (tens, not hundreds) for v0.
- **Format:** two sub-tasks — (a) *tier the candidates* A/B/C **and name the problem**
  ("this pawn push concedes d5"); (b) *structure/plan recognition* ("what structure is
  this, what's the plan / first move"). Justification captured as telemetry.
- **Scheduling:** family rotation (different position, same idea); long intervals.
- **Metric:** correct tier + can you name the feature. **No speed dashboard** here
  (constitution §9).
- **Grading in v0:** engine for the tier; justification stored and *coarsely* checked
  (keyword/LLM-light) — full LLM grading is Phase 2.

### Mode 3 — Endgame technique (procedural)
- **Content:** a small fixed curriculum — K+Q vs K, K+R vs K, opposition & key squares,
  Lucena, Philidor, Vancura, rule of the square, outside passed pawn.
- **Format:** play out the procedure against best defense; adjudicated by
  Stockfish/Syzygy (Lichess tablebase API).
- **Scheduling:** plain declarative SRS.
- **Metric:** pass/fail on executing the procedure, then speed.

### Cross-cutting in v0
- **Justification capture** on all evaluative items from day one — even coarsely graded,
  it's the telemetry seed the whole learner model later depends on. Store every attempt.
- **Hidden-mode mixed-queue toggle** — an optional session mode that draws from all three
  without announcing which. Even a crude version exercises the differentiator and starts
  generating mode-selection data. Blocked-by-mode is the default for acquisition; mixed is
  opt-in for transfer (matches the interleaving evidence: block to acquire, interleave to
  transfer).

## Explicitly deferred (do NOT build in v0)
Mode classifier · Maia / play-it-out · multidimensional skill model · adaptive selection
· the priyome ontology at scale · full LLM justification grading · prophylactic mode ·
multi-user / accounts / sync.

## Tech-stack proposal (not locked)
Optimized for a solo builder shipping fast and staying fully client-side at first:
- **App:** TypeScript + a lightweight SPA framework (React or Svelte).
- **Board / rules:** [chessground](https://github.com/lichess-org/chessground) (board UI)
  + [chess.js](https://github.com/jhlywa/chess.js) (move gen/validation).
- **Engine (referee):** Stockfish compiled to WASM, in-browser.
- **Data:** Lichess puzzle DB (download a filtered slice); Lichess opening-explorer &
  tablebase APIs at runtime.
- **Storage:** local-first (IndexedDB) — no backend needed for v0. A backend arrives with
  Maia in Phase 3.

Open stack questions (native/offline? Python data-prep side? hosting?) live in
[open-questions.md](open-questions.md).

## What success for v0 looks like (be honest)
- You use it daily and it feels like it teaches — subjective, but real.
- It captures justification + mode-selection telemetry cleanly.
- It's enough to *feel out* whether the tiering task is pedagogically alive.

It does **not** prove transfer to real games — that needs held-out test infrastructure
and game-import measurement, which are later phases. v0 is a probe, not a proof.
