# Spike: a games database — what we can legally ship, and at what scale

> De-risking issue #40 (master games database with search + annotations), run 2026-07-19 on
> branch `spike/games-database`. **The blocker here is legal, not technical** — the corpus
> question decides the product shape, so it was settled first. Outcome: **GO, with one honest
> reframing** (below). Mirrors the [maia-onnx](maia-onnx.md) spike structure.

## The question
Can we ship a searchable database of **master games**, with **annotations**, in a fully
client-side app we redistribute?

## ⚠️ Outcome: the question changed — and that's the finding
Every hard problem below is a **redistribution** problem. Once the app lets users **attach
their own database** (owner direction, 2026-07-19), they vanish: a user may lawfully use TWIC
(*"free for personal use"*), Lumbra's Gigabase, or a ChessBase export — uses permitted to
*them*, simply not ours to pass on. **We ship only a small curated pack we own; users bring
the rest.** Annotations in a user's own file are theirs to read, so we preserve and display
them rather than stripping them. See ADR
[0018](../decisions/0018-games-corpus-and-annotations.md). The research below still governs
**anything we ship**, and the source table is now a *recommendation list for users*.

## Verdict (as originally framed — for redistribution)
- **Game scores: yes, freely.** Moves are facts.
- **Bulk OTB *master* games: not from the usual compilations** (Caissabase/TWIC/Millionbase
  have no usable licence). But **Lichess broadcasts are CC BY-SA 4.0** — real OTB tournament
  play, attributable and redistributable. Bulk strong *online* play is **CC0** (Lichess Elite).
- **Annotations: a small, genuinely free corpus exists** — better than expected.
  **Wikibooks `Chess/Famous Games` is CC BY-SA 4.0**, already algebraic, and covers *modern*
  games. Public-domain books (pre-1931) add more via a conversion project. Everything else
  (ChessBase, Informant, books in copyright, Edward Winter, lichess **studies**) is off-limits.
- **Our engine-derived annotations remain the scalable answer** and fit ADR 0012 exactly.
- **Scale is not the constraint.** 10k–100k games fits comfortably in a static-asset budget.

## 1. Copyright — the decisive part

**Move scores are facts, not copyrightable.** Facts are discovered, not authored
(*Feist v. Rural Telephone*, 499 U.S. 340 (1991), which also rejected "sweat of the brow").
Chess writing puts it plainly: *"there is no copyright infringement in copying the moves of a
game (this does not apply to commentary or analysis). Raw games, scores, tables, and lists of
openings are not protected, whereas annotations are IP protected."*
([Chess.com discussion](https://www.chess.com/forum/view/general/what-stops-people-from-freely-distributing-existing-chess-game-databases))

**Annotations are protected.** Prose notes are ordinary literary expression; analytical
variations reflect authorial selection. ChessBase / Informant / book annotations are
off-limits without a licence. Stripping the prose and keeping only the `!`/`?` symbol layer is
**not** a safe workaround — a complete set of evaluations across a work is itself selection
and judgement.

**Compilations carry their own rights — this is the real constraint.** A curated collection
can be protected for its *selection and arrangement* even when the underlying facts are free.
In the EU there is additionally a **sui generis database right** (Directive 96/9/EC, 15-year
term, renewed by substantial new investment) for substantial investment in **obtaining**
data. Note the sting: the *BHB / Fixtures Marketing* line (C-203/02; C-46/02, C-338/02,
C-444/02, 2004) held that investment in **creating** data doesn't count but investment in
**obtaining** pre-existing data does — and a PGN compiler gathering already-played games is
squarely *obtaining*. **So a maintained chess database is close to the paradigm case the
right protects.**

**It has been tested.** In 2016 Agon/World Chess claimed exclusivity over World Championship
moves. In the **SDNY** (*World Chess US, Inc. v. Chessgames Services LLC*, No. 1:16-cv-08629,
Marrero J., 11 Nov 2016) the **preliminary injunction was denied** — and tellingly they pled
*"hot news" misappropriation and breach of contract, **not copyright***. The controlling
authority is *NBA v. Motorola*, 105 F.3d 841 (2d Cir. 1997): only the **broadcast** is
protectable, never the underlying game facts. A parallel Moscow claim also failed (Oct 2016).
Germany's [Schachbund](https://www.schachbund.de/recht-news/urheberrecht-an-schachpartien.html)
states flatly that copyright in chess games "must be rejected under German law"; the
[Swiss IPI](https://www.ige.ch/en/blog/blog-article/schach-und-urheberrecht-eine-verlorene-partie)
agrees; and CJEU *Premier League* (C-403/08) holds sporting events aren't "works".

⚠️ **One jurisdictional landmine — France.** Paris, 11 June 2020: World Chess won €50k against
ArtdesEchecs.fr — but under the **sports-organiser's right** (Art. L.333-1 *Code du sport*),
*not* copyright, and as an **uncontested default judgment**. It reaches *live transmission of
an ongoing event*, not historical game databases. Irrelevant to us; noted so nobody
rediscovers it in a panic.

⚠️ **The real live risk is the EU database right, and it cuts against chess.** The
*BHB*/*Fixtures* limitation says investment in **creating** data doesn't count — but chess
games are **obtained**, not created by the compiler (who then verifies, dedupes, normalises
names). **A curated chess database is a *stronger* sui-generis candidate than BHB's fixtures
were**, and Art. 10(3) lets substantial new investment restart the 15-year term indefinitely.
There is **no chess-specific ruling**. Treat this as unsettled and real.

> **Practical rules adopted:**
> 1. Individual game scores may be used freely; **never redistribute someone else's compiled
>    database as such** (US compilation copyright is thin — comprehensiveness is the antithesis
>    of selection — but the EU database right doesn't care about originality at all).
> 2. **Prefer CC0**, which expressly waives *database rights as well as* copyright and so
>    sidesteps the sui-generis question entirely. This is the main reason to build on Lichess.
> 3. **Strip `{...}` comments and NAGs on ingest.** Inherited liability lives in the annotation
>    layer riding along inside third-party PGN, not in the moves.

## 2. Corpora — what's actually shippable

| Source | Contents | Licence | Usable? |
|---|---|---|---|
| **[Lichess open database](https://database.lichess.org/)** | 7.9B **online** rated games, monthly PGN (`.zst`); also puzzles + evals | **CC0 1.0** — *"Use them for research, commercial purpose, publication, anything you like. You can download, modify and redistribute them, without asking for permission."* | ✅ **Cleanest option.** Online play, not OTB |
| **[Lichess Elite](https://database.nikonoel.fr/)** | ~26.3M games filtered to 2400+ vs 2200+ (later 2500+/2300+), no bullet | Derived from the CC0 dump | ✅ **Best bulk option** — strong players, still online |
| **Lichess broadcasts** | Real **OTB tournament** games relayed by Lichess | **CC BY-SA 4.0** (attribution + share-alike) | ✅ **The clean OTB master source** |
| Lichess **"masters"** explorer set | ~2M **OTB** games, 2200+ FIDE, 1952–2019 | **Not** part of the CC0 dump; separately contributed, provenance unclear | ❌ Not downloadable / not cleanly licensed |
| **[Lumbra's Gigabase](https://lumbrasgigabase.com/en/)** | **10.3M+ OTB** games + 7.2M online; Scid + PGN; maintained monthly (2026-07-08) | **CC BY-NC-SA 4.0** — explicit and versioned | ✅ **The only cleanly-licensed OTB corpus.** NC is fine for a personal project |
| Caissabase | ~5.5M OTB, CC BY-NC | **DEAD** — domain lapsed, now redirects to a crypto-casino affiliate | ❌ don't link |
| KingBase / Millionbase | ~2.2M / ~3.45M OTB | **DEAD** (parked domain / host HTTP 526); no licence ever stated | ❌ |
| **TWIC** | 4M+ games, 1,653 issues since 1994 | ***"free for personal use only. All rights are reserved."*** | ❌ — and it's upstream of nearly every free compilation (see caveat) |
| PGN Mentor / FICS / 365chess / Chess.com API | Large collections | **Silent on data rights** — silence is not a grant | ❌ |
| chessgames.com | Large OTB | Bulk export paywalled; `robots.txt` spidertrap; blocks GPTBot | ❌ |

**The honest conclusion:** there is no permissively-licensed bulk **OTB master** corpus. The
clean paths are (a) **CC0 Lichess-derived strong-player games** at scale, and (b) a
**hand-curated set of historical classics**, which is legitimate because we select them
ourselves and the scores are facts.

## 3. Annotations — small but real, ranked by effort-to-value

There is no *large* machine-readable free annotated corpus, but there are clean sources:

1. **[Wikibooks `Chess/Famous Games`](https://en.wikibooks.org/wiki/Chess/Famous_Games) —
   CC BY-SA 4.0. Use this first.** ~12 games with commentary on the critical moves (Immortal,
   Evergreen, Opera, Alekhine–Nimzowitsch 1930, Byrne–Fischer 1956, Deep Blue–Kasparov).
   **Already algebraic — zero conversion cost**, and notably it's one of the only sources of
   freely-licensed annotation on *modern* games (the moves are facts regardless of year; the
   commentary is what's licensed). Requires attribution + share-alike on that content.
2. **Wikisource public-domain books** — proofread and *scan-backed*, structurally marked up in
   wikitext (much better than Gutenberg, which flattens the two-column move layout into
   whitespace-dependent text):
   [Chess Fundamentals](https://en.wikisource.org/wiki/Chess_Fundamentals) (Capablanca 1921,
   14 annotated games), [My System](https://en.wikisource.org/wiki/My_System) (Nimzowitsch,
   1930 Hereford translation — **newly public domain in 2026**), Lasker's Manual (1925).
   Cost: a **descriptive→algebraic converter** (`1 P - K 4`, tokens space-split) plus
   re-attaching prose to plies. Mitigating factor: the conversion is **self-validating** —
   every converted move must be legal in the position, so errors surface immediately.
3. **Our own engine-derived annotations** — machine output isn't copyrightable, scales to any
   corpus we ship, and is exactly the ADR-0012 posture (compute facts; the renderer never
   invents them). This stays the backbone.

**Explicitly off-limits, including one common misconception:**
- ⚠️ **Lichess *studies* are NOT CC0.** The CC0 dedication covers only the bulk **game**
  database; per the [Lichess ToS](https://lichess.org/terms-of-service) study authors retain
  copyright. The API can export a study with comments, but *export capability is not
  redistribution permission*, and there is no bulk studies corpus. Fine for a user importing
  **their own** studies; not for shipped content.
- **archive.org presence is not evidence of public domain** — in-copyright uploads (Silman,
  Dvoretsky, Fischer) sit alongside PD scans. Verify publication year per item.
- Edward Winter / chesshistory.com: all rights reserved, and he is [explicitly hostile to
  reuse](https://chesshistory.com/winter/extra/copying.html). Off-limits.
- Unlicensed GitHub PGN repos are all-rights-reserved by default, and their annotations are
  usually transcribed from copyrighted books.

**Also useful:** [`lichess-org/chess-openings`](https://github.com/lichess-org/chess-openings)
is **CC0** — ECO codes + opening names + PGN/EPD. A naming dataset, not teaching content, but
it's the clean way to label openings at scale (our `openings.ts` is currently hand-rolled).

*(US public-domain cutoff as of 2026: published before **1931** — 95-year term. Source:
[Duke CSPD](https://web.law.duke.edu/cspd/publicdomainday/2026/).)*

## 4. Scale — not the binding constraint
- Full PGN ≈ **600 B–1 KB/game**; movetext alone ≈ 300–400 B; **gzip ≈ 4–5×** (PGN is very
  redundant).
- A compact binary (Huffman/index-into-legal-moves move coding + interned player/event
  strings) reaches **~150 B/game** → **10 MB ≈ 65k games**, 20 MB ≈ 130k. For reference we
  already ship a 3.5 MB Maia net per level.
- **Search:** for structured fields (player/event/ECO/year/result/rating) **Dexie compound
  indexes are sufficient** at 10k–100k rows; no full-text engine needed. Add **MiniSearch**
  (TS-native, *serializable prebuilt index*) only if fuzzy player-name search is wanted.
- **Position search** (games reaching a position): Zobrist keys — the **Polyglot** standard's
  781 keys (768 piece-square + 4 castling + 8 ep-file + 1 stm) is the portable choice. Cost is
  ~80 positions/game: 10k games ≈ 800k entries ≈ 10 MB; 100k games ≈ 8M entries ≈ ~96 MB.
  Mitigations used by real explorers: **truncate the key** (verify candidates by replaying, so
  false positives are filtered not fatal) and **index openings only** (first 20–30 plies).
  **Feasible at 10k–100k; not at millions without a server.** Deferred past v1.
- If we ever exceed the bundle budget: **range-request-served SQLite** (`sql.js-httpvfs`) or
  DuckDB-WASM over Parquet gives indexed queries against a large static file with no backend —
  fits the constitution's no-backend rule. Noted, not needed yet.

## What this means for the product
"Master games database" becomes, honestly stated: **a searchable database of strong-player
games (CC0) plus a curated collection of historical classics, annotated by our engine and our
own writing.** That is a real, useful feature — it just isn't a repackaged ChessBase, and we
shouldn't imply it is (constitution §12: don't claim what we haven't got).
