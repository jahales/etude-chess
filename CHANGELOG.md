# Changelog

All notable changes to etude-chess. Format follows [Keep a Changelog](https://keepachangelog.com);
this project uses [Semantic Versioning](https://semver.org). Updated as part of each release
(see [RELEASING.md](RELEASING.md)).

## [Unreleased]

_Nothing yet._

## [0.2.0] — 2026-07-18

**Play vs Maia, coached on every move.** A second mode alongside guess-the-move: play a full
game against a human-like opponent that runs entirely in your browser, with a coach watching.

### Added
- **Play vs client-side Maia (#14).** Pick your colour and level (**1100–1900**) and play a
  full game against Maia — a neural net trained to predict *human* moves at a rating, so it
  makes the mistakes you will actually face. Fully client-side (onnxruntime-web in a Web
  Worker); no backend. The worker + wasm load only when a game starts.
- **An ambient in-game coach** (ADR [0017](docs/decisions/0017-in-game-coach.md)). You move,
  Maia replies immediately, and Stockfish grades your move — tier, what it cost, and what it
  dropped. The better move stays behind **"Show me"** so the verdict does not bias your next
  decision; **Take back** undoes the pair.
- **Scores everywhere, toggleable.** Eval bar, exact current score, and a score on every move
  in the list — all from White's perspective. Switch the evaluation off to play on your own
  judgment.
- **Accuracy + post-game review.** Per-game accuracy over the moves *as played*, with a
  separate **take-back count**; the review adds an opening/middlegame/endgame breakdown and
  your worst moments with the better move. This is the game's move quality — not a skill
  rating or a claim of transfer (constitution §9, §12).
- Opening name, **Draw / Resign**, board flip, and a material strip.

### Engineering
- **`MaiaOpponent` port + onnxruntime adapter**, arm's-length in its own Web Worker exactly
  like Stockfish (both GPL, both with NOTICEs). Pure 112-plane Lc0 encoder + 1858-move policy
  decoder, unit-tested. See [docs/spikes/maia-onnx.md](docs/spikes/maia-onnx.md) and ADR
  [0016](docs/decisions/0016-maia-onnx-delivery.md).
- Pure `playMachine` reducer + `usePlaySession` hook (the ADR 0015 shape); one shared
  Stockfish worker now serves both modes.
- **Engine/board sync by construction:** every engine result carries the FEN it was computed
  for and is dropped if the board has moved on.
- 153 unit tests + Playwright e2e; CI runs verify + e2e on every PR.

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

[Unreleased]: https://github.com/jahales/etude-chess/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/jahales/etude-chess/releases/tag/v0.2.0
[0.1.0]: https://github.com/jahales/etude-chess/releases/tag/v0.1.0
