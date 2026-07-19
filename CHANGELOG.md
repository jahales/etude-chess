# Changelog

All notable changes to etude-chess. Format follows [Keep a Changelog](https://keepachangelog.com);
this project uses [Semantic Versioning](https://semver.org). Updated as part of each release
(see [RELEASING.md](RELEASING.md)).

## [Unreleased]

### Added
- **Accuracy + post-game review (v0.2):** a per-game **accuracy** score (Lichess per-move
  model, simple mean) over the moves **as played**, plus a separate **take-back count** —
  accuracy rewards the final game, the take-back count is the "did you commit?" penalty.
  Shown live and headlining a **post-game review**: accuracy, an opening/middlegame/endgame
  breakdown, and your worst moments with the better move. Framed as this game's move
  quality, not a skill rating (constitution §9, §12).
- **In-game coach (v0.2, ADR 0017):** an ambient coach on every move — you move, **Maia
  replies immediately**, and Stockfish grades your move (tier + how much it cost + what it
  dropped). The better move stays hidden behind **"Show me"** so a live verdict doesn't bias
  your next decision; **Take back** undoes the pair. Plus an **evaluation** you can toggle
  off (bar + exact current score + a score on every move in the list), the **opening** name,
  and **Draw / Resign**. One shared Stockfish worker serves both guess-grading and the coach.
- **Play vs Maia (v0.2, #14):** play a full game against the client-side, human-like Maia
  opponent — pick your colour and level (1100 / 1300 / 1500), click or drag to move, Maia
  replies from a single forward pass. A pure `playMachine` reducer + `usePlaySession` hook
  drive it; the Maia worker + wasm are lazy-loaded only when a game starts (never on the
  guess-the-move path), and finished games are stored locally for the coming coached review.
- **Maia spike (toward v0.2, #14):** client-side Maia-1 inference proven end-to-end —
  Maia-1900 runs in-browser (onnxruntime-web wasm in a Web Worker) and returns legal,
  human-like moves. Reusable foundation: a `MaiaOpponent` port + onnxruntime adapter, a
  pure 112-plane Lc0 encoder and 1858-move policy decoder (unit-tested), an opt-in Node
  oracle, and a headless-browser proof. See [docs/spikes/maia-onnx.md](docs/spikes/maia-onnx.md)
  and ADR [0016](docs/decisions/0016-maia-onnx-delivery.md). Not yet wired into the app.

## [0.1.0] — 2026-07-18

First release: **coached guess-the-move** on public-domain master games — a client-side,
no-backend React app.

### Added
- Guess-the-move loop: play the winner's side of a classic; commit a move + a one-line reason
  before the reveal.
- Win%-swing grading with **A/B/C tiers** — a move as good as the engine's best earns full credit
  (not "match the master").
- Analysis reveal: engine **alternatives (MultiPV) with scores + lines**, an **eval bar** (follows
  board orientation), and a **material** strip.
- Board interaction: **click-to-move** and drag, **flip**, and a **promotion picker**.
- Coaching "why": rules-based explanation over a computed **fact bundle**, with a
  **copy-to-clipboard** handoff for pasting into your own LLM.
- **SEE** (static exchange evaluation) for accurate hanging-piece detection.
- Tuneable **engine settings** (strength presets, lines shown).
- **Opening detection** (common openings) shown per game.
- Local-first **persistence** (IndexedDB) of every attempt as telemetry.
- Game pack: the Opera, Evergreen, and Immortal games.

### Engineering
- **Pragmatic hexagonal architecture** — pure `src/domain`, a pure `src/app` reducer, `Analyser`
  port + Stockfish WASM adapter (see [docs/architecture.md](docs/architecture.md), ADR 0015).
- Stockfish 18 (lite WASM) runs arm's-length in a Web Worker (GPLv3-compliant).
- **CI** (typecheck → lint → test → build + Playwright E2E), fast `npm run verify`, ESLint.
- ~100 unit tests + an end-to-end smoke test.

[Unreleased]: https://github.com/jahales/etude-chess/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/jahales/etude-chess/releases/tag/v0.1.0
