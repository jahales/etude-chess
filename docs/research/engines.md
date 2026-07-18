# Research: utilizing Stockfish and Maia

> Research digest, 2026-07-17. How to actually run and integrate the two engines, with
> the licensing and architecture implications. Feeds ADRs
> [0006](../decisions/0006-maia-opponent-stockfish-referee.md),
> [0009](../decisions/0009-tech-stack.md), [0010](../decisions/0010-engine-architecture.md).
> Roles: **Stockfish = referee/grader** (never opponent); **Maia = human-like opponent**
> (Phase 3, deferred).

## Part A — Stockfish (the referee)

### A1. Package landscape (2026)
- **Stockfish 18** (released 2026-01-31, GPLv3-or-later) is current. The NNUE net is
  **embedded** in native binaries; UCI option `EvalFile` overrides it.
- **In-browser / cross-env: `stockfish` on npm** (repo `nmrugg/stockfish.js`, **v18.x**,
  WASM, sponsored by Chess.com — the engine Chess.com runs in-browser). Ships flavors:
  large multi-threaded (>100 MB, needs cross-origin isolation), large single-threaded,
  **lite single-threaded (~7 MB, no special headers — the pragmatic default)**, lite
  multi-threaded, and an asm.js fallback. **Same `postMessage`/`onmessage` UCI API in both
  Node and the browser** — the key fact for "local now, browser later."
  https://github.com/nmrugg/stockfish.js
- **Lichess's own `@lichess-org/stockfish-web`** (v0.4.2, SF18 big+small nets + Fairy-SF for
  variants) is *more powerful but purpose-built for Lichess and explicitly "not
  straightforward to use"* — its own README points general users to nmrugg's package.
  Treat as a later upgrade, not a starting point. https://github.com/lichess-org/stockfish-web
- **Naming trap:** the maintained package is **`stockfish`**; the npm package literally named
  **`stockfish.js`** is abandoned (2019). `node-uci` (native binary wrapper) works but is
  unmaintained since 2020.
- **Native (fastest, for bulk/server):** spawn the official binary via `child_process` and
  talk UCI over stdio, or use `node-uci`. Native ≈ **1.5–2.5× faster than WASM**.

### A2. Performance & the browser constraints
- **WASM tax ≈ 1.5–2.5×** vs same-gen native (WASM SIMD is 128-bit only; native uses
  256/512-bit AVX). Budget accordingly.
- **Multi-threaded WASM needs `SharedArrayBuffer` → the page must be cross-origin isolated**
  via HTTP headers **`Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy:
  require-corp`** (COOP/COEP). Single-threaded/lite builds avoid this entirely. **v0.1.0
  ships lite single-threaded to dodge the header dance; add threads + COOP/COEP when we
  need depth.**
- **Browser thread ceilings** (not the machine's real core count): Chrome = real cores,
  **Firefox capped at 16**, **Safari 8 desktop / 2 iOS**. Use `hardwareConcurrency − 1`.
- **Memory:** WASM is capped ~2–4 GB per instance; SF18 big net ≈ **69 MB**, small net
  ≈ **2.7 MB**, smallnet build ≈ 10 MB. The lite/HCE build (~7 MB, no NNUE) exists to stay
  light. For a training referee we don't need max strength.
- **Depth in a responsive UI:** Lichess local analysis defaults to **depth ~22**; returns
  diminish past the low 20s. **Prefer fixed `movetime` (200–1000 ms) or `go nodes N` for live
  feedback; depth 18–22 for "final" grades.** Use **`go nodes N` (or fixed depth) for
  deterministic/reproducible grades** — never `movetime` when the grade must be repeatable.

### A3. Grading — Stockfish only outputs eval; the *labels* are ours
Stockfish emits `score cp X` / `score mate Y`, a `bestmove`, and (with **MultiPV**) N lines.
Blunder/mistake/brilliant labels are added on top. The de-facto open standard is **Lichess's
win% + accuracy model** (constants worth copying verbatim):

```
Win%      = 50 + 50 * (2 / (1 + exp(-0.00368208 * centipawns)) - 1)
Accuracy% = 103.1668 * exp(-0.04354 * (winPercentBefore - winPercentAfter)) - 3.1669
```
Source: https://lichess.org/page/accuracy

**Classify by win-% *swing*, not raw centipawns** — a fixed cp loss means very different
things in a balanced vs. decided position (this is why dropping a pawn while up a queen
isn't a "blunder"). For **multi-solution tactics**, run **MultiPV** and accept *any* move
reaching a winning eval, not just engine-best. Reference implementation to study (it
implements the whole win%/accuracy/tiering/Elo pipeline): **Patzer** — Node + TS + Hono +
better-sqlite3 + chess.js + chessground. https://github.com/SikamikanikoBG/patzer

### A4. Licensing — Stockfish is GPLv3 and *actively enforced*
Stockfish sued ChessBase (2021) and won a 2022 settlement (SFC/FSFE-backed) over failure to
ship license + corresponding source. Treat compliance as mandatory, not theoretical.
- **Local-only laptop use (no distribution): zero obligations.** Run/modify freely.
- **Serving `stockfish.wasm` to browsers *is* "conveying"** → you must provide the
  Corresponding Source (a link to the exact build/commit suffices) and the GPL license text
  for the Stockfish artifact.
- **Server-side only (engine never leaves your server): NOT conveying** under GPLv3 — no
  source obligation (the SaaS gap AGPL closes; plain-GPL Stockfish is fine).
- **Your own app code stays your license IF Stockfish is kept at arm's length** — a
  **separate Web Worker** (browser) or **child process** (desktop), communicating only via
  UCI text/`postMessage`, no in-process linking or shared complex data structures. In-process
  WASM linked into your bundle risks making the bundle a combined/derivative GPL work.
  *(Arm's-length = FSF's well-established interpretation, not court-tested for the Worker
  boundary — but it's the standard pattern.)*

### A5. Positional breakdown for explanations (classical eval / older engines)
Modern Stockfish (NNUE-only since SF16) gives a strong *number* but no interpretable
term-by-term breakdown (A1). Stockfish's **classical / hand-crafted evaluation** — material,
imbalance, mobility, king safety, pawn structure (isolated/backward/passed/doubled), space,
outposts, threats — existed through ~SF15/16 and is what the `eval` command used to print as a
table. Options to recover a human-readable positional signal *for explanations only*:
- An **older/classical Stockfish** build (≤ SF16 classical, the `SF_classical` tag, or SF11) run
  as a second engine; its `eval` output is the term table.
- The **[Stockfish Evaluation Guide](https://hxim.github.io/Stockfish-Evaluation-Guide/)** — an
  in-browser JS reimplementation of the classical eval that already surfaces every term; usable
  as a pure feature source with no extra engine binary.

**Recommendation:** treat this as a **two-engine pattern — modern SF18 for the grade (strength),
classical for the readable "why."** It's an *enrichment* of the fact bundle (and future LLM
input), not a grader. Don't block the analysis-view work on it: MultiPV lines from the modern
engine already give strong concrete "why" (the actual sequences). Tracked as a GitHub issue.

## Part B — Maia (the human-like opponent, Phase 3)

### B1. Three generations exist now
| Model | What it is | Rating control | Accuracy | License | Interface |
|---|---|---|---|---|---|
| **Maia-1** | 9 lc0 weight files (1100–1900) | pick a file (coarse) | ~51% | GPL-3.0 | UCI via lc0, or in-browser ONNX |
| **Maia-2** | one PyTorch model conditioned on Elo | continuous `elo_self/oppo` | ~53% | **MIT** | Python API → move-prob dict |
| **Maia-3 / "Chessformer"** | newest transformer (5M/23M/79M) | UCI Elo opts | **~57% (SOTA)** | **AGPL-3.0** | UCI engine |

Maia **does not search** — it picks a move from a **single NN forward pass** (`go nodes 1`).
That's what makes it human-like *and* cheap: **interactive latency on plain CPU, no GPU
needed.** GPU only helps for batching many concurrent users. Repos:
https://github.com/CSSLab/maia-chess · https://github.com/CSSLab/maia2 ·
https://github.com/CSSLab/maia3

### B2. The Maia Platform already built our architecture
`maiachess.com` pairs a Maia human-move model with a Stockfish referee, computing a
**"blunder meter"** (how likely a human is to play a move Stockfish rates bad) and overlaying
Maia's top-human move vs Stockfish's best. **Frontend is open (GPL-3.0, Next.js/React);
backend is private.** It serves everything **client-side** — Maia as **ONNX via
`onnxruntime-web`**, Stockfish via **WASM**. It's the reference for the dual-engine
feedback we want (study `useAnalysisController.ts`), though a fork inherits GPL.
https://github.com/CSSLab/maia-platform-frontend

### B3. Recommendation (when Phase 3 arrives)
- **Prototype the opponent with `pip install maia2`** (MIT, pure Python, CPU): load once,
  get a move-probability dict for a FEN + target Elo, play the top move *or sample* for
  natural variety. Least-effort, zero GPL, local-only = zero obligations.
- **Keep Stockfish a separate UCI referee**; combine à la the blunder-meter.
- **Defer** browser/ONNX delivery (real work: `leela2onnx` conversion, a float64 fix,
  COOP/COEP, WebGPU/WASM worker — follow `play-lc0` and the Maia-Platform frontend when the
  feature is proven) and **AWS** (CPU containers first; GPU pointless at nodes=1).
- **Avoid Maia-3/AGPL for anything you'd serve or keep closed** — AGPL §13 forces source to
  your web users. Maia-2/MIT sidesteps all of it; use it unless/until client-side-only
  Maia-3 accuracy becomes the bottleneck.

## Bottom line for etude-chess
1. **Stockfish now, Maia later.** v0.1.0 needs only Stockfish-as-referee.
2. **One `Engine` interface** (`send(uci)` / `onLine(cb)`), WASM-Worker adapter first
   (runs locally in the browser *and* ships to AWS unchanged), optional native child-process
   adapter later for speed. All grading logic written once above it.
3. **Grade by Lichess win-% swing**, deterministic search limits, MultiPV for multi-solution.
4. **Keep both engines at arm's length** (separate Worker/process) so our app code stays
   permissively licensed while we comply with Stockfish's GPL by shipping its notice + source
   link.
