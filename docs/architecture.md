# Architecture & current state

> The on-demand system map (CLAUDE.md stays lean and points here). Keep this
> accurate — updating it is a release step (see [../RELEASING.md](../RELEASING.md)).
> Last updated: v0.1.0, 2026-07-18.

## What exists today (v0.1.0)
A **client-side, no-backend** React app: coached **guess-the-move** over a pack of
public-domain master games. You take the winner's side; at each move you commit a move + a
one-line reason before the reveal; Stockfish grades it by **win%-swing tier** (an engine-equal
move earns full credit); the reveal shows the alternatives, an eval bar, material, and a
plain-language "why". See [vision.md](vision.md) for *why*, [v0.1.0-plan.md](v0.1.0-plan.md)
for the release scope.

## Shape: pragmatic hexagonal (ports & adapters) — ADR [0015](decisions/0015-pragmatic-hexagonal.md)
- **Domain core** — `src/domain/**`: pure functions + types, **no React / engine / I/O / Date.now**.
  Fully unit-tested; this is why the suite runs in ~2s. TDD here.
  - `winPercent`, `grade` (A/B/C tiers by win% swing), `material`, `notation`, `see` (SEE),
    `harness` (PGN→quiz), `factBundle` (the "why" + LLM clipboard bundle), `session` (summary), `types`.
- **Application** — `src/app/**`: orchestration.
  - `sessionMachine.ts` — a **pure reducer** for the guess→commit→grade→reveal→next state machine
    (+ `resolveMove`, selectors). Unit-tested. No side effects.
  - `useGuessSession.ts` — the hook binding the reducer to the engine (async) and persistence.
  - `settings.ts` — analysis strength / lines-shown presets (pure).
- **Ports & adapters** — the edges:
  - `src/engine/analyser.ts` — the **`Analyser` port** (interface). Grading depends only on it.
  - `src/engine/stockfish.ts` — `StockfishAnalyser` adapter (WASM Worker); `uci.ts` (pure parsers),
    `grading.ts` (evaluate best + played, win%-swing).
  - `src/persist/db.ts` — IndexedDB/Dexie adapter; best-effort, never throws.
  - `src/ui/**` — React adapter (components, hooks, styles).
  - `src/content/` — the game pack + opening detection.
  - `public/engine/` — vendored **Stockfish 18 WASM** (GPLv3, arm's-length; see its `NOTICE.md`).

## Where to make changes
- New **pure rule / calculation** → `src/domain/**` (+ test first).
- New **flow / state transition** → `sessionMachine.ts` (pure, test it) + wire side effects in
  `useGuessSession.ts`.
- New **engine capability** → behind the `Analyser` port (add to the interface + adapter); never
  import the Worker into domain code.
- New **screen / control** → `src/ui/**`, driven by the hook's state + handlers.

## Cross-cutting rules
- Grade by **win% swing → A/B/C**; engine-equal = A. **No speed metric** (constitution §9).
- Engine calls are **reproducible** (fixed nodes/depth, never movetime); grading is MultiPV-1 so
  the tier doesn't drift with display settings.
- The LLM only ever **renders/grades the fact bundle**; it never computes chess facts (ADR 0012).
- Keep the domain pure; keep the engine at arm's length (GPL + testability).

## Major features (v0.1.0)
Guess-the-move loop · win%-swing tiering · analysis reveal (MultiPV lines, eval bar, material) ·
click-to-move + drag + flip + promotion picker · SEE-based hanging detection · rules-based "why"
+ LLM clipboard handoff · tuneable engine settings · opening detection · local-first persistence.

## Build, test, verify
`npm run dev` · `npm run verify` (typecheck→lint→test, ~2s) · `npm run build` · `npm run test:e2e`
(Playwright). CI runs verify + e2e on every PR. See [testing.md](testing.md), [dev-workflow.md](dev-workflow.md).

## What's next
Roadmap in [roadmap.md](roadmap.md). Next major: **v0.2 — play vs client-side Maia** (issue #14).
Backlog is GitHub issues (P0/P1/P2). The adaptive skill model stays **last** (ADR 0007).
