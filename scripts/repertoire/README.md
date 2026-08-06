# Repertoire generator

Offline pipeline that builds an opening repertoire from **Lichess explorer statistics** +
**Stockfish**. Ships no UI. Design and rationale: ADR
[0021](../../docs/decisions/0021-opening-repertoire-generator.md); the curated line list it works
from: [docs/repertoire-v1.md](../../docs/repertoire-v1.md). Issue #88.

Two outputs from one run:

- **`<out>.pgn`** — PGN with variations. Import into **En Croissant** and its spaced-repetition
  trainer has a repertoire to drill, today.
- **`<out>.json`** — every position with its statistics, evaluation, quiet-test result and trap
  scores. This is what etude-chess consumes when `epic:opening` comes up.

## What it actually does

| Node | Logic |
|---|---|
| **Ours** | Pick exactly **one** move, ranked by soundness, **branching cost** and popularity at our band. Branching is weighted highest — a repertoire's real price is the number of replies it obliges you to learn. |
| **Opponent's** | Cover **many**: everything up to `--mass` of the games actually played at our band, **plus** anything `trapValue` flags as bad-but-overperforming. |

A line stops when the position goes **quiet** — shallow and deep evaluation agree (no hidden
tactic), at least three moves are playable, and the position is roughly balanced. That terminal
position is the item worth training; the moves before it are scaffolding. Depth is therefore
variable, not fixed.

Where no move humans play is sound — the normal case immediately after the opponent falls into a
trap — the crawler falls back to the **engine's** refutation and labels it as such in the PGN.

## Prerequisites

- **Node 24+** (the scripts import `.ts` domain modules directly via type stripping).
- **A Stockfish binary.** Defaults to the one En Croissant installs:
  `%APPDATA%\org.encroissant.app\engines\stockfish\stockfish-windows-x86-64-avx2.exe`.
  Override with `--engine <path>` or `STOCKFISH_PATH`.
- **Network access to `explorer.lichess.ovh`.** Every response is cached under
  `<out-dir>/.explorer-cache`, so re-runs and threshold tuning cost zero requests.

## First run — the Queen's Gambit

```bash
node scripts/repertoire/crawl.mjs --color white --line "d4 d5 c4 dxc4" --out out/qga
```

That crawls the QGA subtree: the pawn-grab problem, which is both the most valuable line for a
1400 and the best test of the trap detector, because we already know roughly what the answer
should look like (3.e3, don't chase the pawn, punish ...b5 with a4).

Then widen:

```bash
node scripts/repertoire/crawl.mjs --color white --line "d4 d5 c4" --out out/qg
node scripts/repertoire/crawl.mjs --color black --line "e4 c6" --out out/caro
node scripts/repertoire/crawl.mjs --color black --line "d4 d5 c4 c6" --out out/slav
```

## Options

```
--color   white | black       which side the repertoire is for        (required)
--line    "d4 d5 c4"          curated prefix, followed verbatim
--out     out/qga             output basename                          (required)
--source  amateur | masters   explorer endpoint               (default: amateur)
--ratings 1600,1800           rating buckets, amateur only
--min-ply 6                   earliest a line may stop
--max-ply 10                  depth cap in plies
--nodes   400000              engine budget per position
--mass    0.85                opponent coverage target
--trap    0.05                trapValue threshold
--engine  <path>              Stockfish binary
```

Set `--ratings` to the band you actually face. The default (1600, 1800) is a rough map from USCF
1400 to Lichess blitz/rapid; it is a guess, and worth revisiting once you compare the generated
deviations against what you really meet.

## Reading the output

The run prints a ranked trap list:

```
top traps (frequency × swing × outperformance):
  0.1957  d4 d5 c4 dxc4 e3 b5   [3.1% of games, −34.5 win%, scores 42% vs 12% deserved, n=900]
```

That reads: played 3.1% of the time here, gives up 34.5 win%, and **still scores 42% when the
position only deserves 12%** — so the refutation is not common knowledge at this band. That gap
is where study time pays, and it is the list you cannot write from memory.

It also reports what it *didn't* cover — nodes that hit the evaluation cap, and lines that ran
out of book. A coverage cap that stays silent reads as "we covered everything" when it did not.

## Importing into En Croissant

Open En Croissant → **Files** → import `<out>.pgn`, then point the repertoire trainer at it. The
`?!`/`?`/`??` suffixes on opponent moves and the `{quiet: N playable moves}` comments come
through as annotations.

## Caveats

- **The explorer response shape is assumed, not verified here** — it could not be reached from
  the sandbox this was written in. The client fails loudly with a clear message if the payload
  lacks a `moves` array. If Lichess has changed the API, that error is where to look.
- **Caissabase is not used.** Its `Moves` BLOB is a legal-move index in shakmaty's generation
  order; decoding means replicating that ordering exactly. Deliberately off the critical path
  (ADR 0021), and it is a strong-player database anyway, so it cannot answer "what does a 1400
  actually play against me".
- The scoring is all in [`src/domain/repertoire.ts`](../../src/domain/repertoire.ts) and
  [`repertoirePgn.ts`](../../src/domain/repertoirePgn.ts), unit-tested. This directory is IO and
  orchestration only.
