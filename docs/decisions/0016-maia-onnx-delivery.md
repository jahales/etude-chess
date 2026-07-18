# 0016 — Client-side Maia delivery: Maia-1 via onnxruntime-web in a Worker

**Status:** Accepted · 2026-07-18
**Applies to:** v0.2.0 (play vs Maia, issue #14). Confirms — does not reverse — ADRs
[0006](0006-maia-opponent-stockfish-referee.md) and [0013](0013-v0.1.0-play-vs-maia.md).
**Evidence:** the de-risking spike, [../spikes/maia-onnx.md](../spikes/maia-onnx.md).

## Context
ADR 0013 committed to a client-side Maia opponent and named its delivery — model
conversion, the wasm runtime, packaging — as the release's **biggest build risk**, to be
prototyped first. The spike did that and it works end-to-end (Node + real browser,
identical human-like output). Two decisions crystallised and deserve recording.

## Decision
1. **Model = Maia-1 (GPL-3.0), one ONNX net per rating level.** Confirmed over Maia-2
   (MIT but ~85 MB with no official browser build) and Maia-3 (AGPL — §13 would force
   source disclosure to web users). Maia-1 is the smallest download (~3.5 MB/level), has
   the only proven in-browser path, and GPL matches how we already ship Stockfish.
2. **Runtime = onnxruntime-web, wasm execution provider, single-threaded, in a Web
   Worker**, behind a new **`MaiaOpponent` port** — arm's-length exactly like the
   `Analyser`/Stockfish adapter. Single-threaded avoids SharedArrayBuffer, so **no
   COOP/COEP headers** (same reasoning as the lite Stockfish build, ADR 0009). The
   encoder (112-plane Lc0 tensor), decoder (1858-move Lc0 policy), and net together are
   the **GPL Maia adapter**; app/domain code depends only on the port.
3. **Vite integration:** import `onnxruntime-web/wasm` and pass the wasm glue + binary as
   `?url` assets via `ort.env.wasm.wasmPaths = { wasm, mjs }`, with `optimizeDeps.exclude`
   + `worker.format:'es'`. Vite bundles the wasm; nothing is hand-vendored into `public/`.
   (The failure mode this avoids is documented in the spike.)

## Consequences
- **No backend, no new headers** — preserves the static, local-first architecture (ADR
  0009). Ships as static assets to S3/CloudFront later, unchanged.
- **Two GPL engine artifacts** (Stockfish wasm + Maia ONNX), both arm's-length with
  NOTICE + source links (`public/models/NOTICE.md`).
- **Payload cost is real:** onnxruntime-web wasm ≈ 13.5 MB (3.5 MB gzip) + 3.5 MB per
  level. v0.2 must **lazy-load the Maia worker only when a Maia game starts**, cache the
  model (IndexedDB, done) and wasm (HTTP), and keep it off the guess-the-move path.
- **Rating control = swapping the net** (9 files). Ship a subset (e.g. 1100/1500/1900),
  fetch on demand. A rating *slider* would need Maia-2/3 and is explicitly not worth the
  licence/size cost now.
- **Stockfish stays the referee** (ADR 0006) — Maia plays, Stockfish grades; the coached
  review pipeline is unchanged and reused.

## Alternatives rejected
- **Maia-2 (MIT):** simplest UX (one file, ELO input) but ~85 MB and no official
  onnxruntime-web build; revisit only if single-file + slider becomes worth a port.
- **Maia-3 (AGPL):** best accuracy, but AGPL is disqualifying for a served/closed app.
- **WebGPU EP:** unnecessary at `nodes=1`; a later optimisation, not a dependency.
- **lc0 `leela2onnx` at build time:** not needed for the spike (a pre-converted GPL ONNX
  exists); may be used once in CI to produce the shipped level set.
