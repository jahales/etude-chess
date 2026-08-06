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

- **Node 24+** (the scripts import `.ts` domain modules directly via type stripping, and use
  native zstd).
- **A Stockfish binary.** Defaults to the one En Croissant installs:
  `%APPDATA%\org.encroissant.app\engines\stockfish\stockfish-windows-x86-64-avx2.exe`.
  Override with `--engine <path>` or `STOCKFISH_PATH`.
- **A source of human move statistics** — either a local book (below, recommended) or network
  access to `explorer.lichess.ovh`. Explorer responses are cached under
  `<out-dir>/.explorer-cache`, so re-runs and threshold tuning cost zero requests.

## Two sources, two questions

The generator takes **two** books, and which one applies is decided by whose move it is:

| Node | Source | Question it answers |
|---|---|---|
| **Ours** | `--canon-book` — master games | *What is principled here?* The ideal we're trying to learn. |
| **Opponent's** | `--book` — our own rating band | *What will actually be played at me?* Including the junk. |

Using band data to choose our own moves would have us learning what 1400s happen to play; using
master data to predict theirs would prepare us for opponents who don't exist.

One deliberate asymmetry: our move's **branching cost is measured against band replies**, not
master ones. The replies we have to prepare are the ones we'll face — and a line that's narrow
at master level can be wide open at 1400.

```bash
node scripts/repertoire/crawl.mjs --color white --line "d4 d5 c4 dxc4" \
     --book out/band.json --canon-book out/otb.json --out out/qga
```

`--canon-book` is optional; without it the band book decides both halves. When it *is* supplied,
the run reports `decided by masters N · band M`, and any of our moves that fell out of master
practice is marked in the PGN with `{beyond master theory — chosen from club play}` — so a move
picked from thin data can't pass for established theory.

## Two sources of human statistics

### A local book (recommended) — `buildBook.mjs`

Builds an opening book straight from the [Lichess monthly database
dumps](https://database.lichess.org/). Preferred over the API because it is **reproducible** (a
fixed month, not a moving window), has no rate limit, can be filtered to any rating band and
time control, and works offline.

```bash
node scripts/repertoire/buildBook.mjs --month 2026-06 --out out/book.json \
     --ratings 1500-1900 --speeds blitz,rapid --max-ply 12 --max-games 800000
```

The dumps are streamed and decompressed on the fly, and the download is **aborted** once
`--max-games` in-band games have been read — so `--max-games` decides the cost, not the file
size. That matters: 2013-01 is 17 MB but a 2026 month is ~27 GB.

```
--month     2026-06        which monthly dump to stream     (required unless --file)
--file      games.pgn      a local file: .pgn, .pgn.gz or .pgn.zst (sniffed)
--out       out/book.json  where to write                   (required)
--ratings   1500-1900      both players must fall in this band
--speeds    blitz,rapid    time controls to include
--max-ply   12             plies recorded per game
--max-games 800000         stop (and abort the download) after this many in-band games
--min-games 5              drop moves seen fewer times than this
```

Then point the crawler at it with `--book out/book.json`.

> **Note on the dump format.** These are *seekable* zstd: a leading skippable frame, many
> independent ~32 MiB frames, and a trailing seek table. Node's `createZstdDecompress` decodes
> only the **first** frame and then rejects the next frame's header — piping a dump straight
> through it silently yields a well-formed book built from ~3% of the games, with no error.
> `buildBook.mjs` frames the stream itself to avoid that. Verified against 2013-01, whose
> documented total is 121,332 games.

### A third-party database (Lumbra's Gigabase, Caissabase, ChessBase, SCID…)

Any PGN works, including `.7z` archives — those are streamed **through** 7-Zip rather than
extracted, because [Lumbra's Gigabase](https://lumbrasgigabase.com/en/) ships 1.5 GB archives
that expand to roughly 10 GB of PGN and there is no reason to put that on disk.

```bash
node scripts/repertoire/buildBook.mjs --file "LumbrasGigaBase OTB.7z" \
     --out out/book-otb.json --ratings 2200-2900 --min-games 3
```

7-Zip is found automatically at its usual Windows locations; override with `SEVENZIP_PATH`.

**What these buy, and what they don't.** Lumbra's OTB set (10.3M games, deduplicated, monthly)
is a better *spine* than Caissabase — bigger, cleaner, and already PGN. But it is still
strong-player chess, so it answers "what is the principled main line", not "what will a 1400
play against me". Lumbra's *Online* set (7.2M) looks closer, but its **Elo 1800+ floor sits
above our band**, and the traps that matter — Englund, Wayward Queen, Fried Liver — have largely
died out by 1800. So use an OTB book to cross-check soundness, and keep a rating-banded Lichess
book as the source `trapValue` runs on.

Lumbra's is CC BY-NC-SA 4.0: fine for personal use, and we redistribute nothing (ADR 0018 ships
no corpus), but attribution and non-commercial terms apply to anything you do publish from it.

### The Lichess explorer API — `explorer.mjs`

The default when `--book` is not given. Same `query(fen)` interface, so the crawler neither
knows nor cares which it is talking to. Rating-banded via `--ratings 1600,1800` (explorer
buckets, comma-separated — not the `min-max` range `buildBook.mjs` takes).

## First run — the Queen's Gambit

```bash
node scripts/repertoire/crawl.mjs --color white --line "d4 d5 c4 dxc4" --book out/book.json --out out/qga
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

- **The explorer response shape is assumed, not verified here** — `explorer.lichess.ovh` was
  unreachable from the network this was written on (HTTP 401), which is why the local-book path
  exists. The client fails loudly with a clear message if the payload lacks a `moves` array. If
  Lichess has changed the API, that error is where to look. The **local book path is fully
  verified** end to end.
- **A book is only as deep as the games you fed it.** With too few games the crawl terminates
  early with `out of book (0 games)` — that is the book being thin, not the position being
  unplayable. Raise `--max-games`, or lower the crawler's `minNodeGames`.
- **Caissabase's `.db3` is not read directly, and does not need to be.** It is **not SCID** — it
  is En Croissant's own SQLite schema, and per [their
  docs](https://encroissant.org/docs/reference/database-format/) each move is *"the index of the
  move in the list of legal moves in the position"* as generated by **shakmaty**. That ordering
  is undocumented and pinned to a library version, so decoding means reimplementing shakmaty's
  move generation and re-verifying it on every upgrade. **Export PGN from En Croissant and pass
  it to `--file`** — same data, no reverse engineering, nothing to break.

  Worth knowing what it would buy, though: Caissabase is strong-player OTB, so it answers "what
  is the principled main line", not "what will a 1400 play against me". The Lichess dumps answer
  the second, and the second is the one `trapValue` needs.
- The scoring is all in [`src/domain/repertoire.ts`](../../src/domain/repertoire.ts) and
  [`repertoirePgn.ts`](../../src/domain/repertoirePgn.ts), unit-tested. This directory is IO and
  orchestration only.
