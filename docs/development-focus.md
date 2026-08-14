# Development focus — where the leverage is

> Forward-looking companion to [backlog.md](backlog.md). The backlog says *what* ships in
> what order; this says *why these and not the tempting alternatives*, and what the one
> real bottleneck is. Written 2026-07-18 alongside the rev. 2 research update
> ([research/effectiveness.md §7–8](research/effectiveness.md)). Treat as a standing
> "read this before adding a mode" note.
>
> **Status, 2026-08-14: P1 shipped in v0.3.0, P0 has not started.** The priority order below
> is unchanged and still binding — read the P0 section as the live one. The "next slot"
> language in P1 predates ADR [0020](decisions/0020-backlog-of-epics.md); versions are cuts
> now, so the ordering here is an argument about epics, not about release numbers.

## The one-line version

**Depth over breadth. Build the "why" engine before any new mode. Then close the
produce→review loop inside one app.** Three modes now ship — and the third, reviewing your own
games, is P1 below rather than a breadth addition, which is the distinction this note exists to
hold. The value now is in making those three teach, not in adding a fourth.

## Why not "add more modes"

The instinct at v0.2 is to add prophylaxis drills, a calculation trainer, an opening
module, etc. Resist it. Every mode you add is content you must annotate (§7 bottleneck)
and a dilution of the thing that actually differentiates us. The evidence
([effectiveness.md §0](research/effectiveness.md)) says the win is *depth of teaching on
high-yield activities*, not *coverage*. Adaptive selection across many thin modes is also
premature — it needs a **dense** content pool per cell to select from, which we don't have.
Curricula/quality first, adaptivity last (unchanged from the roadmap thesis).

## Priorities, in order

### P0 — The "why" layer on the modes we already have
The single highest-leverage build. A guess-the-move / review that grades correct-vs-incorrect
is a commodity ([effectiveness.md §5b](research/effectiveness.md)); one that explains *why the
better move is better, in transferable human language,* is the artifact that does not exist
anywhere ([§7](research/effectiveness.md)). This is the moat.

- Route: **hybrid** — LLM explanation **grounded in a concept ontology** (priyome families,
  imbalance types) and **cross-checked against the engine line** for factual consistency.
  Not free-form LLM (hallucinates, and the target user can't detect it); not raw
  literature (copyright).
- The teacher's reason ≠ the engine's reason, and for our rating band the teacher's version
  is the target output even when the engine line is the "true" cause. Build for the
  *pedagogically optimal* explanation, not the engine's.
- Honesty gate: an explanation must be *checkable* (against the engine line and the ontology)
  before it's shown. A confidently wrong "why" is worse than none.

### P1 — The own-game review loop — **shipped in v0.3.0, 2026-08-14**
It is the highest-yield *activity* ([effectiveness.md §0](research/effectiveness.md), 4.4
pts/hr) **and** the unlock for the dependency chain below, which is why it outranked
everything except the "why" layer.

**Shipped in-app:** every game is stored, the library opens it, replay steps through it, a
whole-game pass scores every position, and the worst moves are listed as buttons that jump to
the position (#39, #46, #47, #67, #68). Off-app, `npm run review` does the same for a real
chess.com game.

**Two parts of the shape above did not ship**, and neither is an oversight to quietly close:
*commit-a-move-before-reveal on your own games* — replay is read-only, you step through it,
you don't re-decide — and *the "why"*, which is P0 and still unbuilt. So the loop now surfaces
the decisive moments; it does not yet make you re-decide them or explain them. The first is
`epic:review-loop` in [backlog.md](backlog.md) (#48, #49, #65); the second is P0 above.

### P2 — Wire produce→review into a single in-app cycle — **half shipped**
The feature that fits a time-constrained user's life: a **timed Maia game that flows
directly into the review loop with no import/export step.** "Generate a reviewable game and
review it in the same place" removes the friction that kills every other tool's review habit.
Closing this loop inside one app is a bigger differentiator than mode count.

**The no-import-step half shipped with P1**: a finished Maia game is already in the library and
already reviewable, with nothing to export. **The *timed* half has not** — the app has no
clock, so what it produces is untimed practice. Worth flagging rather than leaving implicit,
because [backlog.md](backlog.md)'s "what done is not" holds clock *management* out of scope as
a thing we train, which is not the same as deciding never to run one. Nobody has decided;
`npm run review`'s phase-vs-clock split reads clocks from imported PGNs, so the appetite is
there. Pressure errors are what an untimed game cannot generate (§8 below).
See [effectiveness.md §8](research/effectiveness.md) for the timed / correspondence / real-rated
distinction — timed Maia is the sustainable default; keep the occasional real rated game in
the user's mental model as the calibration Maia can't provide (pressure errors).

## The dependency chain (draw this on every planning doc)

```
play (timed Maia, opening pre-played)  ─►  review  ─►  { personalized tactics queue }
                                                        { opening-safety queue        }
                                                        { skill/leak diagnosis        }
```

Three of the five curriculum items are **downstream of review.** Reformed tactics and
opening-safety drills are sourced from the user's *own misses*, which don't exist until the
review loop does. So sequencing is not a preference — it's forced by the data flow. Don't
build the tactics generator before the loop that feeds it.

## The bottleneck (name it, fund it)

**Annotation / ontology labor.** It appears twice: (1) the positional/priyome taxonomy for
curation, (2) the grounding ontology for the P0 "why" layer. Two independent appearances of
the same bottleneck is the signal that it *is* the project's critical path — not the tooling,
not the schedulers, not the engine integration (those are solved or easy).

Attack it as its own workstream, not as a side effect of feature work:
- Seed from **CC0 sources** (Lichess games/puzzles, Syzygy) — never ingest copyrighted
  annotations (Silman/Dvoretsky text is copyrightable; the *concepts* are not).
- Semi-automate: generate candidate annotations from engine lines against a corpus of master
  games, **human spot-check a sample**, ship. The goal is to attack the labor bottleneck, not
  to hand-author 1,000 positions the way the source books did.

## Measurement — what to trust, what lies

- **The only real metric is rated game rating.** It moves slowly and noisily; expect months,
  not weeks, of signal. Steer by it anyway.
- **Puzzle rating will climb faster and will lie** about improvement ([effectiveness.md §2](research/effectiveness.md)).
  Do not use it as a success metric.
- **Leading indicator worth logging:** the user's own **blunder rate per game** from the review
  loop. It's the earliest honest signal, and — because the maintainer is dogfooding at ~1355,
  the band where the P0 "why" layer matters most — it doubles as the project's only cheap
  validation data. Instrument it from the start.
  **Instrumented 2026-08-14 (#65)**, in the library. What it shows and — more to the point —
  what it deliberately does not (no trend, no goal, no bar; only games a completed analysis
  measured in full): ADR
  [0027](decisions/0027-blunder-rate-as-the-leading-indicator.md).

## Invariant (never violate, regardless of feature)

**Store the motif, draw a fresh instance.** Never SRS a literal tactic FEN
([effectiveness.md §0.5, §3](research/effectiveness.md)). And **never reveal before the user
commits a move and a reason.** These two rules are doing more work than any choice of activity;
they should survive every refactor.

## Not now (explicit deferrals)

- **New modes** (prophylaxis, standalone calculation trainer, full opening course) — after P0/P1/P2.
- **Adaptive item selection / skill-vector engine** — needs a dense annotated pool first
  (~6,000+ positions across cells); build the data-generating loop before the model.
- **Personalized per-player models** — data-hungry and a privacy liability (stylometry
  re-identifies the player); if ever built, user-scoped, consented, non-exportable.
