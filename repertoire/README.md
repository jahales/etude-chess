# The repertoire

**Generated output**, committed because it is the artefact the generator exists to produce and
an hour of engine time is a poor thing to ask of a reader who just wants to import it. Nothing
here is hand-written; edit [`manifest.v1.json`](../scripts/repertoire/manifest.v1.json) and
rebuild instead.

| File | What it is |
|---|---|
| `etude-repertoire-v1-white.pgn` | The White repertoire — 14 branches, one game each, named in its `[Event]` header. |
| `etude-repertoire-v1-black.pgn` | The Black repertoire — 11 branches. |
| `summary.json` | What it cost to build and what it costs to learn: theory load, the ranked trap list, and everything the build could *not* cover. |

## Importing into En Croissant

1. **Copy both `.pgn` files into En Croissant's documents directory.** By default
   that is `Documents\EnCroissant` — the Files page has an *open folder* button
   that takes you straight there, and the location is configurable in settings.
2. **Give each one a `.info` sidecar** with the same basename, so the app files
   it as a repertoire rather than as `other`:

   ```json
   { "type": "repertoire", "tags": [] }
   ```

   i.e. `etude-repertoire-v1-white.info` next to `etude-repertoire-v1-white.pgn`.
   En Croissant writes one of these itself for any `.pgn` it finds, but it
   defaults the type to `other`, and only a `repertoire` file offers Practice.
3. Open the file from the **Files** page and pick a branch — each game is one
   branch of the repertoire — then use **Practice** to drill it.

Every game carries `[Orientation "white"]` or `[Orientation "black"]`, which is
what the trainer reads to decide which side it is quizzing you on. Without it
the practice deck is built as White for everything (`headers.orientation ||
"white"`), so a Black repertoire hands you the opponent's side of every line.
That tag matters more than the file split does.

Why these openings and not others: [docs/repertoire-v1.md](../docs/repertoire-v1.md). How the
thing works: [scripts/repertoire/README.md](../scripts/repertoire/README.md). Why it terminates
at quiet positions instead of teaching lines: ADR
[0021](../docs/decisions/0021-opening-repertoire-generator.md). Why branches own subtrees: ADR
[0022](../docs/decisions/0022-repertoire-branch-ownership.md).

## v1 — 2026-08-06

**25 branches · 1,057 positions · 467 decisions of yours, answering 617 of theirs · 193 quiet
positions to train.** Lines run to move 5–6 for both sides.

### Read `ourDecisions` first, and read it sceptically

**467** is the honest price: positions where you must know which move you play. It was **132**
when lines stopped around move 3, and going deeper tripled it. That is the trade the depth
buys, and it is a real question rather than a detail — 467 positions is a large deck for one
person, and this file's own rule is that when the number climbs past what you can hold you
**cut branches from the manifest**, not depth, because a shallower crawl buys the same
repertoire with the trainable positions chopped off.

Two honest ways down if it is too much:

- **Drop branches.** The 1.c4 and 1.Nf3 move-order branches (`english`, `reti`) cost 60
  decisions between them and mostly transpose into lines you already know. The `d4-sidelines`
  and `d4-black` sweepers are another 100+ and cover replies you meet rarely.
- **Lower the floor for the sweepers only**, with a per-entry `minPly`. The curated branches
  stay deep; the "don't be surprised" ones do not need to.

### The other number that moved

**64 lines ran out of book**, against 1 before. The extra depth is reaching past what a
300,000-game band book supports — at move 5–6 in a sideline there are simply not 20 games to
count. Those lines are marked `out of book (N games)` in the PGN and listed in `summary.json`.
Treat a line that ends that way as *unfinished*, not as a quiet position worth training. A
bigger book is the fix; see the note on `--min-node-games` below.

| | |
|---|---|
| Deviations to prepare | **29** ranked traps, **11** of which we cannot actually punish (marked in the PGN) |
| Move glyphs | `?!` from 5 win% given up, `?` from 15, `??` from 25 — anchored to grade.ts's tiers |
| Build cost | 44 minutes, 6,090 engine searches |
| Their moves | Lichess 2026-06, 300k games, both players 1500–1900 blitz/rapid |
| Our moves | Lumbra's Gigabase OTB, 800k games at 2200–2900 |
| Engine | Stockfish, 120,000 nodes, **Threads=1** — anything else is not reproducible |
| Settings | `--trap 0.01 --min-node-games 20` (see below) |

### What it does not cover, stated rather than discovered across the board

- **1.e4 as White.** Deliberate: one first move at a time. The planned expansion.
- **Irregular White first moves** — 1.b3, 1.f4, 1.g3, 1.Nc3 have no Black branch. Rare enough at
  this band that the answer is "develop normally and transpose", which a 300k-game crawl has
  little to say about.
- **77 lines that look like traps but have under 50 games.** Listed in `summary.json` under
  `tooRareToJudge` rather than dropped — a rare line may be the vicious one, we just cannot yet
  tell it from a coin flip. A bigger book is the answer, not a lower floor.
- **One line ran out of book** before going quiet, and one node hit the evaluation cap. Both are
  in `summary.json`. That is the book being thin, not the position being unplayable.

### Two settings that are not the defaults, and why

`--trap 0.01`, not `0.05`. Measured on this band, real club traps land between **0.005 and
0.05** — the Albin Counter-Gambit scores 0.0154 and the Chigorin 0.0096, and the default flags
neither. The constant in [`repertoire.ts`](../src/domain/repertoire.ts) is unchanged: one
build's distribution is not enough evidence to move a default.

`--min-node-games 20`, not `50`. **The band book's size is the binding constraint on this
repertoire**, and it shows in the sidelines: `1.d4 f5 2.g3` has 24 games in a 300k-game book, so
at the default floor the Dutch branch was empty. Twenty is consistent with `coverByMass`, which
already refuses to *cover* a move with under 20 games. The real fix is a larger book, and the
sideline branches will deepen when there is one.

## How to read it

Each line runs until the position goes **quiet** — no hidden tactic, several playable moves,
roughly balanced — and stops with a comment saying so:

```
{quiet: 5 playable moves — judgment from here}
```

**That terminal position is the item.** The moves before it are scaffolding to get you out of
the opening with a position you can think in. This is what keeps openings inside constitution §1
(train judgment, not memory of lines), and it is why depth varies from line to line rather than
being fixed at "five moves deep".

Opponent moves carry their statistics rather than a verdict:

```
2... e5 {trap · 7% play this · they score 50% where 38% is deserved · n=5332}
```

That is a fact bundle, not a judgment: how often you will meet it, and how much free score the
band is leaking to it. You can disagree with the ranking (constitution §5, ADR 0012).

Other comments you will see, all load-bearing:

- `{covered in the "englund" line}` — another branch owns everything after this move.
- `{beyond master theory — chosen from club play}` — our move here is a reasonable choice from
  band data, not established theory. Master practice ran out.
- `{engine refutation — too rare to appear in human play}` — no move humans play here was sound,
  so this is Stockfish's answer. Normal right after an opponent falls into a trap.
- `{punishment not verified — play it out yourself}` — the crawl never confirmed we come out
  better. Deliberately distinct from silence.

## Regenerating

```bash
node scripts/repertoire/build.mjs --book out/band.json --canon-book out/otb.json \
     --nodes 120000 --trap 0.01 --min-node-games 20 --out out/repertoire
```

Then copy `out/repertoire/repertoire-white.pgn`, `repertoire-black.pgn` and `summary.json` here.
The build also writes a combined `repertoire.pgn` — useful for reading the whole thing at once,
not for importing. Validate the manifest without spending engine time with
`node scripts/repertoire/build.mjs --check`.

The books are not committed (ADR [0018](../docs/decisions/0018-games-corpus-and-annotations.md)
— we ship no corpus). Rebuild them with `buildBook.mjs`; see the generator README.
