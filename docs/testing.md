# Testing & verification

> How we keep etude-chess correct and fast to change. Companion to
> [dev-workflow.md](dev-workflow.md).

## The layers of the test pyramid
1. **Unit tests (Vitest)** — the bulk. Cover the **pure domain core** (`src/domain/**`) and the
   pure engine parsers (`src/engine/uci.ts`), plus orchestration behind fakes (`grading.ts` with
   a fake `Analyser`). No browser, no real engine → the whole suite runs in **~2s**. This is
   where TDD happens.
2. **Content checks** — `src/content/games.test.ts` replays every pack PGN and asserts it's legal
   and produces quiz positions. The correctness net for game data.
3. **E2E smoke (Playwright, headless)** — drives the *real* app in a real browser, including the
   Stockfish WASM Worker: load → start a game → play a move → commit → assert the graded reveal,
   eval bar, and engine lines. This is the only layer that exercises the Worker + board + React
   wiring together.

## Fail-fast local flow
Run before every commit (cheapest checks first, so it fails fast):

```
npm run verify        # tsc --noEmit → eslint . → vitest run   (~4s)
```

`npm run build` and the Playwright E2E run in CI (and locally when touching the engine/UI).
CI (`.github/workflows/ci.yml`) runs typecheck → lint → test → build on every PR and push to main.

## Why we don't verify through the interactive browser pane
During v0.1.0 we tried to verify UI flows through the in-app MCP **Browser pane** and hit
repeated failures:
- **Screenshots timed out** (30s) — even on external pages *before* our app existed, so it's a
  limitation of that pane/tool in this environment, not our code.
- **In-page JS eval timed out** after we spawned several Stockfish Workers — the single-threaded
  WASM engine plus repeated Worker creation exhausted the pane's resources.
- `read_page`, `navigate`, and console reads stayed reliable; only screenshot and heavy
  `javascript_tool` calls were flaky.

**Root cause (confirmed 2026-07-18):** the biggest factor was a **stale, long-running dev
server**. A Vite dev server left up for hours accumulates broken HMR state (a failed
`App.tsx` reload leaves the module graph wedged) and the page leaks Stockfish Workers across
reloads — so the engine never reaches "ready". Proof: the Playwright E2E *failed* against the
reused old server ("engine ready" never appeared), then **passed in 2.7s against a fresh
server**. The engine and app are fine; the harness was the problem.

**Conclusions:**
- The interactive pane is fine for a quick look, never the gate.
- **Verify against a fresh server.** Playwright starts its own (`reuseExistingServer` is off in
  CI); locally, don't point it at a dev server that's been up for hours — restart it.
- The **headless Playwright E2E** is the dependable, deterministic verification for the full
  Worker + board + React flow.

## Engine sanity (ad hoc)
The engine's UCI output format is validated by unit tests over `uci.ts` against captured real
output. When touching engine plumbing, a quick Node smoke test (drive `stockfish` via
`sendCommand`, read stdout) confirms the real engine still emits what the parsers expect.
