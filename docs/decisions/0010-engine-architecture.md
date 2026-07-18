# 0010 — Engine integration: one thin interface, WASM-first, grade by win% swing

**Status:** Accepted · 2026-07-17 · Applies from v0.1.0

## Context
We need Stockfish evaluations locally now and (possibly) server-side later; and Maia later
still. We don't want environment (browser Worker vs. Node child process) to leak into grading
logic, and we want grades to be reproducible. Research: [../research/engines.md](../research/engines.md).

## Decision
1. **A thin `Engine` interface** — `send(uci) / onLine(cb) / quit()` — with per-environment
   adapters:
   - **`WasmWorkerEngine`** (the `stockfish` npm package as a Web Worker) — the v0.1.0 adapter;
     runs locally in-browser *and* deploys to AWS unchanged.
   - **`NodeNativeEngine`** (native binary via `child_process`, ~1.5–2.5× faster) — added only
     if bulk review needs the speed. Nearly identical, since the package's Node API is also
     postMessage-based.
2. **All grading logic is written once, above the interface.** Grade by **Lichess win%**
   (`Win% = 50 + 50*(2/(1+exp(-0.00368208·cp)) − 1)`) and classify by **win% *swing***, not
   raw centipawns.
3. **Deterministic search limits** (`go nodes N` or fixed depth, never `movetime`) so a grade
   is reproducible across machines. **MultiPV** to accept any move reaching a winning eval for
   multi-solution positions.
4. **v0.1.0 ships the lite single-threaded WASM build** to avoid the COOP/COEP header
   requirement; multi-threaded (needs `SharedArrayBuffer` → COOP `same-origin` + COEP
   `require-corp`) is a later upgrade when we want depth.
5. Study **Patzer** (https://github.com/SikamikanikoBG/patzer) for concrete tier thresholds
   and the win%/accuracy/Elo pipeline.

## Consequences
- The referee is a black box behind `Engine`; swapping WASM↔native, or adding Maia (its own
  adapter, `go nodes 1`), never touches grading.
- Reproducible grades enable held-out test sets and skill telemetry later.
- Keeping the engine a **separate Worker/process** is also what preserves our permissive
  license under Stockfish's GPL (ADR [0009](0009-tech-stack.md)).
- Maia integration reuses the same interface pattern in Phase 3 (ADR
  [0006](0006-maia-opponent-stockfish-referee.md)).
