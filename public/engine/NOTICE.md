# Third-party engine — Stockfish (GPLv3)

`stockfish-18-lite-single.js` and `stockfish-18-lite-single.wasm` in this directory are
**Stockfish 18**, the free chess engine, compiled to WebAssembly by the
[stockfish.js](https://github.com/nmrugg/stockfish.js) project (© Chess.com, LLC).

Stockfish is **free software licensed under the GNU General Public License, version 3 (GPLv3)**.
etude-chess ships these files unmodified and runs the engine at **arm's length** — in a
dedicated Web Worker, communicating only via the UCI text protocol — so the engine remains a
separate program (see `docs/decisions/0009-tech-stack.md`).

- **License text:** https://www.gnu.org/licenses/gpl-3.0.html (and Stockfish's `Copying.txt`)
- **Corresponding source (this exact build):** https://github.com/nmrugg/stockfish.js — the
  `stockfish` npm package, version 18.0.8, files `bin/stockfish-18-lite-single.{js,wasm}`.
- **Stockfish source:** https://github.com/official-stockfish/Stockfish

No warranty; see the GPLv3 for details.
