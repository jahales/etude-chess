# The repertoire

**Generated output**, committed because it is the artefact the generator exists to produce and
an hour of engine time is a poor thing to ask of a reader who just wants to import it. Nothing
here is hand-written; edit [`manifest.v1.json`](../scripts/repertoire/manifest.v1.json) and
rebuild instead.

| File | What it is |
|---|---|
| `etude-repertoire-v1.pgn` | The repertoire. One game per branch, named in its `[Event]` header. Import into En Croissant → **Files**, then point the repertoire trainer at it. |
| `summary.json` | What it cost to build and what it costs to learn: theory load, the ranked trap list, and everything the build could *not* cover. |

Why these openings and not others: [docs/repertoire-v1.md](../docs/repertoire-v1.md). How the
thing works: [scripts/repertoire/README.md](../scripts/repertoire/README.md). Why it terminates
at quiet positions instead of teaching lines: ADR
[0021](../docs/decisions/0021-opening-repertoire-generator.md). Why branches own subtrees: ADR
[0022](../docs/decisions/0022-repertoire-branch-ownership.md).

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

Then copy `out/repertoire/repertoire.pgn` and `summary.json` here. Validate the manifest without
spending engine time with `node scripts/repertoire/build.mjs --check`.

The books are not committed (ADR [0018](../docs/decisions/0018-games-corpus-and-annotations.md)
— we ship no corpus). Rebuild them with `buildBook.mjs`; see the generator README.
