# Backlog — epics, in priority order

> **How to read this.** These are **epics**: units of *work*, ordered by priority. There are no
> version numbers here on purpose (ADR [0020](decisions/0020-backlog-of-epics.md)). A version is
> a **cut** — we take epics, or slices of them, off the top of this list, commit to them, and
> *then* create a milestone. A milestone therefore only ever describes work we are actually
> doing or have shipped, never work we merely intend.
>
> Reordering this list is a one-line edit. That is the point: the previous version-spine
> structure was renumbered twice in one week without any of the underlying work changing.
>
> The sequencing principle that *is* fixed: **content and curricula first, the adaptive skill
> model last** (constitution §11, ADR [0007](decisions/0007-content-first-adaptive-last.md)).
> Adaptivity multiplies the content problem — a fixed curriculum needs ~1 item per cell, while
> adaptive selection needs a *dense* pool across all of them (~200 skills × ~30 items × a
> held-out split ≈ **6,000+ annotated positions**). Building the model before the
> data-generating loop exists is the classic ML mistake.

## Shipped
- **v0.1.0 — 2026-07-18.** Coached **guess-the-move** on master games: commit a move + a
  one-line reason → win%-swing tier → coached reveal. (ADRs
  [0011](decisions/0011-game-review-first.md), [0014](decisions/0014-v0.1.0-guess-the-move.md).)
- **v0.2.0 — 2026-07-18.** **Play vs client-side Maia** (1100–1900) with an ambient in-game
  coach, "Show me", toggleable evaluation, accuracy + take-back count, post-game review.
  (ADRs [0013](decisions/0013-v0.1.0-play-vs-maia.md),
  [0016](decisions/0016-maia-onnx-delivery.md), [0017](decisions/0017-in-game-coach.md).)

## In flight
**v0.3.0 — harden the core.** Three modes now exist (study a master game, play a coached game,
review your own games) and a lot of surface landed fast. **This cut adds no features**: it makes
what exists trustworthy. Tracked as the **v0.3.0** milestone.

---

## The backlog

### 1. Hardening · `epic:hardening`
Make the three shipped modes robust before widening. At the top because the defect rate while
building them was high, and because CI proves less than it appears to — **4 of 7 e2e specs skip
there** for want of the Maia nets.

Real CI coverage; correctness of the numbers we display (#74); storage durability
(`navigator.storage.persist()` — the library can be evicted today); behaviour on long games, on
failure paths, and at scale; a review pass over the *assembled* surface rather than per-diff.

- **Depends on:** nothing. **Blocks:** trusting anything below it.

### 2. Bring your own game database · `epic:database`
Attach your own PGN, browse and search it, study any game in it — with its annotations when
present. We ship **no** corpus (ADR [0018](decisions/0018-games-corpus-and-annotations.md)):
users bring their own, which is what makes it legally clean *and* gives access to the strongest
OTB material. #53, #54, #55; source guidance and the export boundary in #70.

- **Why this high:** it supplies the pool that everything downstream explains, drills and queues
  over.
- **Depends on:** hardening — it is the largest new build, and starting it on a shaky base is
  how a hardening release stops being one.

### 3. The "why" layer · `epic:why-layer`
The differentiator. An engine gives the *what* (best move) and the *how much* (eval delta);
neither teaches. The payload is the **transferable** reason — and for our band the teacher's
reason beats the engine's *even when* a concrete line is the true cause, because a principle
carries to the next position and a 20-ply line does not
([research/effectiveness.md §7](research/effectiveness.md)). Route, honesty gate and the
ontology workstream: ADR [0019](decisions/0019-why-layer-next.md). #64, #50.

- **Depends on:** a corpus to seed the grounding ontology from — hence *after* the database.
  That reordering is what prompted ADR 0020.
- **Bottleneck:** annotation / ontology labor, below.

### 4. Close the review loop · `epic:review-loop`
Every flagged mistake gets a path back into practice: drill your misses (#49), play it out from
here (#48), your reason reflected back at the reveal, one metric language across modes (#65), a
richer curated pack (#51).

- **Depends on:** review existing (done), and the "why" layer for the explanations it drills on.

### 5. Opening safety · `epic:opening`
Trap avoidance plus structures and plans, sourced from where *you* actually bleed. The opening
picker (#41) is the drill vehicle; an attached database supplies the material.

- **Depends on:** the database (material) and review-loop telemetry (targets).

### 6. Endgame technique · `epic:endgame`
Tablebase-adjudicated technique curriculum (Syzygy; constitution §7).

### 7. The hidden-mode mixed queue · `epic:mixed-queue`
The long-term differentiator (constitution §2, ADR
[0002](decisions/0002-hidden-mode-mixed-queue.md)): one queue across decision types with the
mode concealed. Deliberately late — it is a queue *over a pool*, so it needs the pool and the
per-type item sources to exist, and a queue serving **un-explained** items inherits the
commodity problem rather than solving it.

- **Depends on:** the database, the "why" layer, and the per-type sources above.

### 8. Polish · `epic:polish`
Theme toggle and dark-palette retune (#42), underpromotion picker (#43), replay autoplay (#69).
Real, small, and never urgent.

---

## Cross-cutting — not epics, but always true

- **Annotation / ontology labor is the project's critical path.** It appears twice
  independently: the positional taxonomy, and the grounding ontology for the "why" layer. Two
  independent appearances is the signal that it *is* the bottleneck — not tooling, schedulers or
  engine integration, which are solved or easy. Attack it as its own workstream: seed from
  **CC0** sources, generate candidates from engine lines over a corpus, **human spot-check a
  sample**. The goal is to attack the labor, not to hand-author 1,000 positions.
- **The dependency chain** — why the order above is not a preference:

  ```
  play (Maia, coached)  ->  review  ->  { personalized tactics queue }
                                        { opening-safety queue       }
                                        { skill / leak diagnosis     }
  ```

  Three of the five curriculum items are **downstream of review**: they are sourced from the
  user's own misses, which do not exist until the review loop does. Do not build the tactics
  generator before the loop that feeds it.
- **Position search / opening explorer** over an attached database. Deferred; the spike found
  brute-force replay beats a Zobrist index at our scale (100k games ≈ 16 MB of movetext against
  ~92 MB of index).
- **Justification capture and honest metrics** apply from v0.1.0 onward (telemetry seed).
- **What to trust:** rated game rating is the only real metric, and it moves slowly. **Puzzle
  rating will climb faster and will lie.** The earliest honest leading indicator is your own
  blunder rate per game from the review loop (#65).

## Last — the learner model and adaptivity
Only once the above generates dense, labeled telemetry: multidimensional IRT skill vector
(ADR [0008](decisions/0008-skill-model-multidim-irt.md)), cold-start from imported games,
ROI-/band-weighted selection, and finally the adaptive queue.

## What "done" is not
There is no point at which we claim to train *all* of chess. The ceiling
([vision.md](vision.md)) is an asymptote. Clock, calculation stamina, and practical defense stay
out of scope regardless of what ships.
