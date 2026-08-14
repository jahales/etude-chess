# 0028 — chessops (GPL) enters the app, for streaming PGN only

**Status:** Accepted · 2026-08-14
**Amends:** ADR [0009](0009-tech-stack.md)'s "avoid the GPL Lichess ecosystem" clause
**Implements:** ADR [0018](0018-games-corpus-and-annotations.md) · [../v0.3.0-plan.md](../v0.3.0-plan.md) §9
**Evidence:** [../spikes/games-corpus.md](../spikes/games-corpus.md) §5

## Context

ADR 0009 chose permissive dependencies deliberately — react-chessboard over chessground,
chess.js over chessops — and named **chessops (GPL-3.0-or-later)** as a thing to avoid, so
that "our own code stays permissively licensed, preserving every future option." Stockfish
and Maia were admitted only as **arm's-length artifacts** behind a Worker boundary, never
linked into the bundle.

Item 9 of the v0.3.0 plan needs to read a user's PGN database, which can be several hundred
megabytes. The spike measured what that requires and found only one thing that matters:
chessops ships the **only JavaScript PGN parser that does not need the whole file in memory
at once**, and it preserves comments, NAGs and variations, which ADR 0018 §3 requires us to
keep. chess.js has no streaming parser; a hand-rolled `[Event ` splitter is whole-file-in-
memory by construction. So this is not a convenience — it is the feature or it isn't.

## Decision

**Depend on chessops for streaming PGN parsing, and only for that.**

- It was already a dependency, used by the off-app `scripts/repertoire/` tooling. This admits
  it to `src/` — that is the change, and it is what needs recording.
- `src/content/pgnImport.ts` is the **only** module that imports it. The rules it feeds are
  pure and chessops-free: `src/domain/pgnImport.ts` declares the parse-tree shape it consumes
  **structurally** (`ParsedPgnGame`), so the domain has no chessops types in it and the parser
  can be replaced without touching a rule or a test.
- It stays out of the main bundle as a matter of fact rather than of intent: the only importer
  is the import Worker, so a build emits chessops in `pgnImportWorker`'s chunk. That is a
  pleasant consequence of where the code lives, **not** an arm's-length claim. It is linked
  code and we treat it as such.

## Why the licensing objection has largely gone

ADR 0009's argument was about **keeping future options open**: permissive→GPL is trivial,
GPL→permissive is impossible. That argument was already spent by the time this came up.

- The project ships under the **AGPL-3.0** (see [../../LICENSE](../../LICENSE)), and is
  committed to staying open and non-commercial (ADR 0018 §5 relies on exactly that when it
  accepts NC-licensed sources). GPL-3.0-or-later code combines into an AGPL-3.0 work without
  friction — the "or later" and GPLv3 §13 are what make that clean.
- `package.json` still declares `"license": "MIT"`, which contradicts the LICENSE file and
  predates all of this. That is a **pre-existing inconsistency, not something this decision
  creates**, and it should be resolved on its own terms rather than quietly by a feature PR.
  Until it is, read LICENSE as authoritative.

So what actually changes is smaller than ADR 0009's prose implies: we are adding a copyleft
dependency to a copyleft project. What we give up is the theoretical option of relicensing the
app permissively later — which the AGPL choice had already given up.

## Consequences

- **The import path can handle a file bigger than memory**, which is the whole point.
  `content/pgnImport.test.ts` asserts it: a game is delivered before the last chunk of the
  source has been pulled, and `text()`/`arrayBuffer()` on the file throw if anything calls them.
- **Removing chessops later is a one-file job.** The domain doesn't know it exists.
- **The UI stays permissive.** This is not an opening for chessground: ADR 0009's board choice
  stands, and nothing here argues for GPL code where a permissive equivalent does the job.
  The test that admits chessops is that no permissive package can do this at all.
- If the licence position ever changes — a closed or served build, say — this dependency and
  the two engines are what would have to be reconsidered, together.

## Alternatives rejected

- **Hand-roll a streaming PGN parser.** The parser is the easy half; comments, NAGs,
  variations, budget guards and the recovery behaviour after a malformed game are the hard
  half, and chessops is written by the author of Lichess's own PGN handling. Rejected as
  reinventing a wheel we would maintain worse.
- **Read the file with `chess.js` in slices.** chess.js parses a *game*, not a stream; slicing
  the file to feed it means splitting on `[Event ` — the whole-file-in-memory design §9 rules
  out — or reimplementing tokenisation to find game boundaries, which is the alternative above.
  Rejected.
- **Keep chessops behind a Worker and call it arm's-length**, as with Stockfish. It *is* in a
  Worker, but that boundary is honest only for a separate program spoken to over a protocol
  (UCI). We `import` chessops and call its API. Claiming otherwise would be a licence
  argument we don't believe. Rejected as a rationalisation.
