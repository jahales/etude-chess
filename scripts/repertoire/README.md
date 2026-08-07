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
> independent ~32 MiB frames, and a trailing seek table. **Node's own zstd binding cannot read
> them.** `createZstdDecompress` decodes only the first frame and then stops — measured on a real
> dump it produced **0 MB and raised no error**, which is how a well-formed book got built from
> ~3% of the games.
>
> So decompression goes through **libzstd** (`zstd-napi`), whose streaming decoder consumes
> concatenated frames natively: 902 MB from the same input. That replaced ~250 lines of
> hand-rolled frame splitting which had caused three separate faults on its own. See
> [decompress.mjs](decompress.mjs).
>
> Verified against 2013-01, whose documented total is 121,332 games — `verifyBook.mjs` asserts
> that number, and it is what exposed the original silent truncation.

### Checking a book is actually right — `verifyBook.mjs`

```bash
node scripts/repertoire/verifyBook.mjs out/band.json
```

Worth running after every build, and worth knowing why it exists: of the defects found while
building this generator, **none** were caught by the unit tests and **every one produced a
plausible-looking book rather than an error**. A book built from 3% of the games looks exactly
like a book built from all of them. Logic tests can't see that; assertions against the data can.

It checks canonical SAN (no `Bf5?!` splitting a move's record), well-formed tallies, move
legality on a sample, that the games used actually reached the start position, and that
e4/d4/Nf3/c4 dominate the first move — which is true of any real chess database and false of a
mis-parsed scan. Where a month's total is known it compares against that too; the documented
121,332 for 2013-01 is what exposed the silent zstd truncation. Exits non-zero on an error, so
it can gate a pipeline.

The first-move profile it prints is also the clearest illustration of why two sources matter:

```
band 1500–1900   e4 60.9% · d4 26.1% · c4 3.2% · Nf3 2.7%
OTB  2200–2900   e4 41.8% · d4 41.7% · Nf3 8.6% · c4 7.2%
```

### Confirming a trap is real — `replicate.mjs`

```bash
node scripts/repertoire/replicate.mjs out/qg-jun.json out/qg-may.json
```

`trapValue` is a statistic over noisy human data. A sample-size floor bounds how badly *one*
month can mislead us; it cannot say whether a finding is real. Replication can — build a second
band book from a different month, crawl the same lines, and keep what survives both. This is
constitution §9's held-out set turned on the generator itself.

It separates three outcomes, and the distinction matters: **replicated** (both months found it,
with values within `AGREEMENT_FACTOR` — presence alone isn't enough, a trap worth 0.3 in one
month and 0.004 in the other is not the same finding twice), **contradicted** (the other month
expanded that position and did *not* flag the move), and **unseen** (the other run never reached
the position at all — a coverage gap, not a refutation, and reported apart so it can't be
mistaken for one).

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

## Building the whole repertoire — `build.mjs`

`crawl.mjs` produces **one** branch. `build.mjs` produces the repertoire: every branch of
[`manifest.v1.json`](manifest.v1.json), one engine process, one PGN holding a game per branch.

```bash
node scripts/repertoire/build.mjs --book out/band.json --canon-book out/otb.json --nodes 1000000
```

```
--manifest <path>   branch list                     (default: manifest.v1.json)
--out      <dir>    output directory                (default: out/repertoire)
--book / --canon-book   as crawl.mjs — band and masters
--only     a,b,c    build these branch ids only
--nodes    400000   engine budget per position
--max-ply  10       floor for the per-branch depth cap
--resume            skip branches already built
--check             validate the manifest and exit — no engine, no crawling
```

### Why a manifest rather than a shell loop

Because branches **overlap, and overlapping branches disagree**. A sweeper crawl from
`d4 d5 c4` picks its own answer to 2...e6; the curated QGD Exchange crawl forces 3.cxd5. Both
are sound. A repertoire containing both is not a repertoire — the one property it must have is
that you know which move you play.

So each branch **owns** its subtree. Any other branch reaching into it stops at the boundary
and says who covers it, in the JSON and in the PGN:

```
(2... dxc4 { [%eval 0.43] } {covered in the "qga" line})
```

The boundary is derived, not written by hand
([`src/domain/repertoirePlan.ts`](../../src/domain/repertoirePlan.ts)): it sits one ply past a
branch's own prefix — the first position where two branches could differ — and ownership goes
to the *shortest* branch reaching through it, so `1.d4` hands 1...d5 to the Queen's Gambit
sweeper rather than to the QGD Exchange buried beneath it.

Two consequences worth knowing. `--only` still derives boundaries from the **whole** manifest,
so rebuilding one branch cannot produce something that contradicts the branches it skipped. And
a trap whose subtree is delegated is *not* reported as unverified — the owning branch does that
verification, and printing "punishment not verified" over a line that has in fact been checked
trains you to ignore the warning that matters.

### The check that runs before the engine does

```bash
node scripts/repertoire/build.mjs --check
```

The one that earns its keep is the **coverage gap**. When a branch stops at a boundary the
owner picks up from its own prefix, so every ply the owner forces beyond that boundary is a
position neither branch examined. Harmless when those plies are *ours* — a single choice we
were going to make anyway. A hole when any of them is the opponent's:

```
error: [caro] stops at "e4 c6 d4" for "caro-advance", which then assumes e5 —
       the opponent's alternatives there are covered by nothing.
       Add an entry whose line is "e4 c6 d4 d5".
```

That manifest would have produced a Caro-Kann with no answer to 3.Nc3 or 3.exd5, and it would
have looked complete. Nothing is crawled until the plan is clean.

### Writing a manifest entry

A forced `line` pins the **opening choice** and stops. Everything past it is the generator's
job: which deviations to cover, how deep, where the line goes quiet. Forcing a whole main line
would make this a memorisation deck with extra steps (constitution §1).

```json
{
  "id": "qgd-exchange",
  "name": "QGD Exchange — the Carlsbad",
  "color": "w",
  "line": "d4 d5 c4 e6 cxd5",
  "why": "One structure, one plan: the minority attack with b4-b5."
}
```

`why` becomes the comment before the first move, so a drill says what it is drilling.

**Depth is set by a floor and a per-branch minimum.** `minPly = max(10, prefix + 4)` and
`maxPly = max(minPly + 2, prefix + 8)`. The floor is the one that decides how deep the output
actually runs — a line stops the moment it is *allowed* to, since almost every opening position
is quiet by move 4, so `maxPly` is rarely reached. Raise or lower it for a whole run with
`--min-ply`. Both parts matter. A flat depth cap
leaves a branch starting at ply 6 two moves to find a quiet position while handing a
"don't be surprised by 1...c5" sweeper a nine-ply tree. And a flat *floor* is worse: the
Caro-Kann Advance opens `1.e4 c6 2.d4 d5 3.e5 Bf5`, which is already quiet at ply 6 — so the
branch terminated on its own root and was one node with no content. The prefix is scaffolding to
reach the position worth studying; it cannot also be the study. Override either per entry.

**`role` decides depth**, and is the knob to reach for when the repertoire gets too big to hold:
`curated` (the default, the base floor), `sweeper` (two plies shallower), `signpost` (four).
Demote a branch rather than shortening a curated line — see `ROLE_DEPTH_OFFSET` in
[build.mjs](build.mjs) for the measured reason.

They are **offsets**, so `--min-ply` raises all three together rather than flattening them onto
one number, and the ordering cannot invert when the base moves. A role never makes a branch
shallower than four plies past its own prefix, so demoting a branch with a deep curated prefix
buys nothing. An unrecognised role is an error `--check` catches, not a silent fall back to
full depth.

Other per-entry overrides: `trapThreshold`, `maxEvalPerNode`, `massTarget`, `maxOpponentMoves`,
and `minPly`/`maxPly` where a specific line needs an exact depth.
`massTarget` earns its keep on a sweeper whose popular replies all belong to other branches —
after `1.e4 c6 2.d4 d5`, White's 3.Nc3, 3.e5 and 3.exd5 are *exactly* 85% of the node, so the
default target is met before a single move that branch owns is reached and it covers nothing.
The build reports any branch that ends up in that state rather than letting it pass as a branch
with nothing to do:

```
⚠ 1 branch(es) covered nothing of their own:
  caro-2d4   [4 positions, 3 handed to other branches — raise its massTarget or drop it]
```

## Crawling a single line — `crawl.mjs`

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

**Sample size is guarded, and it matters more than it sounds.** The first real run ranked a
six-game line at the top with an apparent 83% score, burying a 317-game finding beneath it —
small samples produce enormous apparent outperformance and will dominate an unguarded ranking.
So the observed score is shrunk toward the engine's expectation in proportion to how little
evidence backs it (`TRAP_PRIOR_GAMES`), and anything under `TRAP_MIN_GAMES` is not ranked at
all. What the floor excludes is printed under *"too few to judge"* rather than dropped, because
a rare line might be the vicious one — we just can't tell it from a coin flip yet, and a bigger
book is the answer rather than a lower floor.

It also reports what it *didn't* cover — nodes that hit the evaluation cap, and lines that ran
out of book. A coverage cap that stays silent reads as "we covered everything" when it did not.

### What a whole build reports

`build.mjs` writes `summary.json` alongside the branches and prints the same numbers:

```
positions       1,043
to memorise     118 decisions of ours, answering 402 of theirs
quiet targets   197
```

**`to memorise` is the honest price of the repertoire** — positions where you must know which
move you play. It is the number [repertoire-v1.md](../../docs/repertoire-v1.md) promised rather
than guessed when it cut the London ("a number we will have, not a guess"). If it ever climbs
past what one person can hold, the fix is to cut branches from the manifest, not to crawl
shallower: a shallower crawl buys the same repertoire with the quiet positions chopped off, and
the quiet positions are the part worth training.

Traps are ranked across the **whole** repertoire, each tagged with the branch it was found in,
so the list answers "what should I study first" rather than "what did this crawl happen to see".

### A note on `--trap` and `--nodes`

The default threshold of `0.05` is high for this band. Measured on a 300k-game 1500–1900 book,
real club traps land between **0.005 and 0.05**: the Albin Counter-Gambit scores 0.0154 and the
Chigorin 0.0096 — both lines any 1400 will meet, neither of which the default flags. v1 was
built with `--trap 0.01`. The constant in [`repertoire.ts`](../../src/domain/repertoire.ts) is
unchanged, because one build's distribution is not enough evidence to move a default.

`--nodes` is a real trade. v1 was built at **120,000**, which is the budget the cross-month
replication was run at — of five traps that budget found in the Queen's Gambit, two survived both
a different month and an 8× change in budget. Higher budgets are better and cost linearly: at
roughly half a second per 400k-node search on a laptop, the full manifest at 400k is a matter of
hours rather than one.

## Importing into En Croissant

Open En Croissant → **Files** and import **`repertoire-white.pgn` and `repertoire-black.pgn`
separately**, then point the repertoire trainer at whichever side you are practising.

Two files, not one: En Croissant trains from a single colour's point of view, so a PGN holding
both is importable as neither — it would drill you as White in the Caro-Kann. The build writes a
combined `repertoire.pgn` as well, for reading the whole repertoire at once rather than for
importing.

One game per branch, each named in its `[Event]` header. The `?!`/`?`/`??` suffixes on opponent
moves and the `{quiet: N playable moves}` comments come through as annotations.

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
