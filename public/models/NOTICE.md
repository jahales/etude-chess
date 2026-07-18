# Maia model weights — third-party notice

The Maia neural-network weights served from this directory are **not** part of
etude-chess and are under their own licence. They are fetched at setup time
(`node scripts/setup-maia.mjs`), not committed.

## maia-1900.onnx

- **What:** Maia-1 (rating 1900) human move-prediction network, an Lc0-architecture
  net (64×6-SE), exported to ONNX.
- **Licence:** **GPL-3.0-or-later** (Maia derives from Leela Chess Zero).
- **Source:** Converted net published at
  <https://huggingface.co/shermansiu/maia-1900> (`model.onnx`); original weights
  from the Maia project, <https://github.com/CSSLab/maia-chess> (releases v1.0).
- **Corresponding source:** the Maia training code (CSSLab/maia-chess) and Lc0
  (<https://github.com/LeelaChessZero/lc0>).

Like the Stockfish engine (see [../engine/NOTICE.md](../engine/NOTICE.md)), Maia runs
**arm's-length in its own Web Worker** and communicates only via `postMessage`; our
application code links to it through the `MaiaOpponent` port, not in-process. The
`POLICY_INDEX` in `src/engine/maia/policyIndex.ts` is derived from Lc0's
`tf/policy_index.py` (GPL-3.0) and, together with the encoder/decoder and these
weights, forms the GPL-licensed Maia adapter.
