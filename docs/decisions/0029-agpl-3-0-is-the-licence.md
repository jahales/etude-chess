# 0029 — AGPL-3.0 is the licence, and `package.json` now says so

**Status:** Accepted · 2026-08-15
**Resolves:** [#121](https://github.com/jahales/etude-chess/issues/121) · the deferral in ADR [0028](0028-chessops-for-streaming-pgn.md)
**Amends:** ADR [0009](0009-tech-stack.md)'s "keep our own code permissively licensed" clause

## Context

The repository has stated two different licences since `ce77a18`, the initial commit:

```
package.json   "license": "MIT"
LICENSE        GNU AFFERO GENERAL PUBLIC LICENSE Version 3
```

MIT and AGPL-3.0 grant materially different things — MIT permits closed-source
redistribution, AGPL requires derivative works to stay under the same terms and adds a
network-use clause. The repository is public, so anyone reading it got whichever answer they
happened to look at first, and someone who read `package.json` and shipped closed source
would have relied on a permission `LICENSE` does not grant.

ADR 0028 hit this while admitting chessops and recorded the working assumption — read
`LICENSE` as authoritative — but deferred the decision, correctly: a licence is not something
to settle inside a feature PR.

The owner settled it on 2026-08-15: **keep it public, no commercial intent, pick whatever is
compatible with what we already depend on.** That last clause is the whole decision, because
the dependencies do not leave much choice.

## What we actually distribute

Verified from the installed tree on 2026-08-15, not from memory:

| Component | Licence | How it ships |
|---|---|---|
| **chessops** | **GPL-3.0-or-later** | **imported by `src/content/pgnImport.ts`, linked into the bundle** (ADR 0028) |
| **Stockfish 18 WASM** | **GPL-3.0** | committed in `public/engine/`, arm's-length behind a Worker ([NOTICE.md](../../public/engine/NOTICE.md)) |
| chess.js | BSD-2-Clause | bundled |
| dexie | Apache-2.0 | bundled |
| minisearch | MIT | bundled |
| onnxruntime-web · react · react-dom · react-chessboard | MIT | bundled |
| Maia nets | fetched at setup from HuggingFace | **not committed**, not redistributed |
| Every devDependency | MIT / Apache-2.0 / BSD | build-time only, not distributed |

The binding constraint is the first row. **chessops is GPL-3.0-or-later and is linked into
the shipped JavaScript**, so the distributed work has to be under GPL-3.0-compatible terms.
That rules MIT out — which is what makes this a correction rather than a choice between two
open options.

Stockfish is a *devDependency*, but its compiled artifacts are committed under
`public/engine/`, so they are distributed too. That has always been handled properly: shipped
unmodified, run in a dedicated Worker over the UCI text protocol, with corresponding-source
pointers in `NOTICE.md`. Nothing there changes.

## Decision

**AGPL-3.0-only.** `LICENSE` stays exactly as it is; `package.json` is corrected to
`"AGPL-3.0-only"`.

Why this rather than GPL-3.0-only, which is also compatible:

- It is **already the LICENSE file**, so this closes the contradiction by changing one line
  rather than replacing a licence text and re-stating the project's terms.
- **AGPL-3.0 and GPL-3.0 are explicitly made compatible** — GPLv3 §13 permits combining with
  AGPLv3 code and vice versa — so the GPL-3.0-or-later dependency is fine either way.
- The extra clause AGPL carries is **§13, network use**: run a modified version as a network
  service and you must offer its source. etude-chess is entirely client-side with no backend,
  so anyone hosting it is already distributing the JavaScript to every visitor and GPL's
  distribution trigger has fired regardless. The clause costs a no-backend app nothing, and
  it costs nothing to keep.
- It matches the stated intent: public, non-commercial, a tool the owner wants to stay open.

## Consequences

- `package.json` declares `"AGPL-3.0-only"`. The two files agree for the first time.
- **ADR 0009's "keep our own code permissively licensed" clause is spent**, and this ADR
  retires it rather than leaving it to be read as live. ADR 0028 already observed that the
  argument had been given up; the AGPL `LICENSE` predates chessops by months, so in truth it
  was never in force — the clause described an intention the repository never had.
- No option is closed that was actually open. Relicensing permissively would have required
  removing chessops *and* the Stockfish artifacts, which is not a trade this project would
  make: the streaming parser is what allows a hundred-megabyte PGN import at all (ADR 0028),
  and the engine is the product.
- Nothing about how Stockfish or the Maia nets are handled changes.
- Lumbra's Gigabase is CC BY-NC-SA 4.0 and TWIC is personal-use, but neither is redistributed
  — users attach their own corpus (ADR [0018](0018-games-corpus-and-annotations.md)), which
  is exactly why that arrangement was chosen. A non-commercial project has no conflict with
  an NC source it does not ship.
