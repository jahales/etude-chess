# 0015 — Pragmatic hexagonal architecture (ports & adapters)

**Status:** Accepted · 2026-07-18

## Context
Question raised: should etude-chess use hexagonal / clean architecture? The codebase already
*approximates* ports-and-adapters, so the real decision is how much of it to make intentional —
and where to stop before it becomes ceremony for a small client-side app.

## Decision
Adopt **pragmatic hexagonal architecture**: a pure domain core, explicit **ports** (interfaces)
for external systems, and thin **adapters** at the edges. Do **not** add full clean-architecture
apparatus (DI containers, use-case/interactor classes, entity/DTO mapping layers) — that's
over-engineering here.

### The layers (already largely in place)
- **Domain core** — `src/domain/**`: pure functions + types (grading, win%, tiers, harness, fact
  bundle, material, notation, session). **No imports of React, the engine, the DB, or the DOM.**
  Fully unit-tested; this is why the tests run in ~2s.
- **Ports** — interfaces the core/UI depend on, not concretions:
  - `Analyser` (`src/engine/analyser.ts`) — the engine port. Grading depends only on it.
  - Persistence functions (`src/persist/db.ts`) — a narrow port over storage.
- **Adapters** — the edges: `StockfishAnalyser` (WASM Worker), Dexie `db` (IndexedDB), the React
  `src/ui/**`. Swappable without touching the core (a Maia adapter or native engine drops in).

### Rules (enforced by review + ESLint boundaries later if needed)
- Nothing in `src/domain` may import React, `src/engine`, `src/persist`, or browser globals.
- Depend on the **port** (`Analyser`), never the concrete `StockfishAnalyser`, outside its adapter.
- Keep engine calls reproducible and behind the port so the core stays deterministic and testable.

## Known gap (follow-up)
The **application/orchestration** logic (the guess→commit→grade→reveal→next state machine) still
lives inline in `App.tsx`, which makes it hard to unit-test and mixes concerns. Extract it into a
**pure session reducer / hook** so it's testable without a browser. Tracked as a GitHub issue.

## Consequences
- Clear home for every kind of code; the core stays pure and fast to test.
- New external capabilities (Maia, a classical-eval engine, a backend) arrive as adapters behind
  ports — no core rewrite.
- We consciously accept "light" structure over textbook clean architecture; revisit only if the
  app grows a real backend or multiple delivery mechanisms.
