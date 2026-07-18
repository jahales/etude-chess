# 0009 — Tech stack: a client-side browser app, permissive UI, Stockfish at arm's length

**Status:** Accepted · 2026-07-17 · Applies from v0.1.0

## Context
The owner will run it on a laptop first but may move to AWS later, wants to keep it simple,
not reinvent the wheel, and use license-compatible components. Two shapes were possible: a
local desktop app (Electron/Node + native Stockfish) or a client-side browser app (WASM
Stockfish). Research (see [../research/engines.md](../research/engines.md)) showed the
`stockfish` WASM package exposes the *same* API in Node and browser, so a browser app loses
little and gains "local now / AWS later with no rewrite."

## Decision
Build v0.1.0 as a **client-side browser app, no backend**, so "runs on my laptop" and
"deployable to AWS" are the *same static bundle*.

- **TypeScript + Vite + React.**
- **Board:** `react-chessboard` (MIT). **Rules/FEN/PGN:** `chess.js` (BSD-2).
- **Engine:** Stockfish 18 WASM (`stockfish` npm) in a **Web Worker** (referee only).
- **Storage:** IndexedDB via Dexie (Apache-2.0), local-first, no accounts.
- **Pieces:** a permissive set — Chessnut (Apache-2.0) / Fantasy·Spatial·Celtic (MIT) /
  RhosGFX (CC0).

## Licensing rationale (deliberate)
- Keep **our own code permissively licensed / unencumbered**, preserving every future option
  (private, relicense, monetize, or open-source). Going permissive→GPL later is trivial;
  GPL→permissive is impossible without ripping components out.
- Therefore **avoid** the GPL Lichess ecosystem for UI (chessground, chessops) and the
  **CC-BY-NC** / GPL Lichess piece sets.
- **Stockfish is GPL-3 and actively enforced** (ChessBase suit/settlement). Keep it
  **arm's-length in a Web Worker** (UCI/postMessage only, no in-process linking) so our bundle
  is not a combined work; comply by shipping Stockfish's license text + a link to the exact
  source build. (Arm's-length = FSF's standard interpretation; not court-tested for the Worker
  boundary — revisit if we ever hard-couple.)

## Consequences
- No backend/accounts/auth to build for v0.1.0. AWS later = static hosting (S3/CloudFront),
  plus COOP/COEP headers *only if* we adopt multi-threaded Stockfish (ADR
  [0010](0010-engine-architecture.md)).
- Electron/native packaging is explicitly out of scope unless we later need native-engine
  speed or offline install.
- Superseded the fully-client-side *TS/chessground/Stockfish-WASM* sketch in the original
  [../first-deliverable.md](../first-deliverable.md): same spirit, but **react-chessboard
  (MIT) not chessground (GPL)**, for the licensing reason above.
