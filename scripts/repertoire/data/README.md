# ECO opening names

`eco-a.tsv` … `eco-e.tsv` are [lichess-org/chess-openings](https://github.com/lichess-org/chess-openings),
verbatim: 3,815 named openings as `eco · name · pgn`.

**CC0 / public domain.** Upstream states it plainly: *"As a collection of facts, this data set is
in the public domain. Considerable effort was spent curating and cleaning the data. Insofar as
that qualifies for copyright, the work is released under the CC0 Public Domain Dedication."*

That is why this one is committed while the game corpora are not. ADR
[0018](../../../docs/decisions/0018-games-corpus-and-annotations.md) forbids redistributing bulk
**game** databases — the compilation right is real and unsettled there. A name table is neither
a corpus nor copyrightable prose, and it is CC0 outright, so none of that applies. It is 388 KB
and it makes the build reproducible offline, which the repertoire's numbers depend on.

Refresh with:

```bash
for f in a b c d e; do
  curl -sL "https://raw.githubusercontent.com/lichess-org/chess-openings/master/$f.tsv" \
    -o "scripts/repertoire/data/eco-$f.tsv"
done
```
