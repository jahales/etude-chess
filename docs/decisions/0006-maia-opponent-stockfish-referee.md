# 0006 — Maia is the opponent; Stockfish/Syzygy is the referee

**Status:** Accepted · 2026-07-17 (timing updated)
**Applies to:** all sparring — the play-vs-Maia coaching loop ships in **v0.2.0** (ADRs
[0013](0013-v0.1.0-play-vs-maia.md)/[0014](0014-v0.1.0-guess-the-move.md)), later play-it-out
reuses it. Maia runs **client-side**.

## Context
For the play-it-out task type, the opponent's job is to make you practice punishing the
mistakes you'll actually face. Reduced-strength Stockfish blunders *inhumanly* — it drops
material at random depths — so you never learn to punish realistic human errors.

## Decision
- **Opponent:** Maia, a neural engine trained to *predict human moves* at a target rating
  (~600–2600), which reproduces human-like biases and mistakes. (Maia-3 / "Chessformer" is
  the current most-accurate human-move predictor.)
- **Referee / grader:** Stockfish (and Syzygy tablebases for technique). Never the opponent.

## Consequences
- Play Maia, grade with Stockfish — a **dual signal** (human-likelihood + objective eval).
  Study the existing **Maia Platform** first: it already pairs Maia predictions with
  Stockfish eval for rating-aware feedback, i.e. a chunk of this is shipped.
- **Maia runs client-side in the browser** (ONNX via onnxruntime-web — proven by `play-lc0`
  and the Maia Platform), so it needs **no backend** and lands in **v0.2.0** (ADRs
  [0013](0013-v0.1.0-play-vs-maia.md)/[0014](0014-v0.1.0-guess-the-move.md); a de-risking spike
  can run parallel to v0.1.0). Client-side delivery uses **Maia-1** (GPL); Maia-2 (MIT) is
  PyTorch-only with no browser path.
- Check Maia's model-weight license and Syzygy terms before distribution
  ([../open-questions.md](../open-questions.md)).
