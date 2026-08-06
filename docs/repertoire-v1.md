# Repertoire v1 — the curated base

> The **input spec** for the repertoire generator (`scripts/repertoire/`, issue #88). It says
> *which* openings we build; the generator decides *how deep* and *which deviations* from data.
> Rationale for building openings at all, at this point in the backlog: ADR
> [0021](decisions/0021-opening-repertoire-generator.md).
>
> Target player: the owner, USCF ~1400. Last updated 2026-08-05.

## The shape of the thing

A repertoire here is **not** a set of lines to recall. Each line runs until the position is
*quiet* — no hidden tactic, several playable moves, roughly balanced — and **that terminal
position is the item**. The moves leading to it are scaffolding to get you out of the opening
with a position you can think in. This is what keeps openings inside constitution §1 (train
judgment, not memory of lines); see [decisions/0021](decisions/0021-opening-repertoire-generator.md).

Depth is therefore **variable**: a floor of ~6 ply, a cap of ~10 ply (the "5 moves deep" ask),
and lines stop as soon as they go quiet. Sharp lines run longer because they must.

## White — 1.d4, Queen's Gambit spine

We play **one** first move. 1.e4 is the planned expansion, not part of v1.

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

| Source | Job |
|---|---|
| Lichess **masters** explorer | The spine — what is principled and tested. |
| Lichess **amateur** explorer, rating-banded | The deviations — what we actually meet, and which junk profits. |
| Caissabase 2024 (local, 5.4M games) | Optional offline cross-check. Its `Moves` BLOB needs shakmaty's move-generation order to decode, so it is deliberately **off the critical path**. |

## Expansion, in order

1. Queen's Gambit subtree only — validate branching numbers and the trap detector.
2. Rest of the 1.d4 White repertoire.
3. Caro-Kann, then Slav.
4. 1.e4 as White.
