# 0018 — Games database: CC0/CC-BY corpora, and annotations we compute or license

**Status:** Accepted · 2026-07-19
**Applies to:** the games database (#40) and all future content sourcing.
**Evidence:** [../spikes/games-corpus.md](../spikes/games-corpus.md).

## Context
Issue #40 asks for a master-games database "with annotations, if possible". Before writing
code we settled what may lawfully be shipped, because it determines the product shape rather
than merely the implementation. Two findings dominate:

1. **Move scores are facts** (*Feist*; *NBA v. Motorola*; German/Swiss federation and IP-office
   positions; the 2016 Agon injunction denied in the SDNY on a non-copyright theory).
   **Annotations are copyrighted prose.**
2. **Compilations carry rights of their own** — thin in the US, but the **EU sui generis
   database right** applies regardless of originality, and chess *favours* the compiler:
   games are **obtained**, not created, which is exactly what *BHB*/*Fixtures* said qualifies.

## Decision
1. **Source only from corpora with a written licence.** Only three qualify:
   - **CC0 — preferred**: the [Lichess open database](https://database.lichess.org/) (7.9B
     games, 2.51 TB, `.pgn.zst`) and its derivative **[Lichess Elite](https://database.nikonoel.fr/)**
     (2400+/2200+, later 2500+/2300+; a 582 MB historical `.7z` + monthly files). CC0
     expressly waives *database rights as well as* copyright — precisely why it defuses the
     sui-generis risk. **Online play only**; there is **no masters export** (the explorer's
     ~2M-game OTB set was a third-party donation, is not downloadable, and has no licence).
   - **CC BY-NC-SA 4.0 — the only cleanly-licensed OTB corpus**:
     **[Lumbra's Gigabase](https://lumbrasgigabase.com/en/)** — 10.3M+ OTB games, actively
     maintained (monthly; latest 2026-07-08), Scid + PGN. **NC is compatible with this
     project** (personal, non-commercial); revisit if that ever changes. SA attaches to
     redistributed derivatives.
   - **CC BY-SA 4.0 / public domain — annotations**: **Wikibooks `Chess/Famous Games`** (~12
     annotated games, already algebraic, includes modern ones) and Wikisource's proofread,
     scan-backed *Chess Fundamentals* (1921) / *My System* (1930, PD since 2026) behind a
     descriptive→algebraic converter.
   - ⚠️ **Lichess "Broadcasts"** (OTB relays) appear as a tab on the CC0 page, but we have
     **conflicting reads** on whether they are CC0 or CC BY-SA 4.0. **Verify before shipping
     any broadcast game**; assume CC BY-SA (attribute) until confirmed.
   - **Never**: **TWIC** (*"free for personal use only. All rights are reserved."*),
     **PGN Mentor** / **FICS** / **365chess** / the **Chess.com API** (all silent on data
     rights — silence is not a grant), **chessgames.com** (bulk export paywalled, `robots.txt`
     spidertrap, blocks GPTBot), lichess **studies** (authors retain copyright; the CC0 covers
     only the *game* dumps), or chesshistory.com.
   - **Dead — do not chase or link**: **Caissabase** (domain lapsed and now redirects to a
     crypto-casino affiliate), **KingBase** (parked domain), **Millionbase**/rebel13 (host
     down, HTTP 526).
2. **Strip `{...}` comments and NAGs from every ingested PGN.** Inherited liability lives in
   the annotation layer, not the moves. Ingest is moves + factual headers only.
3. **Our annotations are computed or our own.** Engine-derived facts (uncopyrightable machine
   output) are the backbone — consistent with ADR
   [0012](0012-llm-grounded-explainer.md): we compute facts and render them, never reproduce
   someone's prose. Hand-written notes are our own; third-party prose is licensed or absent.
4. **Name the thing honestly.** With bulk OTB master compilations unavailable, this is *"a
   searchable database of strong-player and broadcast games, plus curated classics, annotated
   by the engine and by us."* We do not imply a repackaged ChessBase (constitution §12).
5. **Delivery stays client-side** (ADR 0009): a bounded static asset + Dexie indexes. Position
   search (Polyglot/Zobrist keys) is **deferred**; feasible at 10k–100k games with truncated
   keys and opening-only indexing, but not needed for v1.

## The TWIC provenance caveat (recorded, not buried)
**TWIC sits upstream of essentially every "free" OTB compilation** — Caissabase, Millionbase's
later updates, chessgames.com, and Lumbra's Gigabase all merge TWIC issues — while TWIC itself
reserves all rights ("free for personal use only"). So the CC licences those downstream
compilations apply **rest on the moves-are-facts argument, not on permission from the
originator.** We rely on the same argument, which is strong for the *moves* (§1) and is exactly
why decision 2 (strip comments/NAGs) matters: it removes the only layer where a licence could
actually be needed. Anyone revisiting OTB sourcing should know this is the load-bearing
assumption, not paperwork.

## Consequences
- **Attribution obligations become real.** CC BY-NC-SA (Lumbra) and CC BY-SA (Wikibooks,
  probably broadcasts) require attribution and share-alike on *that content*; we'll carry a
  `NOTICE` + a per-game source/licence field, as we already do for the GPL engines. CC0
  material needs none.
- **NC clauses bind the project's licence posture.** Lumbra is NC; if etude-chess ever became
  commercial, that corpus would have to be dropped or licensed (their stated route:
  business@lumbrasgigabase.com). Recorded so the choice isn't discovered late.
- **Provenance is per-game data, not a footnote.** Every stored game records its source and
  licence so obligations survive later re-use.
- Corpus size is not the constraint (~150 B/game compact → 10 MB ≈ 65k games); **licensing
  is** — which is why this ADR exists at all.
- Guess-the-move gains a real corpus; the curated v0.3.0 pack remains the *teaching* set.
- The descriptive→algebraic converter is optional future work, valuable mainly because it
  unlocks *My System* — self-validating, since every converted move must be legal.

## Alternatives rejected
- **Ship a big OTB compilation anyway** (Caissabase/TWIC): no usable licence, and squarely in
  the EU database right's path. Rejected.
- **Scrape chessgames.com/365chess**: express terms prohibit it; contract binds where IP
  wouldn't. Rejected.
- **Harvest lichess studies for annotations**: the format is perfect and the licence is not —
  authors retain copyright and there is no bulk corpus. Rejected (individual authors may still
  be asked; a user importing *their own* studies is fine).
- **Strip prose from Informant/ChessBase and keep only `!`/`?` symbols**: individual symbols
  are likely unprotectable, but a *complete evaluation layer* is selection and judgment. Not a
  safe workaround. Rejected.
