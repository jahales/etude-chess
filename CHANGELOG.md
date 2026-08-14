# Changelog

All notable changes to etude-chess. Format follows [Keep a Changelog](https://keepachangelog.com);
this project uses [Semantic Versioning](https://semver.org). Updated as part of each release
(see [RELEASING.md](RELEASING.md)).

## [Unreleased]

### Added
- **Your blunder rate per game, in the library (#65).** The project's leading indicator is now
  instrumented. [development-focus.md](docs/development-focus.md) §Measurement is blunt about
  why: rated game rating is the only real metric and it moves in months, puzzle rating moves in
  weeks and lies, and the earliest thing we can measure honestly is how often you hand over a
  game. It is derived from the whole-game analysis that already scores every position (#68), so
  nothing new is captured and nothing is recomputed.

  What took the work was the framing, and it is the feature (ADR
  [0027](docs/decisions/0027-blunder-rate-as-the-leading-indicator.md), constitution §9/§12).
  **A game only counts once a completed analysis has measured every move you played** — the
  #74 failure again otherwise, since the coach grades your moves in order and stops when the
  game does, so a partial pass is a mean over your opening moves wearing the label of a whole
  game. It reads well and it is wrong in a direction you can't see. Games that don't qualify are
  named as uncounted rather than assumed clean, and each row shows its own blunder count so the
  total is checkable against the games it came from. A blunder is exactly the move the move list
  marks `??`, by delegation rather than by a matching constant, so the two can't drift.

  The sample travels with the number — games, moves, and what was left out — and below ten games
  it says outright that it's too thin to read anything into, because a few hundred games total is
  the sample this project actually has. Deliberately **no trend line, no goal, no progress bar**:
  we have not measured that this number moving means anything about your chess, and drawing it as
  something to fill in would claim exactly what §12 forbids. Over no analysed games it reports no
  rate at all, rather than a 0.00 that reads as a perfect record.
### Tooling (off-app)

Nothing here ships in the browser bundle — it is the offline repertoire pipeline under
`scripts/repertoire/`. Closes the second half of #115; the first half (`studyOrder.mjs`
defaulting to a superseded book) shipped in #117.

- **`crawl.mjs` rejects a flag it does not know, instead of running for hours without it.**
  It had its own argument parser that took anything, so `--nodez 4000000` crawled at the
  default node budget and wrote a summary indistinguishable from the one you asked for —
  while `build.mjs`, the same pipeline entered a different way, threw on the identical typo.
  There is one parser now, in `scripts/repertoire/args.mjs`, and one answer. Every script that
  had been importing it from `build.mjs` still gets the same function; `crawl.mjs` could not,
  because `build.mjs` imports the crawler and reading a flag would have closed a module cycle
  that killed `node crawl.mjs` before it parsed anything.
- **A numeric flag with its value dropped is an error, not a 1.** `--trap` on its own became
  `Number(true)` = 1 — a trap threshold 100× the intended 0.01, which finds nothing and looks
  exactly like a clean run. Every numeric flag `crawl.mjs` reads now goes through the same
  `numberFlag` `build.mjs` has had since the equivalent build ran an afternoon at a threshold
  of 1, and they are all read before a book is opened or an engine started. `--trap 0` still
  means 0.
- **A flag you did not pass no longer overrides its own default.** `crawl()` merges with
  `{ ...DEFAULTS, ...config }`, and a spread overwrites with an explicit `undefined` rather
  than skipping it — so the crawler's CLI, which passed every option unconditionally, ran a
  plain `crawl.mjs --color white --out x` with no depth cap, no floor, no `--min-node-games`
  and no trap threshold. An unbounded crawl that terminated nothing and found nothing,
  reported as a successful one.
- **`--help` describes the code again, on both scripts.** `--tactic-gap` was parsed by
  `crawl.mjs` and `build.mjs` and documented by neither; `build.mjs` still advertised
  `--min-ply 10` with −2/−4 role offsets three ADRs after the base moved to 16 and the offsets
  to −8/−10; both called the evaluation index "median depth 50" where it is 34–50; and
  `buildBook.mjs`'s example was a band and a game count that never shipped. Every number in
  both help texts is now interpolated from the constant it describes, and a test asserts each
  script's `--help` and its list of known flags name exactly the same set — in both
  directions, since a flag documented but unparsed turns a correct invocation into a hard
  error.

## [0.3.0] — 2026-08-14

**Your own games became something you can go back to.** This was scoped as a hardening cut —
no new mode, just make what already shipped trustworthy: numbers that agree with the analysis
printed beside them, storage that survives, long games that stay navigable, failures that say
so. In practice it also shipped a game library, replay and whole-game analysis, which is a
third thing to do in the app and the reason the own-game review loop now closes *here* rather
than in the `npm run review` CLI.
Milestone: 12 issues — #39, #46, #47, #67, #68, #74, #77, #78, #79, #80, #81, #82.

### Added
- **Saved games ask to stay saved (#78).** The app now requests persistent storage the first
  time a game is saved, and the library states plainly whether it was granted. Browsers may
  clear script-written storage when short of space, and Safari does so after about a week
  without a visit — so a library that looked permanent could quietly empty.
- **Delete a game, and see what storage is used (#81).** Each row has a delete button with a
  confirmation, since a game's coach data and analysis can't be recovered.
- **Move annotations and a "Worth studying" list (#67).** Once a game is analysed, every move
  carries `?!`, `?` or `??` where it gave one up, and your worst moves are listed — biggest
  first — as buttons that jump straight to the position. Deliberately only those three glyphs:
  `!!` and `!?` are human judgments no engine number implies, and `!` needs a multi-line search
  the coverage pass doesn't do, so none of them are guessed at.
- **Analyse a whole game in one pass (#68).** One button scores every position of a stored
  game, so the move list shows where the game actually turned — not just the moves the coach
  happened to grade while you played. It runs a position at a time and you can keep stepping
  through the game while it fills in, or stop it. The result is saved, so re-opening the game
  is instant and the work is done once.
- **Engine analysis while reviewing your own game.** The replay screen now has an eval bar and
  an "Analyse this position" button with the engine's top lines. The coach only ever graded
  *your* moves, so before this every other position in your own game was unexplained.
- **Game library + replay (#39).** Every finished game is saved and browsable, and you can
  walk back through any of them: click a move or use the arrow keys, with the coach's verdict
  for each of your moves and the evaluation after every move. Replay reads only what was
  stored, so it never re-runs the engine. **"Worth another look" is now navigation** — click a
  flagged mistake in the post-game review and it opens the game at that move, which is the
  loop v0.3 exists to close.
- **A friendlier front door (#47).** Home is now a chooser: one card per mode, each with a
  one-line pitch and a live stat from your own history (last game's accuracy, games played,
  decisions committed). Picking a card opens a focused setup screen with a way back, instead
  of every option living on one long page. Before you've played anything the stats stay
  blank rather than showing zeroes.
- **Finished games remember what the coach knew (#46).** A stored game now carries its
  per-move coach verdicts and per-ply evaluations, so replaying one reads them back instead
  of re-analysing every position. Games saved by v0.2.0 still load — the new fields are
  optional and absent means "not recorded", never an error.

### Changed
- The analysis-settings gear now appears only on the study screens it actually configures.
- Home reads its stats from a count plus a short scan rather than loading every stored game.
- Home gained a third card, **Your games**, once there was a library for it to open.

### Fixed
- **A finished analysis could be silently undone (#82).** The play session and the analysis
  pass each wrote the whole game record from their own snapshot, so each reverted the other's
  fields — finish an analysis, let a late grade land, and the game offered to analyse itself
  again. Writes now merge, and the analysis writes only its own fields.
- **Move glyphs no longer contradict the coach.** Before a game is analysed, the stored
  evaluations are recorded at two different engine budgets, so comparing them invented swings
  out of nothing — a move the coach called good could sit beside a `?!`. Glyphs now wait for
  the whole-game pass, which scores every position the same way. Scores still show either way.
- **Accuracy agrees with itself across screens.** Home, the library and the post-game review
  each derived it differently; the review could show a high figure directly above a mistake it
  hadn't counted. All three now share one calculation and say what it covers.
- **Turning the evaluation off now also hides it on the coach card**, where it was still
  printed.
- **A game that can't be fully replayed can now finish an analysis** instead of stopping short
  and starting over every time.
- **The eval bar reads the start position** rather than sitting blank at the first move.
- **The move list follows the cursor in a long game (#79).** Stepping through a 40-move game
  scrolled the selected move out of sight — a cursor you can't see is a transport that doesn't
  work. It now stays in view.
- **Accuracy no longer overstates itself (#74).** The figure was a mean over the moves the
  coach *finished grading before the game ended* — so resigning left it computed from your
  early, good moves, and a game could show "99.18% accuracy" directly above a move flagged as
  a 16% mistake. It is now recomputed from a completed whole-game analysis where one exists,
  and where it doesn't, it says what it covers ("over 3 of 21 moves") instead of implying it
  covers everything.
- **The coach called normal captures blunders.** "It leaves your pawn on d5 hanging" fired
  mid-exchange, because the hanging check read the position statically and never counted what
  the move had just won — so `1.e4 d5 2.exd5` and the Exchange Ruy `4.Bxc6` were both flagged,
  the second being main-line theory. A capture is now netted against the recapture that
  answers it: even trades no longer flag, and a genuinely bad one reports its true cost (take
  a knight with a rook and lose the rook: 2 points, not 5). Pieces you left hanging while
  doing something else are unaffected.
- **Engine lines were shown from the side-to-move's perspective**, so with Black to move they
  carried the opposite sign to the eval bar and score chip beside them (e.g. `+1.31` against
  `−1.31` for the same position). All scores are now White's perspective, as everywhere else.
- Clicking a flagged mistake that could not be loaded did nothing at all; it now says so.
- **A finished game could be saved twice**, appearing twice in the library. Saving a game is
  now one transaction; before, the two writes a finished game triggers could both decide no
  record existed and each insert one.
- A tier badge showed white-on-white when its tier class sat on the badge itself rather than
  on a parent element.

### Engineering
- **CI now runs the whole e2e suite, and fails rather than skips (#77).** Four spec files need
  the Maia nets, which are too large to commit and so `test.skip` when absent — and in CI they
  were always absent. Merges were gated on a green check that had never run those four, since
  a skipped spec and a passing one are the same check mark. CI now caches and fetches the nets
  and runs with `REQUIRE_MAIA_NETS=1`, which turns "nets missing → skip" into "nets missing →
  fail the run", loudly and before any test. Locally nothing changes: run
  `node scripts/setup-maia.mjs` once, or accept the skips.
- **The failure paths are now exercised, not just handled (#80).** They were written and never
  run, which is not the same as knowing they work. A stored game whose moves stop replaying
  partway now has a test that it shows what it could reconstruct and says how much ("2 of 4
  moves") instead of vanishing or claiming to be whole; a Stockfish worker that never loads
  has one that the buttons needing it are hidden rather than dead, in replay and in guess
  mode both; and storage that opens and *then* fails — quota exceeded, a blocked origin —
  has five, because `db.ts` is best-effort by contract and only its "no IndexedDB at all"
  branch had ever been tested.

### Tooling (off-app)

None of this ships in the browser bundle. It is the offline repertoire pipeline under
`scripts/repertoire/`, run from the command line, and its output is committed PGNs — no UI,
no bytes in the app. It was merged to `main` alongside the v0.3.0 work (PRs #108–#113,
closing #106 and #102) and is recorded here because it was missing from this file entirely.

- **Every prescribed move is now gated on a local index of Lichess's evaluation dump** —
  401,283,893 positions at median depth 34–50 — instead of on the crawl's own 120,000-node
  search (ADR [0024](docs/decisions/0024-gate-on-a-local-evaluation-index.md)). The index
  covers 97.4% of the shipped repertoire (2,239 of 2,298 decisions, measured 2026-08-14);
  where a position is absent or shallower than depth 25 the
  engine still decides. Both halves of the comparison always come from the same source, since
  a depth-50 best against a depth-15 candidate manufactures swings out of depth disagreement
  rather than measuring anything.
- **The audit of the shipped v1 repertoire cleared it.** Re-grading all 585 prescribed moves
  found **6 conceding more than the 5 win% gate, all Tier B, no blunders** — the old gate held
  up. The change is therefore not a rescue; it removes a weak basis for a decision that gets
  baked into a repertoire and then drilled for months. The audit only re-grades moves we
  prescribe — it cannot see candidates the shallow gate wrongly rejected.
- **The shipped v2 decks were then audited the same way, and came back clean.** All 2,298
  prescribed moves re-graded against the index: **none fail the 5 win% gate — zero Tier B
  concessions, zero Tier C** (2026-08-14), against v1's six. 2,239 of them (97.4%) were found
  in the dump; the remainder sit in lines indexed shallower than depth 25, which the gate
  refuses rather than guesses at. The same run reports one position answered two ways, which
  is [#114](https://github.com/jahales/etude-chess/issues/114) — the start position, answered
  `d4` and `e4`, both deliberate and both sound.
- **Curated lines now run to ply 16 and reach the middlegame structure** — deepest line ply 19
  for 1.d4 + Black, ply 20 for 1.e4, against v1's deepest ply 13 (ADR
  [0025](docs/decisions/0025-curated-lines-run-to-the-structure.md)). A Carlsbad or an IQP
  does not exist until roughly ply 16, so v1 taught which moves to play and nothing about the
  middlegame those moves are for.
- **The band book grew from 367k to 8M games** (Lichess 1300–1800 blitz + rapid, ply 20),
  against a canon book of 2.82M Lumbra OTB games. The band book answers what will actually be
  played at you; the canon book answers what is principled.
- **The tactic-gap filter is off by default.** At 4M nodes it changed nothing across 412
  positions the crawler genuinely assessed — observed gaps averaging 0.45 win% against a
  threshold of 5 (ADR
  [0026](docs/decisions/0026-retire-the-tactic-gap-at-high-node-budgets.md)). It is a default,
  not a repeal: `--tactic-gap` turns it back on, and at lower node budgets it may well decide
  something again.
- **Trap annotations are now replicated across two independent months** — June and July 2026,
  8M games each: 98 of 149 confirmed for 1.d4 + Black (66%), 184 of 217 for 1.e4 (85%). What
  one month could not confirm is relabelled `one month only` rather than deleted: the
  statistics are still true of the month they came from, but the word inviting you to trust
  them is gone. `trapValue` is a statistic over noisy human data, and one month cannot tell a
  real trap from a coin flip.
- **Output is staged study decks in [repertoire/v2](repertoire/v2/)** — `standard` (525
  decisions) first, then `complete` (2,298), ranked by reach × cost-of-not-knowing and made
  prefix-closed, so moving up never means relearning anything. Four PGNs in the repo, two
  colours × two tiers; import one colour at a time.
- **A variation-aware repertoire PGN reader (#102)**, because chess.js silently drops
  variations on parse and a repertoire PGN is mostly variations — reading one back looked like
  it had worked. Plus `studyOrder.mjs`, which ranks what to learn first: a decision where the
  natural move is already the right one is worth nothing to study however common.

## [0.2.0] — 2026-07-18

**Play vs Maia, coached on every move.** A second mode alongside guess-the-move: play a full
game against a human-like opponent that runs entirely in your browser, with a coach watching.

### Added
- **Play vs client-side Maia (#14).** Pick your colour and level (**1100–1900**) and play a
  full game against Maia — a neural net trained to predict *human* moves at a rating, so it
  makes the mistakes you will actually face. Fully client-side (onnxruntime-web in a Web
  Worker); no backend. The worker + wasm load only when a game starts.
- **An ambient in-game coach** (ADR [0017](docs/decisions/0017-in-game-coach.md)). You move,
  Maia replies immediately, and Stockfish grades your move — tier, what it cost, and what it
  dropped. The better move stays behind **"Show me"** so the verdict does not bias your next
  decision; **Take back** undoes the pair.
- **Scores everywhere, toggleable.** Eval bar, exact current score, and a score on every move
  in the list — all from White's perspective. Switch the evaluation off to play on your own
  judgment.
- **Accuracy + post-game review.** Per-game accuracy over the moves *as played*, with a
  separate **take-back count**; the review adds an opening/middlegame/endgame breakdown and
  your worst moments with the better move. This is the game's move quality — not a skill
  rating or a claim of transfer (constitution §9, §12).
- Opening name, **Draw / Resign**, board flip, and a material strip.

### Engineering
- **`MaiaOpponent` port + onnxruntime adapter**, arm's-length in its own Web Worker exactly
  like Stockfish (both GPL, both with NOTICEs). Pure 112-plane Lc0 encoder + 1858-move policy
  decoder, unit-tested. See [docs/spikes/maia-onnx.md](docs/spikes/maia-onnx.md) and ADR
  [0016](docs/decisions/0016-maia-onnx-delivery.md).
- Pure `playMachine` reducer + `usePlaySession` hook (the ADR 0015 shape); one shared
  Stockfish worker now serves both modes.
- **Engine/board sync by construction:** every engine result carries the FEN it was computed
  for and is dropped if the board has moved on.
- 153 unit tests + Playwright e2e; CI runs verify + e2e on every PR.

## [0.1.0] — 2026-07-18

First release: **coached guess-the-move** on public-domain master games — a client-side,
no-backend React app.

### Added
- Guess-the-move loop: play the winner's side of a classic; commit a move + a one-line reason
  before the reveal.
- Win%-swing grading with **A/B/C tiers** — a move as good as the engine's best earns full credit
  (not "match the master").
- Analysis reveal: engine **alternatives (MultiPV) with scores + lines**, an **eval bar** (follows
  board orientation), and a **material** strip.
- Board interaction: **click-to-move** and drag, **flip**, and a **promotion picker**.
- Coaching "why": rules-based explanation over a computed **fact bundle**, with a
  **copy-to-clipboard** handoff for pasting into your own LLM.
- **SEE** (static exchange evaluation) for accurate hanging-piece detection.
- Tuneable **engine settings** (strength presets, lines shown).
- **Opening detection** (common openings) shown per game.
- Local-first **persistence** (IndexedDB) of every attempt as telemetry.
- Game pack: the Opera, Evergreen, and Immortal games.

### Engineering
- **Pragmatic hexagonal architecture** — pure `src/domain`, a pure `src/app` reducer, `Analyser`
  port + Stockfish WASM adapter (see [docs/architecture.md](docs/architecture.md), ADR 0015).
- Stockfish 18 (lite WASM) runs arm's-length in a Web Worker (GPLv3-compliant).
- **CI** (typecheck → lint → test → build + Playwright E2E), fast `npm run verify`, ESLint.
- ~100 unit tests + an end-to-end smoke test.

[Unreleased]: https://github.com/jahales/etude-chess/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/jahales/etude-chess/releases/tag/v0.3.0
[0.2.0]: https://github.com/jahales/etude-chess/releases/tag/v0.2.0
[0.1.0]: https://github.com/jahales/etude-chess/releases/tag/v0.1.0
