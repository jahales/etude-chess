# Research: LLM integration & position-feature extraction

> Research digest, 2026-07-17. Answers: *how do we feed an LLM enough grounded truth about
> a position that its advice is trustworthy?* Feeds ADR
> [0012](../decisions/0012-llm-grounded-explainer.md). Evidence tags as in
> [effectiveness.md](effectiveness.md).

## The one-sentence answer
**The LLM never looks at the board or evaluates anything.** Your code computes a structured
**fact bundle** (engine eval + tactical + structural facts), the LLM only *paraphrases and
grades against* that bundle, and every move it might mention is validated against chess.js.
Everything below is about building that bundle and using it safely.

## 1. How good are LLMs at chess in 2026? (why the architecture is forced)
Weak-to-mediocre players, unreliable at board facts, **fluent explainers.** **[SOLID]**
- Even frontier/reasoning models sit ~1400–1700 Elo *at best* on lenient harnesses, far lower
  on strict ones, and get pushed into **illegal moves** within a few moves out-of-distribution.
- **Unguided GPT-4o references illegal moves or nonexistent pieces in ~46% of chess-commentary
  outputs** (Concept-guided Chess Commentary, Kim et al. 2024). Grounding with explicit facts
  sharply reduces this. https://arxiv.org/html/2410.20811v1
- LLMs **cannot calculate** — GPT-4o solves ~57% of *mate-in-one*, most models <12%. Deep
  tactics must come from the engine.
- The famous strong-chess neural nets (DeepMind's searchless 2895-Elo transformer; Maia) are
  **not language models** and produce no explanations.

**Implication:** let the LLM verbalize plans/motifs (it's good at that); let Stockfish + chess.js
own everything factual (legality, best move, eval). This exactly matches our existing ADRs
[0005](../decisions/0005-justification-as-telemetry.md)/[0010](../decisions/0010-engine-architecture.md).

## 2. Feature-extraction tooling — the honest landscape

### 2a. Engine-derived features (Stockfish) — **and an important correction**
- **The interpretable term-by-term `eval` table is GONE.** Stockfish removed handcrafted
  evaluation in 2023 (PR #4674). Modern Stockfish (16.1–18) has **NNUE only**, so `eval`
  no longer prints "King safety = X, Mobility = Y, Threats = Z." Don't design around it.
  https://github.com/official-stockfish/Stockfish/pull/4674
- **What you *can* get from the engine, and it's plenty:** eval in centipawns + **Lichess
  win%**; **best move + PV** (in SAN); **MultiPV** top-N lines (one pass gives you both the
  played move and the best, i.e. centipawn loss); **WDL** (`UCI_ShowWDL`, per-mille W/D/L);
  and, as a weak positional proxy, `eval`'s **"NNUE derived piece values"** grid (per-piece
  removal contribution — a decent "which piece is most valuable / hanging" signal, richer in
  SF18 which added "Threat Inputs").
- **"What does the best move threaten?"** — push a **null move** (`0000`) and re-search; the
  resulting line is the concrete threat the side-to-move holds. Standard technique, not a UCI
  command.
- **Determinism:** grade with `go nodes N` / fixed depth (not `movetime`) so features are
  reproducible.

### 2b. Rule-based primitives (chess.js / chessops / python-chess) — you get attacks, not tactics
These give **attackers/defenders, pins (absolute, to the king), checks, legal moves,
`is_attacked_by`** — but **none of them ship**:
- **SEE (Static Exchange Evaluation)** — *not in any of them.* You must hand-implement it
  (chessprogramming.org pseudocode) for a *trustworthy* "this piece hangs / wins material."
  Raw attacker/defender counts are wrong (they miss cheap-attacker-beats-expensive-defender,
  pinned defenders that can't recapture, x-ray, illegal king recaptures).
- **Tactic-motif detection** (fork/skewer/relative-pin/discovered) — build from attack-set
  intersections + ray geometry (`ray`/`between`).
- **"What changed between two plies"** (newly-attacked piece, opened file, weakened square) —
  no built-in diff; compute from piece-map + per-square attacker-set diffs.

Off-the-shelf option worth knowing: **ChessGrammar** (hosted API, FEN/PGN → fork/pin/skewer/
discovered/back-rank/… JSON, built on python-chess) — a shortcut for motifs, but a *third-party
hosted dependency* (verify licensing/stability). https://dev.to/stevejvv/i-built-an-api-that-detects-chess-tactical-patterns-from-fen-and-pgn-5ef0

### 2c. Structural concepts (pawn structure, outposts, files) — all custom
No library classifies IQP / Carlsbad / isolani / backward / passed / doubled, or outposts /
holes / open files / bad bishop / space. **All hand-written rule-based code** on top of bitboard
primitives; chessprogramming.org is the algorithm source, Stockfish `pawns.cpp` the C++
reference. Bishop-pair and open-file are trivial; the named structures are compositions.

### 2d. Neural-net concept probes (research path — defer)
Interpretability work (McGrath et al. *AlphaZero knowledge* PNAS 2022; **Maia-2** linear probes
for board-eval/piece-value/bishop-pair/captures, NeurIPS 2024; Karvonen's runnable
`chess_llm_interpretability` + SAE repos) can *extract* human concepts from network activations.
This is the principled long-term way to get "the model knows d5 is weak," but it's **research-grade
custom work** (AlphaZero weights are closed; Leela/Maia need your own harness). **Not v0.1.0** —
flag as a possible Phase-2+ R&D direction for the evaluative-mode content pipeline.
https://arxiv.org/abs/2111.09259 · https://arxiv.org/html/2409.20553v1 · https://github.com/adamkarvonen/chess_llm_interpretability

### 2e. Prior art for the whole "facts → explanation" pipeline
- **DecodeChess** — the market's best "explain the engine" tool — is **XAI/rule-based, NOT an
  LLM** (Stockfish NNUE + hand-built concept engine). Proof that grounded features + templates
  already explain well up to ~2000. Useful design reference.
- **python-chess-annotator / chess-artist** — rule-based PGN annotators; good reference for the
  fact bundle (NAGs by win%-swing, PV as "best was…", ACPL).
- **Lichess `Advice.scala`** — the canonical swing thresholds (**Inaccuracy 0.10 / Mistake 0.20
  / Blunder 0.30** in win-chance). Lichess has *no* positive tiers.
- **Patzer** — an LLM coach that keeps the LLM "render-only," facts computed in code — our
  closest architectural match. https://github.com/SikamikanikoBG/patzer
- **Concept-guided Chess Commentary (2024)** and **Grounded Chess Reasoning via Master
  Distillation (2026)** — both inject FEN + piece list + legal moves + scored concepts + engine
  PV; the academic validation of exactly this approach.

## 3. The fact bundle (concrete recommended schema)
Compute all of this in code per reviewed position; hand *only this* to the LLM:
```
{
  fen,                       // machine id the LLM echoes, does NOT reason over
  side_to_move, in_check,
  material, captured_pieces,
  eval_cp, win_pct,          // Stockfish + Lichess win% formula
  best_move_san, pv_san,     // engine PV rendered in SAN
  played_move_san, win_pct_swing, tier,   // Best/Inaccuracy/Mistake/Blunder by swing
  hanging_or_underdefended,  // via SEE, not raw counts
  threats,                   // null-move-derived, in words
  structural_notes           // (later) open files, weak squares, structure name
}
```
Rules (all **[SOLID]/consensus**): **never** give the LLM only a move list and ask it to infer
the board (state-tracking collapses); the input *notation* (FEN/PGN/ASCII) matters far less than
*adding these derived features*; **post-validate every move token** the LLM emits against
chess.js; forbid it from producing any eval/legality/best-move claim of its own.

## 4. LLM as grader of free-text justifications (our ADR 0005 telemetry)
LLM-as-judge is workable but biased; the mitigations that matter for short-text-vs-reference:
1. **Reference-guided** — give the judge the reference annotation as anchor (highest leverage).
2. **Constrain output to enum/atomic labels, not numeric scores** (numeric scores are the least
   reliable format). Emit `cited_features`, `feature_match: correct|partial|wrong`,
   `move_match: right|wrong`.
3. **Compute the quadrant in code**, not in the model: right-feature/wrong-move → *calculation*;
   wrong-feature/right-move → *guess (don't credit)*; right/right → *credit*; wrong/wrong →
   *wrong*. This IS ADR [0005](../decisions/0005-justification-as-telemetry.md), and it's
   deterministic/auditable.
4. **CoT-before-verdict, few-shot balanced across labels, majority vote N=3–5.**
5. **temp 0 is NOT reproducible** (GPU non-determinism) — chase *decision* stability, not
   bit-exactness.
6. **Validate before trusting as telemetry:** a human-labeled gold set (a few hundred, all four
   quadrants), report **weighted Cohen's κ / QWK ≥ 0.70**. This is the guard that keeps grader
   noise from swamping the skill model ([../open-questions.md](../open-questions.md)).

**For the v0.1.0 review loop specifically:** there are no hand-authored annotations yet, so
synthesize a **lightweight reference from the fact bundle** (best move + code-computed features)
and grade the justification against *that*. Real grading signal before the curated pool exists.

## 5. Practical: cost, latency, hosted vs local, and the browser key problem
- **Cost** (verified against the Claude API reference 2026-07; re-verify before relying):
  Claude **Haiku 4.5** `claude-haiku-4-5` ≈ $1/$5 per MTok in/out; **Sonnet 5** `claude-sonnet-5`
  ≈ $3/$15; **Opus 4.8** `claude-opus-4-8` ≈ $5/$25. A grounded explanation (~800 in/200 out)
  ≈ **$1.80/1,000 on Haiku**. **Batch API** = 50% off → ~$9 per 10,000 positions on Haiku for
  annotation. **Prompt-cache** the fixed rubric.
- **Model split:** Haiku-class for high-volume *explanation paraphrase* and *batch annotation*
  (it's just rendering grounded facts); **Sonnet-class for the reliability-critical grader**.
  Wrap the LLM behind a thin adapter (like the `Engine` interface) so the model is a config
  choice.
- **Latency:** hosted Haiku/Sonnet ≈ 1–3 s; local 8B via Ollama ≈ 10–20 s CPU / ~5 s GPU
  (breaks the review flow, and small models hallucinate more so grounding matters more).
- **The backendless constraint:** an **API key cannot be safely embedded in a browser bundle**.
  Two clean options: **(a) BYOK** — user pastes their own key into localStorage, app calls
  Anthropic directly with the `anthropic-dangerous-direct-browser-access` header (zero infra,
  privacy stays client-side — best fit for our local-first stance); **(b) a ~12-line serverless
  proxy** (Cloudflare Worker) if *we* pay for inference. v0.1.0 needs neither (no LLM yet).

## 6. Bottom line for etude-chess
1. **Keep the LLM a renderer/grader over engine-computed facts. Never an evaluator.** (ADR
   [0012](../decisions/0012-llm-grounded-explainer.md).)
2. **Design the fact-bundle format now, ship v0.1.0's "why" as rules-based templates** from it
   (hanging piece / big swing / better square). The bundle is the LLM's future input, unchanged.
3. **Add the LLM explanation layer next** (Haiku-cheap, low risk); **then the grader**, but only
   with a κ-validated gold set; **batch annotation last**, always human-spot-checked.
4. **Budget real work for the fact bundle itself** — SEE, hanging-piece logic, motif detection,
   and structural classifiers are *custom code*, since no library and no modern engine hands them
   to you interpretably.

### Key sources
- LLM-chess reality: https://arxiv.org/html/2410.20811v1 · https://dynomight.net/more-chess/ · https://www.aidancooper.co.uk/pgn2fen-benchmark/
- Grounding prior art: https://github.com/SikamikanikoBG/patzer · https://arxiv.org/html/2603.20510 · Jhamtani GameKnot https://aclanthology.org/P18-1154/
- Feature tooling: https://python-chess.readthedocs.io/en/latest/core.html · https://www.chessprogramming.org/Static_Exchange_Evaluation · https://www.chessprogramming.org/Pawn_Structure · Stockfish eval removal https://github.com/official-stockfish/Stockfish/pull/4674
- NN concepts: https://arxiv.org/abs/2111.09259 · https://arxiv.org/html/2409.20553v1 · https://github.com/adamkarvonen/chess_llm_interpretability
- LLM-as-judge: MT-Bench https://arxiv.org/abs/2306.05685 · Reference-Guided Verdict https://arxiv.org/abs/2408.09235 · non-determinism https://thinkingmachines.ai/blog/defeating-nondeterminism-in-llm-inference/
