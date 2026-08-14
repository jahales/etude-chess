# Repertoire generator

Offline pipeline that builds an opening repertoire from **human game statistics** + a **local
index of Lichess's evaluation dump**. Stockfish is still required — it runs the quiet test and
trap scoring, and backs the gate where the index cannot — but it no longer decides on its own
whether a move is sound. Ships no UI. Design and rationale: ADR [0021](../../docs/decisions/0021-opening-repertoire-generator.md), amended by
[0024](../../docs/decisions/0024-gate-on-a-local-evaluation-index.md) (the gate),
[0025](../../docs/decisions/0025-curated-lines-run-to-the-structure.md) (depth) and
[0026](../../docs/decisions/0026-retire-the-tactic-gap-at-high-node-budgets.md) (the tactic gap).
The curated line list it works from: [docs/repertoire-v1.md](../../docs/repertoire-v1.md).
Issues #88, #106.

Two outputs from one run:

- **`<out>.pgn`** — PGN with variations. Import into **En Croissant** and its spaced-repetition
  trainer has a repertoire to drill, today.
- **`<out>.json`** — every position with its statistics, evaluation, quiet-test result and trap
  scores. This is what etude-chess consumes when `epic:opening` comes up.

## The settings v2 actually ships at

Every example below is written against these. They are not defaults — the defaults in the
scripts are older and looser — so **prefer the named commands in `package.json`**, which carry
them:

| | | why |
|---|---|---|
| band | **1300–1800** Lichess blitz+rapid | the owner's real band. USCF ~1355; the old 1500–1900 was aspirational, and prepared for opponents who don't turn up. |
| band book | **8M games**, `--max-ply 20` | `db/book-band-2026-07.json`. Decides *their* moves and is the only thing `trapValue` runs on. |
| canon book | **2.82M** Lumbra OTB games, `--max-ply 20` | `db/book-otb.json`, 2200–2900. Decides *ours*. |
| gate | **`--eval-index db/eval-index`** | 401,283,893 Lichess evaluations at median depth 34–50, not the crawl's own search (ADR 0024). |
| `--nodes` | **4,000,000** | the fallback budget, for the 2–3% of gates the index cannot answer. |
| `--trap` | **0.01** | the 0.05 default is too high for this band — see [below](#a-note-on---trap-and---nodes). |
| depth | curated lines to **ply 16+** | far enough to reach the middlegame structure, not just the first quiet position (ADR 0025). |

```
npm run rep:build       # the 1.d4 + Black repertoire  → out/v2-main
npm run rep:build:e4    # the 1.e4 repertoire          → out/v2-e4
npm run rep:decks       # cut both into staged decks   → repertoire/v2
npm run rep:study       # rank decisions by study value
npm run rep:audit       # re-grade every prescribed move against the index
npm run rep:verify      # assert the evaluation index is intact
```

Shipped output is the staged decks in [repertoire/v2](../../repertoire/v2/), not one flat
repertoire.

## What it actually does

| Node | Logic |
|---|---|
| **Ours** | Pick exactly **one** move, ranked by soundness, **branching cost** and popularity at our band. Branching is weighted highest — a repertoire's real price is the number of replies it obliges you to learn. |
| **Opponent's** | Cover **many**: everything up to `--mass` of the games actually played at our band, **plus** anything `trapValue` flags as bad-but-overperforming. |

A line stops when the position goes **quiet** — at least three moves are playable, and the
position is roughly balanced. That terminal position is the item worth training; the moves before
it are scaffolding. Depth is therefore variable, not fixed.

A third test used to run here: a shallow and a deep search compared, to catch a hidden tactic.
It is now behind `--tactic-gap` and **off by default** — at 4M nodes it decided nothing across
412 assessed positions, mean gap 0.45 win% (ADR 0026). Turn it back on for any run at a low node
budget, where the two readings genuinely disagree.

Where no move humans play is sound — the normal case immediately after the opponent falls into a
trap — the crawler falls back to the **engine's** refutation and labels it as such in the PGN.

## What "sound" is measured against — `--eval-index`

The soundness gate rejects any candidate more than `SOUNDNESS_MAX_SWING` (5 win%) below the best
move. **What supplies those two numbers is no longer this crawl's own search.** With
`--eval-index` it is a local index of Lichess's evaluation dump — 401,283,893 positions at median
depth 34–50 — falling back to the engine only where a position is absent or shallower than
`MIN_INDEX_DEPTH` (25). On the shipped v2 build the index decided **1,303 of 1,331** our-move
gates for 1.d4+Black and 903 of 934 for 1.e4; the rest went to Stockfish.

Three boundaries, all load-bearing (ADR [0024](../../docs/decisions/0024-gate-on-a-local-evaluation-index.md)):

- **Both halves of the subtraction come from one source.** A depth-50 best against a depth-15
  candidate manufactures swing out of depth disagreement. If the index cannot score both, the
  whole comparison falls back to the engine.
- **Only the gate moves.** Trap scoring and the quiet test stay on the engine — `trapValue`'s
  distribution was calibrated against engine numbers, and the quiet test is a *shallow-versus-deep*
  comparison a single stored evaluation cannot take part in.
- **Candidates still come from human frequency** (ADR 0003). The index never proposes a move.

Without the flag a crawl behaves exactly as it did before, and the run says so — `gated by local
search only (no --eval-index)` rather than reporting the same numbers either way.

### Building the index — `buildEvalIndex.mjs`

```bash
node scripts/repertoire/buildEvalIndex.mjs --in db/lichess_db_eval.jsonl.zst --out db/eval-index
```

```
--in    db/lichess_db_eval.jsonl.zst   the Lichess evaluation dump, 21.7 GB   (CC0)
--out   db/eval-index                  where to write the buckets
--limit 1000000                        stop after this many records — a partial
                                       index for testing, flagged as such in its
                                       manifest so nothing mistakes it for whole
```

No B-tree: one streaming pass scatters fixed-width 40-byte records into 256 bucket files chosen
by the first byte of the key, then each bucket is sorted in memory on its own. Append-only
sequential writes, so the ~400M-row build costs **~25 minutes and 16.1 GB** rather than the six-to-
twelve hours 400M random B-tree inserts would. A lookup hashes the FEN, opens one bucket and
binary-searches it. Buckets are never concatenated, so a build is restartable a bucket at a time.

### Checking it — `verifyEvalDb.mjs` (`npm run rep:verify`)

```bash
node scripts/repertoire/verifyEvalDb.mjs [--index db/eval-index] [--deep]
```

The sibling of `verifyBook.mjs`, and it exists for the same reason: **an index built from a
truncated download answers "not in the database" for everything, and looks exactly like a
database that happens not to cover your positions.** Two conventions of the dump were *measured*
rather than read from documentation, because both fail silently — scores are **White-relative**,
not side-to-move, and the **en passant square appears only when the capture is legal** (0.17% of
positions), so foreign FENs are normalised before hashing.

## Prerequisites

- **Node 24+** (the scripts import `.ts` domain modules directly via type stripping, and use
  native zstd).
- **A Stockfish binary.** Defaults to the one En Croissant installs:
  `%APPDATA%\org.encroissant.app\engines\stockfish\stockfish-windows-x86-64-avx2.exe`.
  Override with `--engine <path>` or `STOCKFISH_PATH`.
- **A source of human move statistics** — either a local book (below, recommended) or network
  access to `explorer.lichess.ovh`. Explorer responses are cached under
  `<out-dir>/.explorer-cache`, so re-runs and threshold tuning cost zero requests.
- **The evaluation index**, for `--eval-index`. 16.1 GB under `db/eval-index`, built once by
  `buildEvalIndex.mjs` from the 21.7 GB Lichess dump. Optional — without it the gate is the
  crawl's own search, which is what v1 shipped — but every v2 number assumes it.

`db/` and `out/` are gitignored and stay that way: third-party data that does not travel with the
repo — `db/` is **89 GB** as everything above is built here, most of it the two monthly dumps and
the evaluation dump. Re-fetch before any crawl or book build.

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
     --book db/book-band-2026-07.json --canon-book db/book-otb.json \
     --eval-index db/eval-index --out out/qga
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

This is the exact command the shipped band book was built with — **1300–1800, ply 20, 8M games**:

```bash
node scripts/repertoire/buildBook.mjs --month 2026-07 --out db/book-band-2026-07.json \
     --ratings 1300-1800 --speeds blitz,rapid --max-ply 20 --max-games 8000000
```

That scanned 29.9M games to reach 8M in band (27%) and kept 1,067,715 positions. Swap `--month`
for `2026-06` to build the second month replication needs; nothing else changes.

The dumps are streamed and decompressed on the fly, and the download is **aborted** once
`--max-games` in-band games have been read — so `--max-games` decides the cost, not the file
size. That matters: 2013-01 is 17 MB, 2016-01 is 831 MB, a 2026 month is ~27 GB.

```
--month     2026-07        which monthly dump to stream     (required unless --file)
--file      games.pgn      a local file: .pgn, .pgn.gz, .pgn.zst or .7z (sniffed,
                           not taken from the name)
--out       db/book.json   where to write                   (required)
--ratings   1300-1800      both players must fall in this band  (default: 1600-2000)
--speeds    blitz,rapid    time controls to include   (default: blitz,rapid,classical)
--max-ply   20             plies recorded per game                    (default: 16)
--max-games 8000000        stop (and abort the download) after this many in-band
                           games                                  (default: 200000)
--min-games 5              drop moves seen fewer times than this        (default: 5)
--cache     db/cache       keep the dump bytes actually read and reuse them next
                           run                                (default: db/cache)
--no-cache                 stream without keeping anything on disk
--one-pass                 skip the counting pass. A local file is built in two
                           passes by default — counting first costs a second read
                           and saves most of the memory, which is what lets
                           --max-ply go to 20. A network month is always one pass,
                           because re-reading it means re-downloading it.
--filter-bits 26           width of that counting table; memory is 2^bits bytes.
                           The build warns when the table passes 50% loaded.
```

Then point the crawler at it with `--book db/book-band-2026-07.json`.

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
node scripts/repertoire/verifyBook.mjs db/book-band-2026-07.json
```

One positional argument, no flags. Worth running after every build, and worth knowing why it exists: of the defects found while
building this generator, **none** were caught by the unit tests and **every one produced a
plausible-looking book rather than an error**. A book built from 3% of the games looks exactly
like a book built from all of them. Logic tests can't see that; assertions against the data can.

It checks canonical SAN (no `Bf5?!` splitting a move's record), well-formed tallies, move
legality on a sample, that the games used actually reached the start position, and that
e4/d4/Nf3/c4 dominate the first move — which is true of any real chess database and false of a
mis-parsed scan. Where a month's total is known it compares against that too; the documented
121,332 for 2013-01 is what exposed the silent zstd truncation. Exits non-zero on an error, so
it can gate a pipeline.

The first-move profile it prints is also the clearest illustration of why two sources matter.
**Measured on the v1 books** — a 300k-game 1500–1900 band book and the OTB book of the day:

```
band 1500–1900   e4 60.9% · d4 26.1% · c4 3.2% · Nf3 2.7%
OTB  2200–2900   e4 41.8% · d4 41.7% · Nf3 8.6% · c4 7.2%
```

The v2 books, at the band actually faced, say the same thing more sharply — the gap in `c4` and
`Nf3` is most of what "principled" costs to learn:

```
band 1300–1800   e4 62.7% · d4 25.0% · c4 2.7% · Nf3 2.6%    (8M games, 2026-07)
OTB  2200–2900   e4 45.6% · d4 35.4% · Nf3 10.2% · c4 7.0%   (2.82M Lumbra games)
```

### Confirming a trap is real — `replicate.mjs`

```bash
node scripts/repertoire/replicate.mjs <runA.json> <runB.json> [merged.json]

# what v2 was replicated with — a full July build against a full June one:
node scripts/repertoire/replicate.mjs out/v2-main/summary.json out/jun-main/summary.json \
     out/replicated-main.json
```

Positional arguments, no flags. The optional third path writes the merged verdict, and that file
is what `rep:decks` takes as `--replicated` — a trap the second month did not confirm keeps its
statistics in the deck but loses the word inviting you to trust them, relabelled `one month only`.

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

The command the shipped canon book was built with:

```bash
node scripts/repertoire/buildBook.mjs --file "LumbrasGigaBase_OTB_Complete.7z" \
     --out db/book-otb.json --ratings 2200-2900 --max-ply 20 --max-games 9000000 --min-games 3
```

`--max-games` is above the archive's size on purpose — this one is meant to run to the end. It
scanned 10,355,488 games and kept **2,823,188** in band, 705,750 positions. `--min-games 3`
rather than 5 because master games are far scarcer than online ones.

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
buckets, comma-separated — not the `min-max` range `buildBook.mjs` takes). Note that the buckets
are coarse: the closest the explorer gets to 1300–1800 is `1200,1400,1600`, which is one reason
everything shipped is built from a local book instead.

## Building the whole repertoire — `build.mjs`

`crawl.mjs` produces **one** branch. `build.mjs` produces the repertoire: every branch of a
manifest, one engine process, one PGN holding a game per branch. Two manifests ship —
[`manifest.v1.json`](manifest.v1.json) (27 branches: 1.d4 as White, and all of Black) and
[`manifest.e4.json`](manifest.e4.json) (12 branches, the second White repertoire, ADR
[0023](../../docs/decisions/0023-second-white-repertoire-1-e4.md)).

Each has a named command carrying the v2 settings — `npm run rep:build` and
`npm run rep:build:e4`. They expand to this; the settings are identical and only the manifest and
the output directory differ, so copy the one you mean to vary:

```bash
# npm run rep:build
node scripts/repertoire/build.mjs --book db/book-band-2026-07.json \
     --canon-book db/book-otb.json --eval-index db/eval-index \
     --nodes 4000000 --trap 0.01 --out out/v2-main

# npm run rep:build:e4
node scripts/repertoire/build.mjs --book db/book-band-2026-07.json \
     --canon-book db/book-otb.json --eval-index db/eval-index \
     --nodes 4000000 --trap 0.01 \
     --manifest scripts/repertoire/manifest.e4.json --out out/v2-e4
```

```
--manifest <path>      branch list                    (default: manifest.v1.json)
--out      <dir>       output directory               (default: out/repertoire)
--book       <path>    OUR BAND: what opponents actually play. Decides theirs.
--canon-book <path>    MASTERS: what is principled. Decides ours.
--eval-index <path>    gate our moves on the local evaluation index rather than
                       --nodes, falling back to the engine where a position is
                       absent or shallower than depth 25
--only     a,b,c       build these branch ids only
--nodes    400000      engine budget per position — now only the fallback
--trap     0.05        trapValue threshold
--mass     0.85        opponent coverage target
--max-eval 20          opponent moves evaluated per node
--min-node-games 50    stop expanding below this many games in the band book
--max-replies    6     most opponent moves covered at one node
--min-ply  16          base floor for a curated branch. A line stops as soon as
                       it may, so this is what decides depth. Sweepers sit 8
                       plies below it, signposts 10, and all three move with it.
--crawl-plies 8        plies each branch crawls past its curated prefix
--tactic-gap           buy a second, shallower search and test it against the
                       deep one. Off by default (ADR 0026); worth it below ~1M
                       nodes, worth nothing above
--pool     10          engines evaluating candidates in parallel. Each stays
                       single-threaded, so results are identical to a serial run
                       and only the wall clock changes. Defaults to half the
                       cores, bounded by a twelfth of RAM per engine; 1 disables
--resume               skip branches whose output already exists
--check                validate the manifest and exit — no engine, no crawling
--engine   <path>      Stockfish binary
```

**There is no `--max-ply` on `build.mjs`** — depth is `--min-ply` plus `--crawl-plies`, and an
unknown flag is now a hard error rather than a silent default. That rejection is deliberate: a
dropped `--trap 0.01` ran a whole build at the default, found nothing, and reported success.
`--trap` and friends take a value for the same reason — `parseArgs` marks a bare flag `true`,
`Number(true)` is 1, and `--trap --nodes 120000` once ran the build at a trap threshold of 1.
Both hardenings — `numberFlag` and the unknown-flag rejection — are **`build.mjs`'s alone**;
`crawl.mjs` has neither, which is [#115](https://github.com/jahales/etude-chess/issues/115) and
is spelled out under its options below.

### Why a manifest rather than a shell loop

Because branches **overlap, and overlapping branches disagree**. A sweeper crawl from
`d4 d5 c4` picks its own answer to 2...e6; the curated QGD Exchange crawl forces 3.cxd5. Both
are sound. A repertoire containing both is not a repertoire — the one property it must have is
that you know which move you play.

So each branch **owns** its subtree. Any other branch reaching into it stops at the boundary
and says who covers it, in the JSON and in the PGN:

```
(2... dxc4 { [%eval 0.27] · covered in the "qg-sidelines" line})
```

**One comment, always.** Everything a move has to say is folded into a single pair of braces —
eval, trap statistics, delegation, why the line stopped. Two adjacent `{…}` comments are legal by
the PGN spec and rejected by real parsers, En Croissant's among them.

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

**Depth is set by a floor and a per-branch minimum.** `minPly = max(floorForRole(role), prefix + 4)`
and `maxPly = max(minPly + 6, prefix + 8)`, with the base floor at **16**. The floor is the one
that decides how deep the output actually runs — a line stops the moment it is *allowed* to, since
almost every opening position is quiet by move 4, so `maxPly` is rarely reached. Raise or lower it
for a whole run with `--min-ply`, and move the cap with `--crawl-plies`. Both parts matter. A flat
depth cap leaves a branch starting at ply 6 two moves to find a quiet position while handing a
"don't be surprised by 1...c5" sweeper a nine-ply tree. And a flat *floor* is worse: the
Caro-Kann Advance opens `1.e4 c6 2.d4 d5 3.e5 Bf5`, which is already quiet at ply 6 — so the
branch terminated on its own root and was one node with no content. The prefix is scaffolding to
reach the position worth studying; it cannot also be the study. Override either per entry.

**The base floor was 10 and is now 16** (ADR
[0025](../../docs/decisions/0025-curated-lines-run-to-the-structure.md)). At 10 the repertoire
stopped on the first quiet position, which is before the middlegame structure exists — v1's
deepest line was ply 13, and a Carlsbad or a French chain does not form until roughly ply 16–25.
The quiet position is still the trainable item; the deeper floor says keep going until the
*structural* one is reached. Raising it forced two other numbers: `QUIET_HEADROOM` went 2 → 6,
because the cap is tested *before* the quiet test and 2 plies had become the entire search window,
and every hand-pinned `maxPly` from the old base ended up underneath the new floor — which
`--check` now catches (`badDepths`) rather than shipping a tree with zero trainable positions.

**`role` decides depth**, and is the knob to reach for when the repertoire gets too big to hold:
`curated` (the default, the base floor), `sweeper` (**8** plies shallower), `signpost` (**10**).
The spread widened with the base: the point of ply 16 is to carry curated lines into the
middlegame structure, and none of that reasoning applies to a sweeper whose job is to meet
1...c5 at all. At the old −2/−4 the new base would have dragged sweepers from 8 plies to 14 and
re-created the 467-decision build these roles exist to prevent; −8/−10 holds them at exactly the
8 and 6 they had before. Demote a branch rather than shortening a curated line — see
`ROLE_DEPTH_OFFSET` in [build.mjs](build.mjs) for the measured reason.

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

This is the script to reach for to test a manifest change before spending an hour on a full
build — it shares `build.mjs`'s depth constants, so one branch here crawls to the same depth it
will in the build.

```bash
node scripts/repertoire/crawl.mjs --color white --line "d4 d5 c4 dxc4" \
     --book db/book-band-2026-07.json --canon-book db/book-otb.json \
     --eval-index db/eval-index --nodes 4000000 --trap 0.01 --out out/qga
```

That crawls the QGA subtree: the pawn-grab problem, which is both the most valuable line for a
1400 and the best test of the trap detector, because we already know roughly what the answer
should look like (3.e3, don't chase the pawn, punish ...b5 with a4).

Then widen. Keep the same flags — with no `--book` the crawl silently falls back to the explorer
API at *its* default band, which is not ours:

```bash
BOOKS="--book db/book-band-2026-07.json --canon-book db/book-otb.json --eval-index db/eval-index"

node scripts/repertoire/crawl.mjs --color white --line "d4 d5 c4"    $BOOKS --out out/qg
node scripts/repertoire/crawl.mjs --color black --line "e4 c6"       $BOOKS --out out/caro
node scripts/repertoire/crawl.mjs --color black --line "d4 d5 c4 c6" $BOOKS --out out/slav
```

### Options — `crawl.mjs`

```
--color   white | black       which side the repertoire is for        (required)
--line    "d4 d5 c4"          curated prefix, followed verbatim
--out     out/qga             output basename, .json and .pgn           (required)
--book       <path>           OUR BAND: what opponents actually play. Decides
                              theirs. A local book, instead of the API.
--canon-book <path>           MASTERS: what is principled. Decides OURS.
                              Optional; without it the band book decides both.
--canon                       use the masters explorer API as the canonical
                              source instead of --canon-book
--eval-index db/eval-index    gate our moves on the local evaluation index
--source  amateur | masters   explorer endpoint               (default: amateur)
--ratings 1600,1800           rating buckets, amateur only (explorer only —
                              a local book is already banded at build time)
--min-ply 16                  earliest a line may stop          (default: 16)
--max-ply 24                  depth cap in plies. Must stay above --min-ply:
                              the cap is checked before the quiet test, so a
                              cap at the floor means no position is ever tested
                              for quietness                     (default: 24)
--nodes   400000              engine budget per position
--mass    0.85                opponent coverage target
--trap    0.05                trapValue threshold
--max-eval       20           opponent moves evaluated per node. Candidates come
                              in frequency order, so this cap chops the tail —
                              where traps live. Raise it to hunt.
--min-node-games 50           stop expanding below this many games in the book
--max-replies    6            most opponent moves covered at one node
--tactic-gap                  the shallow-vs-deep test, off by default
--pool    10                  engines evaluating candidates in parallel
--engine  <path>              Stockfish binary
```

`--ratings` applies to the **explorer path only** — a local `--book` was banded when it was
built, and passing `--ratings` alongside it does nothing. The explorer default, buckets 1600 and
1800, is now *above* the band this repertoire targets: 1300–1800 is the owner's real Lichess
blitz/rapid band, against a USCF of roughly 1355. It was 1500–1900 in v1, which was aspirational
and prepared for opponents who do not turn up — the club traps that matter (Englund, Wayward
Queen, Fried Liver) have largely died out by 1800.

Unlike `build.mjs`, this script **ignores flags it does not recognise** rather than rejecting
them, so a typo here fails silently. It never adopted `numberFlag` either, so a bare `--trap`
arrives as `Number(true)` = **1** and the run finds nothing — the same failure this file
describes as fixed [above](#building-the-whole-repertoire--buildmjs), which it is, in `build.mjs`
only. Both are issue [#115](https://github.com/jahales/etude-chess/issues/115).

**Check a flag against the table above, not against `--help`.** That issue also covers the help
text, which has drifted from the code in both scripts: `crawl.mjs`'s omits `--tactic-gap`
entirely, though the flag is real and read at `crawl.mjs:912`, and `build.mjs`'s still says
`--min-ply 10` with −2/−4 role offsets when the base floor is 16 and the offsets −8/−10. A flag
missing from `--help` on a script that ignores what it does not recognise reads as a flag that
does not exist.

## Reading the output

The run prints a ranked trap list. One line from a v1 run, on the 300k-game 1500–1900 book:

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

`build.mjs` writes `summary.json` alongside the branches and prints the same numbers. The shipped
1.d4 + Black build (`npm run rep:build`, 2026-08-11):

```
positions       3,470
to memorise     1,331 decisions of ours, answering 2,275 of theirs
gated by        index 1,303 · local search 28
quiet targets   423
```

**`gated by` is there so a run cannot report the same numbers whether the index covered
everything or nothing.** Without `--eval-index` it reads `local search only (no --eval-index)`.

**`to memorise` is the honest price of the repertoire** — positions where you must know which
move you play. It is the number [repertoire-v1.md](../../docs/repertoire-v1.md) promised rather
than guessed when it cut the London ("a number we will have, not a guess").

**It has climbed past what one person can hold, and crawling shallower is still the wrong fix**:
a shallower crawl buys the same repertoire with the quiet positions chopped off, and the quiet
positions are the part worth training. v1's 551 decisions became 2,265 across both builds when
the floor went to ply 16 — that is the two crawls' own `ourDecisions`, 1,331 + 934, and it is not
the 2,298 the shipped decks hold, which counts decisions in the **merged, grafted** decks
instead. Both numbers are right for what they measure; what produces the 33 between them has not
been traced. The answer taken was to cut the *drilling* rather than the build —
`studyDecks.mjs` ranks every decision and ships a 525-decision `standard` deck ahead of the
complete one, prefix-closed so each tier is a set of whole lines. Cutting branches from the
manifest is still available and still the right move when a branch is not worth having at all;
it is not the tool for "this is too much to learn at once".

Traps are ranked across the **whole** repertoire, each tagged with the branch it was found in,
so the list answers "what should I study first" rather than "what did this crawl happen to see".

### A note on `--trap` and `--nodes`

The default threshold of `0.05` is high for this band. **Measured on the v1 book — 300k games at
1500–1900** — real club traps land between **0.005 and 0.05**: the Albin Counter-Gambit scores
0.0154 and the Chigorin 0.0096, both lines any 1400 will meet, neither of which the default
flags. That measurement is why `--trap 0.01` has been the setting ever since, in v1 and in v2's
`rep:build`. The constant in [`repertoire.ts`](../../src/domain/repertoire.ts) is unchanged,
because one build's distribution is not enough evidence to move a default.

`--nodes` is a real trade, and it now buys less than it used to, because the soundness gate has
moved off it. **v1 was built at 120,000**, roughly depth 15 — the budget the first cross-month
replication ran at, where of five traps that budget found in the Queen's Gambit, two survived
both a different month and an 8× change in budget. **v2 runs at 4,000,000**, but only for what
the index cannot answer: 28 of 1,331 gates in the 1.d4 build. The #106 audit re-graded all 585
moves v1 prescribed against the depth-34–50 index and found **6 conceding more than the 5 win%
gate, all Tier B, no blunders** — so the 120k gate held up, and moving to the index was removing
a weak basis for a decision drilled for months rather than a rescue.

Two knock-on effects of the higher budget are worth knowing. The tactic-gap test stops deciding
anything (ADR 0026, above) — at 4M against a 667k shallow, both readings are past the horizon of
ordinary opening tactics. And the trap and quiet numbers stay on the engine deliberately, so they
*do* still move with `--nodes`; a run at a different budget is not comparable on those.

## After the build: ranking, cutting, auditing

A build is not the shipped artifact. Three scripts turn it into one, and all three read the
finished PGNs back rather than the build's own memory — which is what issue #102 was for.

### What to study first — `studyOrder.mjs` (`npm run rep:study`)

```bash
node scripts/repertoire/studyOrder.mjs --book db/book-band-2026-07.json
```

```
--pgn   a.pgn,b.pgn   repertoire PGNs   (default: repertoire/v2/etude-{white,black}-complete.pgn)
--book  <path>        band book, for reach          (default: db/book-band-2026-07.json)
--index <path>        evaluation index, for cost           (default: db/eval-index)
--top   30            rows to print
--out   <path>        full ranking as JSON             (default: out/study-order.json)
```

`value = reach × cost`. **Reach** is how often you actually arrive at the position, from the band
book. **Cost** is not "how good is our move" — every move in the repertoire passed the gate, so
they are all good. It is the gap to what you would have played *instead*: the most popular
alternative at our band, the instinctive one, scored from the index. **A decision where instinct
is already right is worth nothing to study however common** — you will find it at the board.

It used to default to `db/book-band.json` — the superseded 5M-game ply-12 book — while
`studyDecks.mjs` defaulted to the dated `db/book-band-2026-07.json`. Because the old book is still
on disk, a bare run found it, ranked everything against stale frequencies and printed a confident
wrong order, with nothing in the output naming the book. Both now default to the dated book and
the ranking prints the path it read ([#115](https://github.com/jahales/etude-chess/issues/115)).

### Cutting the staged decks — `studyDecks.mjs` (`npm run rep:decks`)

```bash
node scripts/repertoire/studyDecks.mjs \
     --pgn out/v2-main/repertoire-white.pgn,out/v2-main/repertoire-black.pgn,out/v2-e4/repertoire-white.pgn \
     --sizes 500 --book db/book-band-2026-07.json --out repertoire/v2 \
     --replicated out/replicated-main.json,out/replicated-e4.json
```

```
--pgn        a,b,c    repertoire PGNs to merge and cut                   (required)
--sizes      500      decision budget per tier, comma-separated    (default: 150,500)
--book       <path>   band book                   (default: db/book-band-2026-07.json)
--index      <path>   evaluation index                       (default: db/eval-index)
--replicated a,b      replicate.mjs outputs; confirmed traps are pinned into the
                      first tier and unconfirmed ones relabelled `one month only`
--out        <dir>    where the decks go                    (default: out/decks)
```

Tier names come from how many there are, not from a fixed list: one is `complete`, two are
`standard`/`complete`, three are `core`/`standard`/`complete`. So `--sizes 500` ships the two
tiers v2 actually has — a `core`/`standard` split would have left the *complete* repertoire
called "standard".

Two rules do the work. Tiers are **prefix-closed** — a decision is admitted with every decision
on the path to it, and the budget pays for the ancestors, because you cannot drill move 12 of the
Carlsbad without moves 1 to 11. And **replicated traps are pinned regardless of rank**: a trap is
the *opponent's* move, so `studyOrder` cannot see its value, and left to the ranking the standard
White deck held 2 trap comments out of 282 confirmed. It now holds 247.

Output is **one file per colour, not per source**. Colour is the only axis En Croissant has, and
the 1.d4 and 1.e4 repertoires are both White, so they belong in one White deck.

### Re-grading what shipped — `auditRepertoire.mjs` (`npm run rep:audit`)

```bash
node scripts/repertoire/auditRepertoire.mjs [--index db/eval-index] [--out out/audit-106.json]
```

Reads `repertoire/v2/etude-{white,black}-complete.pgn` back and re-grades **every move the
repertoire prescribes** against the index: unsound if it gives up more than `SOUNDNESS_MAX_SWING`
(5 win%) versus the best. Also reports positions answered two different ways within one deck,
which is the check that branch ownership actually held through the graft.

It says so when the index it is auditing against is partial (`built with --limit`). What it
*cannot* see: candidates the gate wrongly **rejected**. That is a separate measurement, not a
claim this script makes.

## Importing into En Croissant

Import the two files for your tier from [repertoire/v2](../../repertoire/v2/) — **one per
colour, separately** — via Files → Add New → from PGN, then point the repertoire trainer at
whichever side you are practising. `complete` is a superset of `standard`, so when you move up,
**remove the previous import first**: keeping both drills every line twice and the scheduler
treats them as separate items.

Two files, not one: En Croissant trains from a single colour's point of view, so a PGN holding
both is importable as neither — it would drill you as White in the Caro-Kann.

`build.mjs`'s own `repertoire-white.pgn` / `repertoire-black.pgn` are importable too, and are
what to use for a one-off crawl you have not cut into decks. They hold **one game per branch**,
each named in its `[Event]` header — which is the unit the *build* needs, because it is what
makes branch ownership work, and the wrong unit for drilling: the White deck was otherwise 26
games for 144 decisions, seventeen of them five moves or fewer. `studyDecks.mjs` grafts them into
one game per entry point. The combined `repertoire.pgn` is for reading the whole thing at once,
not for importing.

The `?!`/`?`/`??` suffixes on opponent moves and the comments come through as annotations:

```
{ [%eval 0.76] · trap · 18% play this · they score 47% where 43% is deserved · n=2652 }
{ [%eval 0.62] · quiet: 5 playable moves — judgment from here}
```

## Caveats

- **The explorer response shape is assumed, not verified here** — `explorer.lichess.ovh` was
  unreachable from the network this was written on (HTTP 401), which is why the local-book path
  exists. The client fails loudly with a clear message if the payload lacks a `moves` array. If
  Lichess has changed the API, that error is where to look. The **local book path is fully
  verified** end to end.
- **A book is only as deep as the games you fed it.** With too few games the crawl terminates
  early with `out of book (0 games)` — that is the book being thin, not the position being
  unplayable. Raise `--max-games` on `buildBook.mjs`, or lower `--min-node-games` on the crawl.
  Deeper lines make this the common terminator rather than a warning sign: the shipped 1.d4
  build ran out of book on 780 lines at ply 16+, which is a real statement about how far 8M
  club games reach, not a defect.
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
