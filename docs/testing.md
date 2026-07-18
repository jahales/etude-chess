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

**Conclusion:** the interactive pane is fine for a quick look, but **not** a dependable
verification harness — especially for a page that runs a WASM engine Worker. The fix is a proper
**headless Playwright E2E** in CI that we control and can re-run deterministically. Manual
eyeballing via `npm run dev` remains a useful sanity check, never the gate.

## Engine sanity (ad hoc)
The engine's UCI output format is validated by unit tests over `uci.ts` against captured real
output. When touching engine plumbing, a quick Node smoke test (drive `stockfish` via
`sendCommand`, read stdout) confirms the real engine still emits what the parsers expect.
