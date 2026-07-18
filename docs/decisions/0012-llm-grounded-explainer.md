# 0012 — LLM is a grounded explainer/grader over engine facts, never an evaluator

**Status:** Accepted · 2026-07-17 · LLM usage itself is **deferred** (v0.1.0 ships no LLM)

## Context
We want an LLM for (a) plain-language "why this move is good/bad" in the review loop, (b)
**grading free-text justifications** (the ADR [0005](0005-justification-as-telemetry.md)
telemetry), and later (c) generating candidate annotations. Research
([../research/llm-integration.md](../research/llm-integration.md)) is unambiguous: in 2026 LLMs
are weak chess players, **cannot calculate**, and hallucinate illegal moves/nonexistent pieces
in ~46% of *unguided* chess commentary — but are fluent explainers *when handed the facts*. A
second finding shapes the tooling: modern Stockfish **no longer exposes an interpretable
term-by-term eval** (handcrafted eval removed 2023), so "position features" must largely be
computed by our own code.

## Decision
1. **The LLM never evaluates, calculates, or judges legality.** Stockfish + chess.js own every
   chess fact. The LLM only *paraphrases* and *grades against* facts.
2. **Everything flows through a code-computed "fact bundle"** per position — FEN, material,
   eval + win%, best move + PV (SAN), played move + win%-swing tier, hanging/underdefended
   pieces (via **SEE**, not raw counts), null-move-derived threats, and (later) structural notes.
   The bundle is the LLM's only input; it gets nothing it could invent.
3. **Post-validate every move token** the LLM emits against chess.js; restrict any move mention
   to the precomputed legal/PV set.
4. **Grader design** (for justifications): reference-guided, output **atomic enum labels not
   numeric scores**, **compute the calc/guess/credit/wrong quadrant in code**, CoT-before-verdict,
   majority vote N=3–5, and **validate against a human-labeled gold set (weighted κ ≥ 0.70)**
   before its output is trusted as skill telemetry.
5. **Model & delivery:** Haiku-class (`claude-haiku-4-5`) for high-volume explanation paraphrase
   and batch annotation; Sonnet-class (`claude-sonnet-5`) for the reliability-critical grader.
   Wrap the LLM behind a thin adapter (mirroring the `Engine` interface, ADR
   [0010](0010-engine-architecture.md)) so the model is a config choice. For the backendless app,
   use **BYOK** (user's own key in localStorage + the Anthropic direct-browser-access header) or
   a tiny serverless proxy — never embed a key in the bundle.

## Sequencing (lightest rung first — don't reinvent chat plumbing)
- **v0.1.0: no LLM integration.** Ship the "why" as **rules-based templates over the fact
  bundle** (hanging piece / big swing / better square), *plus* an optional **"copy fact bundle to
  clipboard"** button so the user can paste it into their own ChatGPT/Claude. Zero integration,
  zero cost, zero key handling — and it proves/defines the bundle format the LLM later consumes
  unchanged.
- **Next:** **BYOK** in-app calls (user's own key in localStorage) for the explanation layer.
- **Then** the grader (with the κ gold set). **Later:** batch annotation generation
  (human-spot-checked, attacks the content bottleneck, ADR [0007](0007-content-first-adaptive-last.md)),
  and optionally a **chess MCP** path for a coach that talks to the engine through a standard interface.

## Consequences
- Building the **fact bundle is real custom work** — SEE, hanging-piece logic, motif detection,
  structural classifiers — because no library and no modern engine hands them to us interpretably.
  This is now an explicit v0.1.0+ engineering line item, not a free import.
- Neural-net **concept probing** (McGrath/Maia-2/Karvonen) is noted as a possible Phase-2+ R&D
  path for evaluative-mode content, not adopted now.
- The honest-ceiling rule holds: the LLM cannot rescue "worse-but-tricky" practical decisions
  (constitution §12) — keep those out of the graded pool.
