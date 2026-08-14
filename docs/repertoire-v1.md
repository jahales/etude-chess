# Repertoire v1 — the curated base

> **Status, 2026-08-14 — this file still specifies, but no longer describes what is shipped.**
> **Repertoire v2 shipped 2026-08-11** and is what you drill:
> [repertoire/v2/README.md](../repertoire/v2/README.md). v1 is kept for comparison
> ([repertoire/v1/](../repertoire/v1/)); do not import it.
>
> What still holds: the branch list, the structural argument for Caro-Kann + Slav, the
> rejection of the London, and the two-sources table — `manifest.v1.json` is still built from
> this file. What does not: **every measurement below is a v1 number**, from a 367k-game band
> book gated by a 120k-node search. v2 was built from an 8M-game book gated on a local index of
> 401M Lichess evaluations at median depth 34–50: 1,331 decisions and 423 quiet targets for
> 1.d4 + Black, 934 and 195 for 1.e4, against v1's 551 and 266 in total — deepest ply 13
> against 19–20.
>
> Two rules stated below have been amended since. Depth: curated lines now run to **ply 16**,
> not 10, so they reach a pawn structure (ADR
> [0025](decisions/0025-curated-lines-run-to-the-structure.md)). The quiet test's "no hidden
> tactic" half is off by default above ~1M nodes (ADR
> [0026](decisions/0026-retire-the-tactic-gap-at-high-node-budgets.md)). Both are marked inline
> in ADR [0021](decisions/0021-opening-repertoire-generator.md).

> The **input spec** for the repertoire generator (`scripts/repertoire/`, issues #88 and #92). It
> says *which* openings we build; the generator decides *how deep* and *which deviations* from
> data. Rationale for building openings at all, at this point in the backlog: ADR
> [0021](decisions/0021-opening-repertoire-generator.md).
>
> The machine-readable form of this file is
> [`manifest.v1.json`](../scripts/repertoire/manifest.v1.json) — 25 branches, one crawl each.
> **Change them together.** Build the whole thing with
> [`build.mjs`](../scripts/repertoire/README.md#building-the-whole-repertoire--buildmjs).
>
> Target player: the owner, USCF ~1355. Last updated 2026-08-06.

## The shape of the thing

A repertoire here is **not** a set of lines to recall. Each line runs until the position is
*quiet* — no hidden tactic, several playable moves, roughly balanced — and **that terminal
position is the item**. The moves leading to it are scaffolding to get you out of the opening
with a position you can think in. This is what keeps openings inside constitution §1 (train
judgment, not memory of lines); see [decisions/0021](decisions/0021-opening-repertoire-generator.md).

Depth is therefore **variable**, and set by what a branch is *for*. A **curated** line — one you
are actually learning — runs to at least ply 10, five moves each. A **sweeper**, which exists so
you are not surprised by a reply no curated branch owns, stops at 8. A **signpost** such as the
answer to 1.c4 stops at 6, because its decision *is* the first move and everything after it is a
structure the curated branches already teach. On top of that, every branch crawls at least four
plies past its own prefix, and the cap is eight.

Measured: one number for everything cost 467 decisions to memorise; roles took that to 336 while
the count of trainable quiet positions fell by three.

The floor is what actually decides depth, and it is worth knowing why: a line stops the moment
it is *allowed* to, because almost every opening position passes the quiet test by move 4. With
a floor of six, all 25 branches ended around move 3 — which is not preparation. Lines still end
as soon as they go quiet past the floor, so sharp lines run longer because they have to.

A flat depth would be wrong in both directions: it truncates a branch that starts deep before it
can find a quiet position, and it pads a "don't be surprised by 1...c5" sweeper with moves that
carry no decision. See ADR [0022](decisions/0022-repertoire-branch-ownership.md), amended.

### Does it hold up in the owner's real games? (measured 2026-08-07)

Every opening move of the owner's chess.com games was engine-graded and joined back to this
book — the one check that says whether any of the above is worth memorising.

**Where the book reaches, it works.** In positions it covers, playing its move produced **0
outright mistakes in 302 moves** (average win% swing 0.71); deviating produced 0.9% Tier C over
215 moves at more than twice the swing. Only **two** real mistakes in the whole corpus landed in
a position this repertoire already answers — one Albin (5.Nxd4 for 5.a3, −38%), one Caro-Kann
(5...g6 for 5...e6, −17%). Both are recall failures, not gaps, and both are exactly what the
trainer exists to drill.

**Its reach is the limit, and adherence is the other half.** In-book moves average move number
2.1; coverage thins from 97 in-book moves at move 3 to 43 at move 4 and 29 at move 5, which is
simply what a ply-10 curated depth *means* in practice rather than independent evidence for it.
Past that boundary sit 1,280 moves at 4.7% Tier C — most errors happen where the book has
stopped. And in covered positions the owner played the book move 302 times against 215
deviations, so **roughly two in five in-book positions were still answered from scratch**.

Two honest consequences: depth is the lever with the most headroom (see
[backlog.md](backlog.md)), and the coverage numbers say nothing about the *middlegame*, where a
separate whole-game review found the errors actually concentrate — the repertoire is not
claimed to help there.

## White — 1.d4, Queen's Gambit spine

~~We play **one** first move. 1.e4 is the planned expansion, not part of v1.~~

**Amended 2026-08-07 by ADR [0023](decisions/0023-second-white-repertoire-1-e4.md): 1.e4 now
ships as a second, separate White repertoire.** The reasoning above was that a repertoire you
half-know is worse than a narrow one you know — which still holds, and is why the two are
separate decks rather than one bigger file. What overturned the scope call was evidence rather
than a change of mind: replaying the owner's 248 real games showed 1.e4 was already **17% of
their games as White, scored at 39%, with no preparation at all** — a larger hole than any of the
gaps this milestone closed on the 1.d4 side. Everything below still describes the 1.d4 spine,
which is unchanged and remains the primary repertoire.

| Black plays | Our answer | Why |
|---|---|---|
| 1...d5 2.c4 e6 — QGD | **Exchange Variation** 3.cxd5 exd5 | Carlsbad structure, one clear plan (minority attack b4–b5). Best understanding-per-unit-theory in the repertoire. |
| 1...d5 2.c4 dxc4 — QGA | 3.e3, **do not chase the pawn** | The priority line. See below. |
| 1...d5 2.c4 c6 — Slav | 3.Nf3 Nf6 4.Nc3 | Known cold from the Black side. |
| 1...d5 2.c4 e5 — Albin | 3.dxe5 d4 4.Nf3 | Common at this band, punishable, and the trap for the careless (4.e3?) is instructive. |
| 1...d5 2.c4 Nf6 — Marshall | 3.cxd5 Nxd5 4.e4 | Big centre; refutation by development. |
| 1...d5 2.c4 Nc6 — Chigorin | 3.Nf3 | Sideline coverage. |
| 1...Nf6 2.c4 | ...e6 and ...g6 at **plan level** | Where theory explodes. Depth set by measured frequency, not by ambition. |
| 1...f5 — Dutch | 2.g3 | Sideline coverage. |
| 1...e5 — Englund | 2.dxe5 | Objectively junk, scores absurdly well below 1600. Must be covered. |

### The priority line: the QGA pawn-grab

The idea a 1400 most needs here is that after 2...dxc4, **White does not rush to regain the
pawn**. Play 3.e3, develop, and let the attempt to *hold* c4 cost Black the position. The
punishing motif is the queenside break:

> 3.e3 b5 4.a4 c6 5.axb5 cxb5 6.Qf3 — hitting a8 and b5 at once.

Every line where Black tries to keep the extra pawn gets explicit coverage, because this is the
single most common way lower-rated opponents go wrong against the Queen's Gambit. It is also the
generator's first target: we know roughly what the answer should look like, so it validates the
pipeline.

## Black — Caro-Kann and Slav

| vs | Line |
|---|---|
| 1.e4 | **Caro-Kann.** 4...Bf5 Classical vs 3.Nc3/3.Nd2; 3...Bf5 vs the Advance (3.e5); know the Panov (3.exd5 cxd5 4.c4) |
| 1.d4 | **Slav.** 3.Nf3 Nf6 4.Nc3 dxc4 5.a4 Bf5; plus the Exchange Slav (3.cxd5), which appears constantly |
| 1.c4 / 1.Nf3 | ...c6/...d5, steering toward Slav structures |
| 1.d4 sidelines | London, Trompowsky, Jobava, Colle — **plans, not theory** |

## Why this combination

The Caro-Kann and the Slav are **the same pawn structure** — c6 + d5, reached in either order.
Same problem bishop, same ...dxc4 resources, same chain. One structural idea covers the whole
Black repertoire.

It also compounds across colours: playing the Queen's Gambit teaches what Black endures in the
Slav, and playing the Slav teaches what our Queen's Gambit opponents want. The repertoire is
really **four structures, each learned from both sides**:

- **Carlsbad** (QGD Exchange) → minority attack
- **IQP** (Panov, QGA, several QGD lines) → both sides' plans
- **c6–d5 chain** (Caro + Slav) → the shared spine
- **Advance chain** (Caro Advance) → French-like, but with the good bishop already outside

Four structures, not forty lines. That is the return we are buying.

## Rejected: the London

Considered and cut. It is a *setup* played largely regardless of Black's reply — which is its
selling point and exactly the wrong shape for this project. Constitution §1 exists because
replay-the-setup is memorisation; the Queen's Gambit forces the structural decisions we want to
train. Kept as a fallback **only** if the generator reports that Queen's Gambit theory load is
genuinely unmanageable — a number we will have, not a guess.

## Traps to verify

Targets for the generator to **confirm or refute with Stockfish**, not assertions. Naming them
seeds the crawl; the engine decides whether they are real and what the refutation is.

- **Albin / Lasker Trap** — the underpromotion trick after a careless 4.e3.
- **Caro-Kann 6.Nd6#** — 3.Nc3 dxe4 4.Nxe4 Nd7 5.Qe2 Ngf6?? 6.Nd6 mate; Qe2 pins the e7 pawn.
  Must be known from the Black side.
- **Budapest Gambit** (1.d4 Nf6 2.c4 e5) — common here, with a smothered-mate trap for White.
- **Englund Gambit** (1.d4 e5) — junk that overperforms badly below 1600.
- **Marshall Defense** / **Chigorin** — punished by the centre and by development.

The ranked list that matters, though, is the one we *don't* write by hand: `trapValue` over
rating-banded explorer data surfaces the moves that quietly overperform at this exact band. See
[repertoire.ts](../src/domain/repertoire.ts).

## Sources

Two books, two jobs, decided by whose move it is. What actually built v1:

| Source | Job |
|---|---|
| **Lumbra's Gigabase OTB**, 800k games at 2200–2900 | The spine — what is principled. Decides **our** moves. |
| **Lichess monthly dump**, 300k games at 1500–1900 blitz/rapid | The deviations — what we actually meet, and which junk profits. Decides **theirs**, and is the only thing `trapValue` runs on. |
| Lichess **explorer API** | The fallback when there is no local book. Same interface; not reproducible, since it is a moving window rather than a fixed month. |
| Caissabase 2024 (local, 5.4M games) | Not used. Its `Moves` BLOB needs shakmaty's move-generation order to decode, so it is deliberately **off the critical path**. |

The asymmetry is deliberate and it shows in the first-move profile: our band opens 1.e4 61% of
the time, masters 42%. Using band data to pick our own moves would teach us what 1400s happen
to play; using master data to predict theirs would prepare us for opponents who do not exist.

## Expansion, in order

1. ~~Queen's Gambit subtree only — validate branching numbers and the trap detector.~~ Done
   2026-08-05. It found two traps that survived cross-month replication and an 8× change in
   engine budget, and roughly a dozen defects in the pipeline that produced them.
2. ~~Rest of the 1.d4 White repertoire.~~ Done 2026-08-06 (#92).
3. ~~Caro-Kann, then Slav.~~ Done 2026-08-06 (#92).
4. ~~**1.e4 as White** — the next cut, and deliberately not part of v1. One first move at a
   time.~~ Done 2026-08-07 (#97, ADR
   [0023](decisions/0023-second-white-repertoire-1-e4.md)) — as a **separate** deck with its
   own manifest, not folded into the 1.d4 file.

Also not covered, and worth stating rather than discovering across the board: **irregular White
first moves** (1.b3, 1.f4, 1.g3, 1.Nc3) have no Black branch. They are rare enough at this band
that the answer is "play a normal developing move and transpose", which is not something a
crawl of 300k games has much to say about.

## What it costs to learn

The generator reports this rather than guessing at it — the number the London section above
said we would have. `build.mjs` counts, per branch and in total:

- **decisions of ours** — positions where you must know which move you play. The thing to
  memorise, and the honest price of the repertoire.
- **replies of theirs** — opponent moves you have a prepared answer to. The thing being bought.
- **quiet targets** — terminal positions that pose a judgment. The items actually worth
  training, and the reason this is a repertoire rather than a deck.

**v1, first measured 2026-08-06: 25 branches, 361 positions, `ourDecisions` = 132, answering 213
replies, with 136 quiet positions to train.** That reading predates the same week's depth and
transposition amendments to ADR [0022](decisions/0022-repertoire-branch-ownership.md); v1 as
finally shipped is **551 decisions and 266 quiet targets** across both White decks and Black.
Full numbers in [`repertoire/v1/summary.json`](../repertoire/v1/summary.json) and
[`summary-e4.json`](../repertoire/v1/summary-e4.json); v2's are in
[`repertoire/v2/`](../repertoire/v2/README.md).

Read `ourDecisions` first: if it ever climbs past what one person can hold, the answer is to cut
branches from this file, not to crawl shallower. A shallower crawl buys the same repertoire with
the trainable positions chopped off.

The London stays cut. 132 decisions is manageable, which is what that section wanted to know.
