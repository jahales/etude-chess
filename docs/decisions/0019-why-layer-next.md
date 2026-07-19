# 0019 — The "why" layer is the next major build, via a grounded concept ontology

**Status:** Accepted · 2026-07-18 · **sequencing clause superseded by ADR
[0020](0020-backlog-of-epics.md) (2026-07-19)** — the *reasoning* below stands and remains the
argument for the epic's priority; what is withdrawn is the claim that the layer *is v0.4.0*.
Versions are no longer planned in advance. The epic sits below the database in
[../backlog.md](../backlog.md), because the grounding ontology is seeded from a corpus.
**Extends:** ADR [0012](0012-llm-grounded-explainer.md) (the LLM renders facts, never evaluates)
and ADR [0007](0007-content-first-adaptive-last.md) (content first, adaptivity last).
**Evidence:** [../research/effectiveness.md §7](../research/effectiveness.md) ·
[../development-focus.md](../development-focus.md).

## Context
Two documents disagreed about what comes after v0.3, which is why this ADR exists.

The **roadmap** had v0.4 as opening safety, then endgame, then the mixed queue — a sequence of
**new modes**. The **development-focus** note, written alongside the rev. 2 research update,
says the opposite: build the *"why"* engine **before any new mode**, because

- an engine supplies the *what* (best move) and the *how much* (eval delta), and is
  essentially incapable of supplying the **why in transferable language** (§7);
- for a sub-~1800 player the **teacher's** reason is more useful than the engine's *even when
  the concrete line is the real cause*, because a principle transfers to the next position and
  a 20-ply line does not;
- a guess-the-move that grades correct/incorrect is a **commodity**; one that explains why is
  the artifact that does not exist anywhere.

Both claims can't drive planning. The roadmap is the document people follow, so it has to be
the one that changes.

## Decision

1. **The "why" layer is the next major release after v0.3.0**, ahead of opening safety,
   endgame technique and the mixed queue. Those move back one slot each. This is a
   *sequencing* reversal of the roadmap, not of ADR 0007 — content still precedes the skill
   model, and the "why" layer *is* content work.

2. **Route: hybrid — an LLM explanation anchored to a concept ontology and cross-checked
   against the engine line.** The three candidates and why the other two lose:

   | Route | Scales | Honest | Fails because |
   |---|---|---|---|
   | Free-form LLM | ✅ | ⚠️ | confident hallucination the target user cannot detect |
   | Curated from literature | ❌ | ✅ | annotations are copyrightable (ADR [0018](0018-games-corpus-and-annotations.md)) |
   | **Hybrid, ontology-grounded** | ✅ | ✅ | — but the ontology must be built |

   This is ADR 0012's mechanism (fact bundle in, paraphrase out, every move token validated)
   plus a **conceptual** vocabulary — priyome families, imbalance types — so the explanation
   can generalize rather than restate the line.

3. **The honesty gate is a hard gate.** An explanation must be *checkable* — against the engine
   line and against the ontology — before it is shown. Where it cannot be checked, we show the
   engine facts we already have and no prose. **A confidently wrong "why" is worse than none**
   (constitution §9, §12), because the learner it targets cannot detect the error. This is the
   principle that decides every later trade-off in the feature.

4. **Annotation / ontology labor is funded as its own workstream**, not as a side effect of
   feature work. It is the project's critical path: it appears twice independently — once for
   the positional taxonomy, once for explanation grounding — and that second appearance is what
   promotes it from "a task" to "the bottleneck". Seed from **CC0 sources**, generate candidates
   from engine lines over a master-game corpus, **human spot-check a sample**, ship. The goal is
   to attack the labor bottleneck, not to hand-author 1,000 positions the way the source books
   did.

5. **What we will not claim.** No "brilliant"/"great" style flourishes, and no glyph we cannot
   derive (see #67: `?!`/`?`/`??` come from swing tiers, `!` from only-move; `!!` and `!?` are
   human judgments and stay unshipped). Metrics describe *this* user's games; we claim no
   transfer we have not measured.

## Consequences
> ⚠️ Superseded by ADR [0020](0020-backlog-of-epics.md). Renumbering four releases to express
> one priority change is exactly the churn that motivated moving to a backlog of epics — this
> bullet is left in place as the evidence for that decision rather than edited away.
- ~~**v0.4.0 becomes the "why" layer**; opening safety → v0.5.0, endgame → v0.6.0, mixed queue →
  v0.7.0. Second renumbering in a week, which is the cost of the roadmap having been written
  before the rev. 2 research existed.~~
- The mixed queue moves further out. That is uncomfortable — it is the differentiator — but it
  is a *queue over a pool*, and a queue that serves un-explained items inherits the commodity
  problem rather than solving it.
- **v0.3 items that feed the "why" layer get priority within v0.3**: whole-game analysis (#68),
  honest annotations (#67), richer reveal (#50), drill-your-misses (#49). The remaining breadth
  work (#41 opening picker, #51 pack, #53–#55 import) is genuinely optional to v0.3.
- We accept a slower path to visible feature count in exchange for the one thing that is ours.

## Alternatives rejected
- **Keep the roadmap order and build opening safety next.** It is a new mode, so it multiplies
  the annotation problem before we have the tooling to attack it, and it ships more surface with
  the same semantic hole. Rejected.
- **Ship free-form LLM commentary now and tighten later.** Fastest to something impressive, and
  the failure mode is invisible to exactly the user we are building for. Rejected on
  constitution §9.
- **Treat the ontology as emergent from feature work.** It is the critical path; leaving it
  implicit is how it stays unbuilt. Rejected.
