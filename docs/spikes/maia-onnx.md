# Spike: client-side Maia inference (ONNX in the browser)

> De-risking the biggest build risk of **v0.2 — play vs client-side Maia** (issue #14,
> ADR [0013](../decisions/0013-v0.1.0-play-vs-maia.md)/[0006](../decisions/0006-maia-opponent-stockfish-referee.md)).
> Run 2026-07-18 on branch `spike/maia-onnx`. **Outcome: GO** — a full, human-like Maia
> move runs entirely in the browser. Verdict + the exact mechanics below.

## The question
Can we run **Maia-1** (a human move-prediction net) fully client-side — no backend —
and get a legal, human-like move for a position, inside our Vite + React + Worker
stack? ADR 0013 flagged this (leela2onnx conversion, model delivery, the wasm runtime)
as v0.2's biggest unknown.

## Verdict — GO ✅
Proven end-to-end, twice (identical results):
- **Node oracle** (`onnxruntime-web` wasm backend, same runtime as the browser):
  `src/engine/maia/maia.integration.test.ts` (opt-in).
- **Real browser** (Vite module Worker + wasm + model fetch): `e2e/maia-probe.spec.ts`
  driving `maia-probe.html`, green in headless Chromium.

Maia-1900, from the actual start position:

| Side | Top-5 (policy %) |
|---|---|
| White (start) | **d2d4 14** · g2g3 13 · e2e4 11 · d2d3 10 · Ng1f3 9 |
| Black (1.e4)  | **d7d5 20** · e7e5 14 · c7c5 11 · d7d6 11 · g7g6 10 |

Spread like real human choices, not engine-sharp — exactly what a ~1900 human-move
predictor should give. Both colours correct ⇒ the perspective-flip in **encode and
decode** is right. First move ready in **~850 ms** (model fetch + wasm init + session);
inference itself is a single forward pass (`go nodes 1` equivalent), well under a
second.

## What we picked, and why
**Maia-1 (GPL), grab-and-go ONNX.** The research (subagent digest, this session) mapped
three families:

| | Maia-1 | Maia-2 | Maia-3 |
|---|---|---|---|
| Licence | **GPL-3.0** | MIT | AGPL-3.0 |
| Files | 9 nets (one per 1100–1900) | 1 (ELO input) | 1 (ELO input) |
| Size (ONNX) | **~3.5 MB each** | ~85 MB | ~46 MB |
| Input | 112-plane Lc0 tensor | 18-plane | tokens |
| Policy | **1858** (Lc0) | 1880 | 4352 |
| Browser proof | **play-lc0** | none official | maia-platform-frontend |

Maia-1 wins for us: **smallest download** (3.5 MB/level), **proven browser path**, and
GPL is already our posture (we ship GPL Stockfish arm's-length). Maia-2's MIT licence is
tempting but it's ~85 MB with **no official browser build**; Maia-3 is AGPL (§13 would
force source to our web users) — both rejected. This **confirms ADR 0006/0013's Maia-1
choice** with new evidence rather than reversing it; see ADR
[0016](../decisions/0016-maia-onnx-delivery.md).

A pre-converted GPL ONNX exists (`shermansiu/maia-1900` on HuggingFace, 3.48 MB), so we
did **not** need the lc0 `leela2onnx` toolchain for the spike. For shipping all 9 levels
we'll either reuse such conversions or run `leela2onnx` once in CI.

## How it works (the mechanics that were load-bearing)
The net: input `/input/planes` `float32[1,112,8,8]`; outputs `/output/policy`
`float32[1,1858]` + `/output/wdl` `float32[1,3]`.

1. **Encode** (`src/engine/maia/encoding.ts`, pure): FEN → 112-plane Lc0 tensor. 8
   history frames × (6 own + 6 opp piece planes + 1 repetition) + castling/side/rule50/
   ones planes. Always from the mover's view; **black-to-move mirrors ranks and swaps
   own/opp**. With only a FEN we repeat the current position across history frames (the
   documented single-position fallback; true history is a fidelity follow-up).
2. **Decode** (`decoding.ts`, pure): mask the 1858 logits to legal moves, softmax. The
   move→index map is Lc0's fixed `POLICY_INDEX` (`policyIndex.ts`, derived from Lc0's
   `tf/policy_index.py`). Black moves are **rank-flipped** before lookup; **knight
   promotion uses the plain 4-char slot** (q/r/b are explicit 5-char entries).
3. **Run** (`maiaWorker.ts`): onnxruntime-web, **wasm EP, single-threaded** (no
   SharedArrayBuffer ⇒ no COOP/COEP headers — same reasoning as our lite Stockfish),
   inside a Web Worker, with a best-effort IndexedDB model cache.
4. **Port** (`opponent.ts` + `maiaOpponent.ts`): a `MaiaOpponent` interface with an
   onnxruntime adapter, arm's-length in its own Worker exactly like `StockfishAnalyser`.

## The one real gotcha (write this down)
**onnxruntime-web + Vite Worker: "Failed to fetch dynamically imported module …
`?import`".** Vite rewrites ORT's internal dynamic import of the wasm glue, appending
`?import`, and public/ files can't be dynamically imported in dev. Neither
`@vite-ignore` nor `optimizeDeps.exclude` alone fixed it. **What worked:**
- import the wasm-only build: `import * as ort from 'onnxruntime-web/wasm'`;
- hand ORT the glue + binary as Vite `?url` assets so it imports runtime URL strings
  Vite can't rewrite:
  ```ts
  import ortWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url'
  import ortMjsUrl  from 'onnxruntime-web/ort-wasm-simd-threaded.mjs?url'
  ort.env.wasm.wasmPaths = { wasm: ortWasmUrl, mjs: ortMjsUrl }
  ```
  (use the package's **exported** subpath, not `onnxruntime-web/dist/…` — the exports
  map blocks the deep path);
- `optimizeDeps: { exclude: ['onnxruntime-web'] }` + `worker: { format: 'es' }` in
  `vite.config.ts`.

Vite then bundles the wasm itself — verified in a production build (`MAIA_PROBE=1 npm
run build` emits `maiaWorker-*.js` + `ort-wasm-simd-threaded-*.wasm`), so **nothing is
hand-copied into `public/`**.

## Costs & open items for the v0.2 build
- **Payload:** onnxruntime-web wasm is **13.5 MB (3.5 MB gzipped)** + **3.5 MB per Maia
  level**. Lazy-load the Maia worker only when a Maia game starts; cache wasm (HTTP) +
  model (IndexedDB, already done). Don't add it to the guess-the-move path.
- **Rating control** = swap the ONNX file (9 separate nets). Ship a few (e.g. 1100 /
  1500 / 1900) to start; fetch on demand.
- **History planes:** we zero/repeat history. Feeding true move history may improve
  human-fidelity — measure before deciding it matters.
- **WebGPU:** we use the wasm EP (portable, fast enough at nodes=1). WebGPU is a later
  optimisation, not needed.
- **Sampling vs argmax:** `move()` is argmax by default; `temperature>0` samples the
  policy for natural variety (opponent should probably sample).
- **Licensing:** ship the Maia GPL notice + Lc0/Maia source links (see
  `public/models/NOTICE.md`), same as Stockfish.

## Reproduce
```
node scripts/setup-maia.mjs                       # fetch maia-1900.onnx (~3.5 MB)
RUN_MAIA_MODEL=1 npx vitest run src/engine/maia/maia.integration.test.ts   # Node oracle
npx playwright test e2e/maia-probe.spec.ts        # real browser (or open /maia-probe.html)
```
Pure encode/decode tests (`encoding.test.ts`, `decoding.test.ts`) run in the normal
`npm run verify`; the model-dependent tests skip automatically when the net is absent.
