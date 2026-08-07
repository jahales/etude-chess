# 0023 — A second White repertoire: 1.e4, alongside the Queen's Gambit

**Status:** Accepted · 2026-08-07
**Amends:** [repertoire-v1.md](../repertoire-v1.md) §"White — 1.d4, Queen's Gambit spine", which
said "We play **one** first move. 1.e4 is the planned expansion, not part of v1."
**Extends:** ADR [0021](0021-opening-repertoire-generator.md) (the generator) · ADR
[0022](0022-repertoire-branch-ownership.md) (branch ownership)
**Relates to:** issue #97

## Context

`repertoire-v1.md` chose one first move as White, deliberately: a repertoire you half-know is
worse than a narrow one you know, and doubling the first move doubles the theory before it buys
anything. That reasoning was sound and is not being withdrawn.

What changed is evidence. Replaying the owner's 248 real chess.com games (2026-08-07) measured
what they actually play, and 1.e4 is not a hypothetical expansion — it is already **17% of their
games as White, scored at 39%, with no preparation at all**. Every coverage hole this milestone
closed on the 1.d4 side was smaller: 1...c5 and 1...d6 together were 8 games, against 19 for
1.e4. The largest gap in the repertoire was a first move the spec had ruled out of scope.

The owner also stated the goal directly (2026-08-07): prepare for OTB at ~USCF 1400, and use
blitz as the practice ground rather than as the target. Over the board there is no opening book,
so the repertoire is doing recall work, and the measured recall ceiling — blitz blunder rate is
0% through move 4 and 3–8% per move after — is the binding constraint on how much can be carried.

## Decision

**Ship a second, separate White repertoire for 1.e4**, built from its own manifest
(`scripts/repertoire/manifest.e4.json`) and shipped as its own PGN
(`repertoire/etude-repertoire-v1-white-e4.pgn`).

Separate is load-bearing. It is an *alternative* to the Queen's Gambit, not an extension of it —
the owner plays one first move per game, so the two must be separate decks with separate
schedules. The Black repertoire is shared by both. `--manifest` already existed on the build, so
this needs no new machinery.

The system is chosen for low theory and for **transfer**, because theory load is the resource in
shortest supply:

| Black's reply | share of the band | branch |
|---|---|---|
| 1...e5 | 44.7% | Italian — no Ruy Lopez theory bill |
| 1...c5 | 15.3% | Alapin — one system, not the Open Sicilian's library |
| 1...d5 | 10.0% | Scandinavian |
| 1...e6 | 9.7% | Advance |
| 1...c6 | 8.4% | Advance |
| 1...b6 / Nc6 / Nf6 | 4.4% | Owen's, Nimzowitsch, Alekhine |

The Advance against both the French and the Caro-Kann is the same pawn chain the Black
repertoire already trains in `caro-advance`, so one structure is learned from both sides; the
Alapin rhymes with it. The result costs **210 decisions against the 1.d4 file's 341**, for 109
quiet training positions against 157.

## Why this does not reopen "play one first move"

The original reasoning applies to what you *train*, and that is unchanged: the two files are
separate decks and the honest use is to work one and rotate the other in, not to drill both. What
the evidence overturned is narrower — that 1.e4 was *hypothetical*. It was already being played,
badly, in a sixth of the owner's White games. Refusing to prepare a move the owner demonstrably
plays is not focus, it is a blind spot with a rationale.

## Consequences

- `repertoire-v1.md` is amended, not superseded. Its 1.d4 spine, the Caro-Kann/Slav Black
  choices and the rejection of the London all stand.
- Two White repertoires mean ~550 decisions on disk, which is past what the owner can hold. The
  repertoire README carries a study order for exactly this reason; the count on disk is not a
  target.
- Weights come from the owner's measured band (Lichess 1300–1800) and disagree sharply with
  theory: the Sicilian is a sixth of replies here rather than half, and the Scandinavian outranks
  both the French and the Caro-Kann. A repertoire designed from a book would have mis-weighted
  it. This is the same argument as ADR 0021's — prefer the band's distribution to received
  wisdom — applied to branch selection rather than to move choice.

## Alternatives considered

**Keep 1.e4 out and tell the owner to stop playing it.** The cleanest answer on paper, and the
one the spec implied. Rejected because it is advice, not preparation: the games show it is
already being played, and a repertoire that only works if the owner changes behaviour first is
not doing the job.

**Fold the 1.e4 branches into the existing White manifest.** Rejected because ownership and
scheduling both break: the branches would land in one PGN, En Croissant would build a single
deck mixing two first moves, and there would be no way to train one without the other.
