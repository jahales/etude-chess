# 0018 — Games database: bring-your-own corpora; we ship only what we own

**Status:** Accepted · 2026-07-19
**Applies to:** the games database (#40) and all future content sourcing.
**Evidence:** [../spikes/games-corpus.md](../spikes/games-corpus.md).

## Context
Issue #40 asks for a master-games database "with annotations, if possible". Research settled
the law first, because it determines the product shape (see the spike). Two findings dominate:

1. **Move scores are facts** (*Feist*; *NBA v. Motorola*; the 2016 Agon injunction denied in
   the SDNY on a non-copyright theory; German/Swiss federation and IP-office positions).
   **Annotations are copyrighted prose.**
2. **Compilations carry rights of their own.** US compilation copyright is thin, but the **EU
   sui generis database right** applies regardless of originality — and chess *favours* the
   compiler, because games are **obtained**, not created (exactly what *BHB*/*Fixtures* said
   qualifies). No chess-specific ruling exists; the risk is real and unsettled.

Every one of those problems is a **redistribution** problem. The owner's direction — *let users
attach their own databases; the project stays open and never goes commercial; prefer the
strongest standard-time-control games; annotations are a bonus* — dissolves it.

## Decision

1. **We do not distribute bulk corpora. Users attach their own.**
   The app reads **user-supplied PGN** (file picker / drag-and-drop), parses it locally, and
   indexes it in IndexedDB. Nothing leaves the device and nothing is redistributed, so the
   compilation/database-right question **never arises**. This also unlocks the *best* data:
   a user may lawfully use TWIC (*"free for personal use"*), Lumbra's Gigabase, a ChessBase
   export, or their own collection — uses that are permitted to them and simply not ours to
   pass on.
2. **We ship only a small curated pack we own** — our own selection of public-domain classics
   with **our own annotations** (the v0.3.0 pack). That stays the default out-of-box content.
3. **Annotations are optional and preserved, not stripped.**
   - In **user-attached** files: keep `{...}` comments, NAGs and variations, and display them.
     It's the user's own copy; rendering it locally is personal use. (This reverses the
     earlier "strip on ingest" rule, which existed only to make *redistribution* safe.)
   - In **anything we ship**: our own prose, or engine-computed facts — never third-party
     text. Engine output is uncopyrightable machine output and fits ADR
     [0012](0012-llm-grounded-explainer.md) exactly: we compute facts and render them.
4. **Prefer strong, standard time controls.** Ingest filters default to **OTB / classical**
   and exclude blitz, rapid and bullet, with a minimum-rating filter. Consequence worth
   stating: this argues *against* Lichess Elite as a primary source (it is online blitz/rapid
   play), and *for* OTB collections the user supplies. Where a PGN lacks `TimeControl`/`Event`
   detail we keep the game but mark the control unknown rather than guessing.
5. **Recommend sources in-app rather than bundling them.** A short, honest pointer list
   (Lumbra's Gigabase — CC BY-NC-SA 4.0, actively maintained, the only cleanly-licensed OTB
   corpus; TWIC for personal use; Lichess CC0 for online play) with the caveat that some are
   dead ends (Caissabase's domain now redirects to a crypto-casino affiliate; KingBase and
   Millionbase are down). **NC licences are unproblematic** — the project is permanently open
   and non-commercial.
6. **Delivery is client-side** (ADR 0009), and the two search jobs get **different tools**:
   - **Metadata / name search is a scan** → **MiniSearch** (5.7 kB gzip, stable serialization
     so the index can be built once and reloaded; pass *identical* options to `loadJSON`).
     Not lunr (unmaintained; >15 s builds at 800k docs). Structured filters (ECO/year/result/
     Elo/time-control) use **Dexie compound indexes** — a compound index cannot be
     multiEntry, and multiEntry queries need `.distinct()`.
   - **Position search is a point lookup** → **defer it, then prefer brute force over an
     index.** At ~2 bytes/move, 100k games of movetext is **~16 MB — smaller than the ~92 MB
     Zobrist index it would replace** — and replays in a Web Worker over typed arrays. This is
     ChessBase's own conclusion (they abandoned indexing for scanning). Escape hatch if it
     outgrows that: a Zobrist index over range-request SQLite (~1 KB per lookup at any size).
   - If/when we hash: **64-bit Polyglot keys** (the 781-key table) are ample — 1M games ≈ 80M
     positions gives ~2.7e-4 collision probability. Lichess uses 96-bit only because it is at
     390M+ positions with an adversarial threat model. **Cap depth ~40 plies** (Lichess caps
     at 50) and use paired `Uint32Array`, **not `BigInt`**, in the hot loop.
7. **Name the feature honestly.** It is *"attach your own game database, plus a curated
   classics pack"* — not a bundled ChessBase (constitution §12).

## Consequences
- **The licensing risk largely disappears**, because we stopped redistributing. What remains
  is small and ours: the curated pack (our selection, our prose) and engine-computed facts.
- **Import UX becomes the hard part**, which is a much better problem to have: parsing large
  PGN files without freezing the tab (stream + parse in a Web Worker, chunked `bulkPut`),
  progress reporting, dedup, and clear errors on malformed games.
- **Two platform hazards to design around.** Dexie bulk import runs ~3k rec/s, so **10k–100k
  games is the comfortable ceiling** per attached database — chunk imports and show progress.
  And **Safari evicts script-writable storage after ~7 days without interaction** unless
  installed as a PWA, so an imported corpus must be **re-importable** and never the only copy
  of anything the user cares about.
- Guess-the-move gains an effectively unlimited corpus (whatever the user attaches) while the
  curated pack remains the teaching set.
- Per-game **provenance** (source file, licence if known, time control) is still recorded — now
  for the user's own bookkeeping and filtering rather than for our compliance.

## Alternatives rejected
- **Bundle a big corpus** (Lumbra/Caissabase/TWIC-derived): unnecessary once users attach
  their own, and it's the only path that carries EU database-right exposure. Rejected.
- **Ship Lichess Elite as the default corpus**: CC0 and easy, but it is **online blitz/rapid**
  play — the wrong material for a trainer aimed at standard-time-control judgment. Rejected as
  a default; still a fine thing for a user to attach.
- **Strip annotations from user-attached files**: pointless — stripping only ever protected
  *redistribution*, which we no longer do, and it would throw away the annotations the owner
  explicitly wants shown when present. Rejected.
- **Scrape chessgames.com / 365chess**: express terms and anti-bot measures; contract binds
  where IP would not. Rejected regardless of the BYO model.
