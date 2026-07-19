# Architecture & current state

> The on-demand system map (CLAUDE.md stays lean and points here). Keep this
> accurate — updating it is a release step (see [../RELEASING.md](../RELEASING.md)).
> Last updated: v0.2.0, 2026-07-18.

## What exists today (v0.2.0)
A **client-side, no-backend** React app with **two modes**:

1. **Coached guess-the-move** (v0.1.0) over a pack of public-domain master games. You take the
   winner's side; at each move you commit a move + a one-line reason before the reveal;
   Stockfish grades it by **win%-swing tier**; the reveal shows alternatives, an eval bar,
   material, and a plain-language "why".
2. **Play vs Maia + in-game coach** (v0.2.0). Play a full game against **Maia** — a neural net
   that predicts *human* moves at a chosen rating (1100–1900) — running in the browser. You
   move, Maia replies immediately, and Stockfish grades your move: tier, what it cost, what it
   dropped. The better move hides behind **"Show me"** so the verdict doesn't bias your next
   decision; **Take back** undoes the pair. Scores (toggleable) appear on the bar, the current
   position, and every move. At the end: **accuracy + a post-game review** (by-phase, worst
   moments) plus a **take-back count**.

See [vision.md](vision.md) for *why*, [v0.1.0-plan.md](v0.1.0-plan.md) and ADRs
[0013](decisions/0013-v0.1.0-play-vs-maia.md)/[0016](decisions/0016-maia-onnx-delivery.md)/
[0017](decisions/0017-in-game-coach.md) for the release scopes.

## Shape: pragmatic hexagonal (ports & adapters) — ADR [0015](decisions/0015-pragmatic-hexagonal.md)
- **Domain core** — `src/domain/**`: pure functions + types, **no React / engine / I/O / Date.now**.
  Fully unit-tested; this is why the suite runs in ~3s. TDD here.
  - `winPercent`, `grade` (A/B/C tiers by win% swing), `material`, `notation` (SAN/score
    formatting, incl. White-perspective labels), `see` (SEE), `harness` (PGN→quiz),
    `factBundle` (guess-mode "why" + LLM clipboard bundle), `coach` (play-mode, engine-based
    "why"), `accuracy` (per-move/game accuracy + phase), `session` (summary), `types`.
- **Application** — `src/app/**`: orchestration, all **pure reducers** + the hooks that bind
  them to async work.
  - `sessionMachine.ts` — guess→commit→grade→reveal→next (guess mode). Unit-tested.
  - `useGuessSession.ts` — binds it to the engine + persistence.
  - `playMachine.ts` — the play-vs-Maia loop: `yourTurn → thinking → over`, coach feedback,
    per-ply evals, take-back-a-pair, accuracy/take-backs. Unit-tested.
  - `usePlaySession.ts` — binds it to **Maia** (opponent) and **Stockfish** (coach), plus
    persistence.
  - `settings.ts` — analysis strength / lines-shown presets (pure).
- **Ports & adapters** — the edges:
  - `src/engine/analyser.ts` — the **`Analyser` port**. Grading depends only on it.
  - `src/engine/stockfish.ts` — `StockfishAnalyser` adapter (WASM Worker, serialized UCI);
    `uci.ts` (pure parsers), `grading.ts` (evaluate best + played → win%-swing).
  - `src/engine/maia/` — the **`MaiaOpponent` port** (`opponent.ts`) + `maiaOpponent.ts`
    adapter driving `maiaWorker.ts` (onnxruntime-web). `encoding.ts` (112-plane Lc0 tensor),
    `decoding.ts` (1858-move policy → legal moves), `policyIndex.ts`. **GPL, arm's-length.**
  - `src/app/replay.ts` — pure derivations for the replay screen (`buildReplayMoves`,
    `replayRows`, `coachAtCursor`, `clampCursor`); `src/domain/replay.ts` rebuilds positions
    from SAN. `src/app/useHomeStats.ts` — the Home cards' history counters.
  - `src/persist/db.ts` — IndexedDB/Dexie adapter (attempts + games); best-effort, never throws.
    A stored game carries the coach's output (`coachLog`, `evalByPly`) so replay never
    re-analyses; those fields are **optional** because v0.2 records predate them. Reads go
    through `listGames`/`getGame`/`lastGame`.
  - `src/ui/**` — React adapter. `App.tsx` routes
    `home | maia-setup | maia | guess-pick | guess` — Home is a card chooser, each mode
    gets a focused setup screen (`Screen` shell supplies the title + back); `MaiaMode.tsx` is the play
    screen + coach; `Analysis.tsx` holds the eval bar, material, engine lines; `Library.tsx` is the
    stored-game table + the read-only replay screen.
  - `public/engine/`, `public/models/` — vendored **Stockfish WASM** and the fetched **Maia
    nets** (both GPL; see their `NOTICE.md`). Nets are fetched by `scripts/setup-maia.mjs`,
    not committed.

## Where to make changes
- New **pure rule / calculation** → `src/domain/**` (+ test first).
- New **flow / state transition** → the relevant reducer (`sessionMachine` / `playMachine`),
  pure and tested; wire side effects in its hook.
- New **engine capability** → behind the `Analyser` or `MaiaOpponent` port; never import a
  Worker into domain code.
- New **screen / control** → `src/ui/**`, driven by hook state + handlers.

## Cross-cutting rules
- Grade by **win% swing → A/B/C**; engine-equal = A. **No speed metric** (constitution §9).
- Engine calls are **reproducible** (fixed nodes, never movetime).
- **Engine/board sync by construction:** every engine result carries the FEN it was computed
  for, and the reducer drops it if the board has moved on. Never render engine output against
  a position it wasn't computed for.
- **Scores are always White's perspective** in the UI (bar, chip, move list, lines).
- Maia is the **opponent**, Stockfish the **referee** — never the reverse (ADR 0006).
- The LLM only ever **renders/grades the fact bundle** (ADR 0012).
- Keep the domain pure; keep both engines at arm's length (GPL + testability).
- Metrics describe **this game**, never implied transfer (constitution §9, §12).

## Major features (v0.2.0)
Guess-the-move loop · play vs Maia (1100–1900, client-side) · ambient coach with "Show me" ·
win%-swing tiering · accuracy + take-back count + post-game review (by-phase, worst moments) ·
toggleable evaluation (bar, current score, per-move scores) · engine alternatives (MultiPV) ·
click/drag + flip + promotion picker (guess mode) · SEE hanging detection · opening detection ·
draw/resign · local-first persistence of attempts and games.

## Build, test, verify
`npm run dev` · `npm run verify` (typecheck→lint→test) · `npm run build` · `npm run test:e2e`
(Playwright) · `node scripts/setup-maia.mjs` (fetch the Maia nets before playing/e2e).
CI runs verify + e2e on every PR. See [testing.md](testing.md), [dev-workflow.md](dev-workflow.md).

## What's next
Roadmap in [roadmap.md](roadmap.md). Next: **v0.3.0 — complete the core loops** — design is
decision-complete in [v0.3.0-plan.md](v0.3.0-plan.md); work is the GitHub **v0.3.0
milestone** (library/replay #39, play-it-out + opening picker #41, drill-your-misses,
reveal enrichment, curated pack, landing redesign, theme #42). Then **v0.4 — the games
corpus** (#40, spike first). The adaptive skill model stays **last** (ADR 0007).
