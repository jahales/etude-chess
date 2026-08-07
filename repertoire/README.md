# The repertoire

**Generated output**, committed because it is the artefact the generator exists to produce and
an hour of engine time is a poor thing to ask of a reader who just wants to import it. Nothing
here is hand-written; edit [`manifest.v1.json`](../scripts/repertoire/manifest.v1.json) and
rebuild instead.

| File | What it is |
|---|---|
| `etude-repertoire-v1-white.pgn` | The White repertoire — 14 branches, one game each, named in its `[Event]` header. |
| `etude-repertoire-v1-black.pgn` | The Black repertoire — 12 branches. |
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

## v1 — 2026-08-06, retargeted 2026-08-07

**26 branches · 830 positions · 341 decisions of yours, answering 494 of theirs · 157 quiet
positions to train.** Curated lines run to move 5–6 for both sides.

The 2026-08-07 pass was driven by **the owner's own 248 chess.com games** replayed against the
shipped PGN, rather than by anything the generator could see about itself. What that found, and
what changed:

| | before | after |
|---|---|---|
| decisions to learn | 269 | 341 |
| quiet positions to train | 132 | 157 |
| `beyond master theory` | 141 | **126** |
| `out of book` | 27 | **54** |
| opponent book | Lichess 1500–1900, 300k games | **1300–1800, 367k** |
| master book | 800k OTB games, 52k positions | **2M games, 174k positions** |

The band moved because **not one of 232 blitz opponents fell inside 1500–1900** (median 886).
1300–1800 spans the climb from there to the ~1400 chess.com / USCF target. The master book was
capped at 800k games out of an archive holding roughly ten times that — reading more of it is
what took `beyond master theory` *below* the old figure while covering far more ground. It is
also why `1.d4 d6` is now `2.Nc3 {→ Philidor Defense: Lion Variation}` instead of a club-play
guess that ended out of book two moves later.

`out of book` doubling is the honest cost, and the cause is measured: a richer master book lets
lines run two plies deeper (`deepestPly` 11 → 13), and the opponent book — only 22% larger — cannot
follow them there. **The fix is more Lichess data, not a smarter build.**

### Where to start

Ranked by how often each branch actually arises in the owner's games, which is not how the
files are ordered:

| | share of games | learn | decisions |
|---|---|---|---|
| 1 | 70% of your Black games | Caro-Kann group (5 branches) | 69 |
| 2 | 57% of your White games | Queen's Gambit group (7 branches) | 62 |
| 3 | 23% of your Black games | Slav group (4 branches) | 68 |
| 4 | 14% of your White games | Indian group (4 branches) | 31 |
| 5 | 3% of your White games | `dutch` — two decisions, essentially free | 2 |
| last | 2% | `black-irregular`, the 1.b3/1.f4/1.g3 tail | 25 |

The Caro-Kann group is the best value in the repertoire: three times the Slav group's frequency
for the same price. `black-irregular` is deliberately last — 25 decisions for one board in a
five-round tournament is a real cost, and it is safe to leave unlearned until the rest is solid.

### Which variation am I learning?

The question a repertoire has to answer, because several moves are usually
sound and the trainer accepts exactly one. `[ECO]` and `[Opening]` name what
each branch heads for, and **our move carries the variation it commits to** at
the point it commits:

```
1. d4 {→ Queen's Pawn Game} d5 2. c4 {→ Queen's Gambit} e6 3. cxd5
{→ Queen's Gambit Declined: Exchange Variation, Positional Variation} exd5
```

Only on a change, so "Queen's Gambit Declined" does not repeat down twelve
plies and bury the label that matters. Names come from
[lichess-org/chess-openings](../scripts/repertoire/data/README.md) — CC0.

Found by looking **forward** through the branch's own tree rather than naming
the position: the table indexes named *lines*, and `1.d4 d5 2.c4 e6 3.cxd5` is
unnamed at this move order even though the Exchange Variation is named at three
others. Naming the position would have said nothing at exactly the fork that
needed it.

### One position, one answer

Ownership used to be keyed on the move order, so a transposition slipped
through: `1.d4 e6 2.c4 d5` and `1.d4 d5 2.c4 e6` are one board reached two
ways, and the sidelines sweeper answered 3.Nc3 where the QGD Exchange branch
forces 3.cxd5. En Croissant keeps whichever card it walked first, so the
trainer demanded one move while showing the other as a legitimate line.

Branches now crawl owners-first — the role order — and register the positions
they decide, so a later branch that transposes in stops and points at the
owner. **27 lines** now defer that way, and no position has two answers.

### Depth follows what a branch is for

Not one number for everything. The first deep build cost **467 decisions**, and the bill made
the problem obvious: the sweepers and signposts carried 58% of it while every curated line in
the repertoire came to about a hundred between them.

| role | stops at | branches |
|---|---|---|
| `curated` | ply 10 | every line you are actually learning |
| `sweeper` | ply 8 | `d4-sidelines`, `d4-black`, `caro` — so you are not surprised |
| `signpost` | ply 6 | `english`, `reti` — the decision *is* the first move |

That took 467 decisions to 336, and collapsing the transpositions above took it to **269**. A
signpost pays for itself the moment you answer 1.c4 with 1...c6, because everything after it is
a Slav structure the curated branches already teach.

`ourDecisions` is still the number to read first. If 269 is more than you can hold, the next cut
is the same shape: demote a branch's role, do not shorten a curated line.

| | |
|---|---|
| Deviations to prepare | **19** ranked traps, **6** of which we cannot actually punish (marked in the PGN) |
| Move glyphs | 45 across the repertoire — `?!` from 5 win% given up, `?` from 15, `??` from 25, anchored to grade.ts's tiers |
| Their moves | Lichess 2026-06, 300k games, both players 1500–1900 blitz/rapid |
| Our moves | Lumbra's Gigabase OTB, 800k games at 2200–2900 |
| Engine | Stockfish, 120,000 nodes, **Threads=1** — anything else is not reproducible |
| Settings | `--trap 0.01 --min-node-games 20` (see below) |

### What it does not cover, stated rather than discovered across the board

- **1.e4 as White.** Deliberate: one first move at a time. The planned expansion — and the
  owner plays it in 17% of their White games, scoring 39% with no preparation at all, so this
  is the largest remaining hole by game count.
- **1.d4 Nc6, 1.d4 b6, and 1.Nc3 as Black.** One game each in 248, which puts them under the
  frequency floor even with the sweepers widened. 1.b3, 1.f4 and 1.g3 *are* now covered.
- **27 lines ran out of book** before going quiet, down from 64 at uniform depth — shallowing
  the sweepers and collapsing the transpositions removed most of them, which is what you would
  expect if the depth was reaching past what the book supports. They are marked `out of book (N games)` in the PGN. Treat a line
  that ends that way as **unfinished**, not as a quiet position worth training.
- **Lines that look like traps but have too few games to judge.** Listed in `summary.json` under
  `tooRareToJudge` rather than dropped — a rare line may be the vicious one, we just cannot yet
  tell it from a coin flip.

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
node scripts/repertoire/build.mjs --book out/band-1300-1800.json --canon-book out/otb-big.json \
     --nodes 120000 --trap 0.01 --min-node-games 20 --out out/repertoire
```

Verify the cached dumps before trusting a rebuild — zstd reports a torn frame as success, so a
truncated cache silently produces a smaller book that looks fine:

```bash
node scripts/repertoire/verifyCache.mjs
```

Then copy `out/repertoire/repertoire-white.pgn`, `repertoire-black.pgn` and `summary.json` here.
The build also writes a combined `repertoire.pgn` — useful for reading the whole thing at once,
not for importing. Validate the manifest without spending engine time with
`node scripts/repertoire/build.mjs --check`.

The books are not committed (ADR [0018](../docs/decisions/0018-games-corpus-and-annotations.md)
— we ship no corpus). Rebuild them with `buildBook.mjs`; see the generator README.
