# Glossary

> Living document. This is also the seed of the domain **ontology** — the set of
> families, motifs, and structures the system trains against is the real deliverable
> (see [vision.md](vision.md)). As that ontology grows it may move into its own
> structured file/data; for now, definitions live here.

## Core concepts

**Decision type / mode.** The kind of judgment a position demands: *concrete*,
*evaluative*, *technique*, *prophylactic*, or *play-it-out*. The top-level axis of the
system. See [decision-types.md](decision-types.md).

**Hidden-mode mixed queue.** A review queue drawing from all modes without telling the
solver which mode the current position is. The product's core differentiator; it trains
mode-*selection*, the dominant over-the-board error class from 1200–2000.

**Priyome** (приём). A standard, reusable method/plan associated with a pawn structure
or position type (e.g. the minority attack in the Carlsbad, the Nd5 outpost). The unit
of evaluative content. Borrowed as a term from Russian chess pedagogy; central to Axel
Smith's *The Woodpecker Method 2*.

**Family.** A set of *different* positions sharing a priyome/structure/motif. We
schedule and rotate *families*, not positions, for evaluative work — rep 2 is a fresh
member, forcing re-derivation rather than recall.

**Tiering (A / B / C).** Bucketing candidate moves by eval gap rather than ranking them:
**A** ≈ within ~0.15 of best (playable); **B** ≈ 0.15–0.5 (a real concession); **C** >
~0.5 (structurally bad). We grade tier assignment (Kendall's tau with ties), weighting
A-vs-C over A-vs-B. Ranking *within* a tier is an engine artifact and is never graded.

**Frequency-weighted regret.** The curation signal for evaluative items and traps:
`human_move_frequency × eval_drop`. A move many players choose that quietly costs eval is
a better exercise than the engine's fourth choice. Sourced from human data, scored by
engine. A trap is simply a high-frequency, high-regret move.

**Justification.** The feature/plan the solver states with a move ("this concedes d5
permanently"). Required. Doubles as **telemetry**: comparing stated feature vs. chosen
move disambiguates *why* an attempt failed (missed motif vs. miscalculation vs. guess).

**Tactics wearing a trenchcoat.** A quiet-looking position whose eval gap is actually
explained by a short forcing line — i.e. a concrete item masquerading as evaluative.
Filtered out via forcing-line search or shallow-vs-deep eval agreement.

**Mode classifier.** The heuristic that assigns a decision type to a position (forcing
swing > 0.5 → concrete; procedural/tablebase → technique; shallow-deep disagreement in a
quiet position → evaluative). Automatable and "good enough"; refined by hand curation.

**Guess-the-move (solitaire chess).** The classic training format: play through a master game
from one side, committing your move before seeing the master's. Our version differs from every
existing implementation (ChessTempo, chessgames.com, Lucas Chess): moves are graded by
**win%-swing tier** so an engine-equal alternative earns full credit (not "did you match the
master"), and each commitment carries a **justification** captured as telemetry. The v0.1.0
deliverable (ADR [0014](decisions/0014-v0.1.0-guess-the-move.md)); pedagogically, the
retrieval-first version of "serious study" of master games (Charness) and the self-serve analog
of lessons (Southwick).

**Held-out (test) set.** A slice of each evaluative family that is *never* drilled, used
to measure whether a priyome was learned vs. whether cards were memorized. A train/test
split for skill.

**Band / band-conditional.** A rating range (e.g. 1000–1400). Training priority,
scaffolding, and difficulty are conditioned on the learner's band rather than uniform —
required by the expertise-reversal effect (see [learning-science.md](learning-science.md)).

**Skill vector (multidimensional IRT).** The intended learner model: not a scalar rating
but a vector over ~200 skill dimensions (per-motif, per-priyome, per-technique,
per-structure), estimated with multidimensional Item Response Theory and a hierarchical
prior that partially pools evidence across the taxonomy. Deferred to a late phase; see
ADR [0008](decisions/0008-skill-model-multidim-irt.md).

**Credit assignment.** The problem of deciding *which* skill a pass/fail should update.
A binary outcome can't; the justification channel is what makes it identifiable.

**Fact bundle.** The structured, code-computed description of a position handed to the LLM —
FEN, material, eval + win%, best move + PV (SAN), played-move win%-swing tier,
hanging/underdefended pieces, null-move threats, structural notes. The LLM *only*
paraphrases/grades against it and may invent nothing; every move it emits is validated against
chess.js. See ADR [0012](decisions/0012-llm-grounded-explainer.md).

**SEE (Static Exchange Evaluation).** A capture-sequence resolution that determines whether a
piece truly hangs / a capture wins material, correctly handling cheap-attacker-beats-expensive,
pinned defenders, x-ray, and value ordering. **Not provided by any chess library or exposed by
Stockfish** — must be hand-implemented (chessprogramming.org). Required for trustworthy
"hangs/wins material" facts.

**Grounded explainer.** The role the LLM plays: a renderer/grader over engine-computed facts,
never an evaluator, calculator, or legality judge. In 2026 unguided LLMs hallucinate illegal
moves in ~46% of chess commentary; grounding + move-validation is what makes them usable.

## External tools & data sources

**Stockfish.** Strongest open-source engine. Our **referee / grader**, never the
opponent. Runs as WASM in-browser for v0.

**Maia.** A neural engine trained to *predict human moves* rather than find optimal
ones, tunable to a target rating (~600–2600); reproduces human-like mistakes. Our
sparring **opponent** for the play-it-out mode. (Maia-3 / "Chessformer" is the current
most-accurate human-move predictor.) Requires a backend → later phase. The Maia Platform
already pairs Maia predictions with Stockfish eval for rating-aware feedback — worth
studying before building our own dual-signal feedback.

**Syzygy tablebases.** Perfect-play data for positions with ≤7 pieces. Adjudicates
**technique** mode. Reachable via the Lichess tablebase API for v0.

**Lichess Open Database / Opening Explorer.** Human move-frequency data (all players and
masters DB) — the source for frequency-weighted regret and trap curation. Public API.

**Lichess puzzle database.** ~4M+ tagged puzzles with themes and ratings. Pragmatic v0
source for concrete-mode content so we don't build our own classifier on day one.

**chessground / chess.js.** Lichess's board UI component / a JS move-generation &
validation library. Candidate front-end building blocks (see
[first-deliverable.md](first-deliverable.md)).

## Prior art (not competitors so much as reference)
- **The Woodpecker Method** (Smith & Tikkanen) — cyclic tactics drilling; our concrete
  scheduling model.
- **The Woodpecker Method 2: Positional Play** (Smith, 2024) — 1,000 positional
  exercises; the seed for our evaluative taxonomy. Deliberately *not* eval-selected.
- **Disco Chess** — cyclic trainer with a mistake-review queue (1/3/7/14/30d) and
  selectable set sizes; its efficiency-multiplier metric is a cautionary tale for
  evaluative material.
- **Move by Move** series (Everyman) — the commit-then-explain format, in book form.
- **ChessTraining.app** — endgames + visualization alongside cycles; closest to unified,
  but nobody has done the hidden-mode queue.
