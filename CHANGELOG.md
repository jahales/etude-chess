# Changelog

All notable changes to etude-chess. Format follows [Keep a Changelog](https://keepachangelog.com);
this project uses [Semantic Versioning](https://semver.org). Updated as part of each release
(see [RELEASING.md](RELEASING.md)).

## [Unreleased]

### Added
- **The score and the continuation for the move *you* played, beside the engine's lines (#151).**
  The reveal could tell you a move cost you 10% of your winning chances and show you three lines
  that were not the one you played. What it could never show was the reply — and the reply is the
  whole explanation of a positional error, where no material changes hands and "it leaves e5
  hanging" is not what actually happened. Now "the move you played" is a line of its own: the
  score of the position it leaves, then the engine's answer to it, walkable move by move.
  - **It costs no extra engine time.** Grading has always run two searches — the position, then
    the position *after* your move — and the second one's principal variation was computed and
    then dropped on the floor, because `EngineEvaluation` carried only a score and a best move.
    Widening it to carry the pv makes the continuation free; a third search would have been a 50%
    increase on every move committed, at a live budget of 700k nodes. The grading test asserts the
    search count rather than trusting a comment.
  - **The tier is still the verdict.** The centipawn number is *additional information*, never a
    second grade: this project grades by win% swing with engine-equal as Tier A (ADR
    [0010](docs/decisions/0010-engine-architecture.md), constitution §9), and cp is a different
    question on a different scale. The panel says so in the same block, because two numbers next
    to each other otherwise read as two attempts at the same one — and it says the score comes
    from its own search, so a small disagreement with the same move inside a ranked engine line
    is explained rather than merely survivable.
  - **It cannot be mistaken for a recommendation.** Its own heading, its own block, and the amber
    the board already draws *your* move in — the one thing that must not happen on that screen is
    a reader taking their own mistake for the engine's pick.
  - **It is a line like any other**, so it clicks, steps and branches through #131's exploration
    reducer unchanged: your move is simply the first ply, rooted at the same position the engine's
    lines are rooted at, which is what lets one click move between them.
  - **Tier A gets it too.** An engine-equal move with a different plan is worth seeing the
    continuation of, and that is a large share of the moves this mode is built to reward.
- **Import your own chess.com games from inside the app (#145).** Reviewing your own games meant
  exporting a PGN from chess.com by hand and attaching it. Now you type your handle, tick which
  time controls to bring in, and press Sync. `api.chess.com` sends
  `Access-Control-Allow-Origin: *` and its monthly endpoints carry each game's full PGN inline,
  so this is the browser talking to a public read-only API with **no backend** (ADR 0009) and
  one request per month rather than one per game. This is the same decision as the rest of the
  database, not an exception to it: your games, on your device, redistributed nowhere (ADR 0018).
  - **It goes through the existing import path**, not a second one — `normalizeGame` →
    `describeGame` → `filterGame` → `putDbGames`, with the **My own games** preset (#129) that
    exists for exactly this case. So a game fetched from chess.com and the same game exported by
    hand land on the *same row*: the dedup key (#128) is computed from the game, never from where
    it came from, which makes re-syncing idempotent row for row. There is a test that proves it
    rather than an assumption that it holds.
  - **Which time controls come in is your choice, and there is no default.** The sync will not
    start until you pick at least one. Pooling blitz with rapid and daily describes a mixture of
    players rather than a player, so choosing for you would be choosing silently.
  - **It is polite to a free public API.** The archive index is fetched once; months go out one
    at a time with a pause between them; each month's write is *awaited* before the next request,
    so the disk paces the network instead of racing it; a month that has ended and is already
    covered is never asked for again — so a routine sync is the index plus the month you are in;
    a `429` is obeyed once using the server's own `Retry-After` and then reported rather than
    hammered. **Nothing syncs on load**; it is a button and only a button.
  - **A wrong handle says so.** A 404 is "no such user", never a run that finishes with "0 games
    imported" and reads like success. A rate limit, an unreachable site and a request that never
    left are all reported as themselves.
  - **The summary separates what was new from what was already there** — "Imported 0 new games
    from 26 fetched · 21 were already in your database" is what an idempotent re-sync should look
    like, and it says which months it skipped and what each filter rejected, in the same
    vocabulary the file import uses.
  - Your handle is typed at runtime and stored **on your device only** (`localStorage`,
    following #130), and syncing adds it to the names you play under, so the games you just
    imported open from your own side instead of arriving as somebody else's.
- **Review mode: pick a game, analyse it properly, then work the critical positions or the
  whole game (#144).** The pieces existed — import (#129), your own side (#130), explorable
  engine lines (#131), key-moment selection (#132), the whole-game pass (#133) — and nothing
  composed them into something you could open. A new Home card does: pick one of your games out
  of the attached database, run a pass over every position in it, then choose to re-decide only
  the moments that cost you the game or to work the whole thing move by move. The session and
  the reveal are the ordinary ones, explorable lines and all; this is composition, not a second
  kind of session.
  - **The pass budget was the blocking problem, and the fix is honesty rather than a bigger
    number.** The whole-game pass ran at **150k nodes per position**, defensible when the output
    was annotation glyphs and not defensible once #132 selects *which positions you are quizzed
    on* out of the same evaluations. This project had already measured the direction of that
    error: at 800k against 4M the reference game gave **one false negative and zero phantoms** —
    a real Tier B move looked clean — and understated the win% given away by 10%. But raising
    the in-app pass to 4M is not available: measured on the owner's machine, 4M is 4.13 s per
    search native single-threaded and WASM is 2–3× slower again with no pool, which puts a
    whole-game pass around **three quarters of an hour**. So:
    - The in-app default is **400k** (about 2.5× the old pass), with **250k** and **800k**
      offered. Every option is a time trade and nothing more — none of them is deep enough to
      make an *absence* mean anything.
    - The UI never claims otherwise. The heading is **"the positions this pass could see"**, the
      list is described as a floor rather than a ceiling, and a game the pass found nothing in
      is reported as "nothing obvious", explicitly **not** as a clean game. The hedge is driven
      by the recorded budget, not hard-coded, so it lifts by itself when a deep enough analysis
      exists.
    - The cost is on screen before the button: how many searches, at what budget, what the pass
      cannot do — and while it runs, real elapsed time with a live estimate from actual
      throughput rather than a guess.
    - The deep pass belongs **off-app**, where `scripts/` already has the engine pool; it is
      filed separately. The seam is `app/gameAnalysis.supersedes`: a stored complete pass at a
      deeper budget wins outright, no WASM search runs over the top of it, and every screen
      reports the deeper number.
  - **Changing the budget invalidates stored passes on purpose.** A pass is filed with the
    budget it ran at, so a game analysed at 150k reads as un-analysed and is redone rather than
    served at a depth we no longer trust — while a pass *deeper* than asked for is used as it
    stands. Partial passes now record their budget too, so a half-finished pass can never be
    topped up by a pass at a different one: evaluations from two budgets differenced against
    each other manufacture swings out of nothing.
  - **The list is never served silently short.** Even the weaker claim is a claim about every
    move you played, so it is offered only over a pass that measured every move you played. The
    four ways that can fail all render as "no list" and none of them means "you played clean",
    so each says which it is with the coverage attached: not analysed, analysed this far (with
    the moments it did find, marked as partial), measured end to end with nothing found, or
    found but unaskable. The whole-game path stays open throughout — it grades per move as you
    commit, so it needs no pass.
  - A selected moment reaches **inside the opening cutoff**. The cutoff skips theory nobody
    chose to be asked about; a moment is on the list because it measurably cost win%, and a
    blunder on move three is exactly what a review is for.
  - **Games you lost come first**, then draws, then wins, with not-yet-analysed ahead of already
    done — and the screen says plainly that it orders *the page*, not the database, because
    results come back through whichever index answered the filter.
  - Deliberately **not** done: analysing the game in reverse. It is a real technique and it does
    help, but it earns its speed from a warm transposition table, which is precisely what this
    project's reproducibility rule excludes — the same position at the same node count would
    grade differently depending on how it was reached. The honest path is to measure it first
    (one game forward and backward, diff the tiers) and revisit with an ADR.
  - Review mode is a **separate entry point** rather than the unified picker the owner has
    argued for; the browse machinery is reused, the picker's own table is not. Merging them
    stays worth doing.
- **Walk the engine's lines on the board (#131).** The reveal's top lines were static text:
  you could read "Rxh2+ Kxh2 Bxe5+ Rxe5 Rxd1" and still have no idea what the position at the
  end of it looks like — which is exactly when a line is worth seeing. Now every move in a line
  is a button. Click one and the board goes there; **← →** step through the variation; playing
  your own move on the board branches off and truncates whatever was ahead; one control comes
  back to the game. You can also just play a move from the game position without picking a line
  first, which makes the reveal a small analysis board.
  - **The engine follows the board.** While you are off the game the panel shows the engine's
    answer for the position you are standing on, and it shows **nothing at all** until that
    answer arrives — never the previous position's lines, which are legal moves with a
    plausible score and every claim in them false. The eval bar, the score chip and the lines
    all move together, all still from White's perspective.
  - **You cannot mistake it for the game.** The board carries a ribbon and an outline, the side
    panel says so in words, and the reveal's arrows — which name squares in the *game* position
    — are taken down. None of it appears when you step back to the start of the line, because
    there the board really is the game position and a warning that is sometimes false is one
    people stop reading.
  - Analysing the explored position waits **300 ms** for the cursor to settle: Stockfish runs
    one search at a time, so asking on every keypress would queue a whole search per press and
    land the answer you wanted seconds behind your last arrow.
  - Known gap: a branch **auto-queens**. Underpromotion inside a variation is not reachable.
- **Attach your own game database (#53).** A new Home card takes a PGN file you already have,
  parses it and indexes it on this device. Nothing is uploaded and nothing is redistributed —
  which is the point: étude ships no corpus, so the licensing question that hangs over every
  bundled games database never arises (ADR 0018). Large files are read as a **stream**, so a
  few hundred megabytes is a progress bar rather than a frozen tab, and the parsing runs in a
  Web Worker so the rest of the app stays responsive while it works.
  - **The filters are shown before the import runs, not explained after it.** Defaults aim at
    strong, standard time controls: no blitz, rapid or bullet, at least ten moves, both players
    rated 2200 or better. Every one of them is editable, and the summary says exactly how many
    games each rejected — "3,412 skipped: 2,900 blitz, rapid or bullet · 512 too short" beats a
    number that appeared from nowhere.
  - **A game whose rating or time control the file doesn't state is kept and marked unknown.**
    Guessing one in order to filter on it would silently drop games on the strength of an
    invention.
  - **A game we can't read is skipped with a reason, never fatal.** A malformed record, a
    header-only stanza or a line of junk in the middle of a file costs that game and nothing
    else; the games after it still import.
  - **Re-attaching the same file updates it instead of duplicating it.** Games are keyed on
    players, date, result and opening, so importing twice is a no-op rather than a mess. This
    matters more than it sounds: browsers evict script-written storage — Safari after about a
    week without a visit — so the app asks for persistent storage the moment you attach a
    database, says whether it was granted, and tells you to keep the PGN file either way. An
    import is never the only copy of anything.
  - Annotations that came with the file (`{...}` comments and NAGs) are kept rather than
    stripped: it's your own copy, and showing them locally is personal use.
  - Studying a game from what you've attached is #55.
- **Browse and search the database you attached (#54).** Filter by player or event, year,
  result, ECO, minimum rating, time control and source file; open any game to its headers,
  its provenance and its moves, annotations and all.
  - **It reads a page, never a database.** Every filter is answered through an IndexedDB index
    and paged fifty rows at a time, which is not an optimisation at the 10k–100k games an import
    is written for — it is the difference between a results table and a hung tab. Which index
    answers which filter is a *cost* decision and nothing else: a test pins that the index
    chosen plus what it left over is always the whole query, so the choice can be tuned freely
    and can never change which games come back.
  - **Names match on how they are spelled, not on how you spell them.** `garry` finds Kasparov,
    Garry — you don't have to know which way round the file wrote the name — and, the reason
    this needed a search engine rather than a prefix: **chess databases spell the same player
    several ways, and those are not typos.** Transliteration from Cyrillic varies by publisher
    and era, so a real corpus mixes Alekhine with Aljechin, Nimzowitsch with Nimzovich,
    Botvinnik with Botwinnik. `aljechin` and `alekhine` share no prefix at all, so a player
    search that only matched prefixes would return half a player's games and look like it
    worked. Searching either spelling now finds both, and an accented name typed without its
    accents finds itself.
  - Two indexes carry that, each doing the thing it is good at. A multiEntry index of the words
    in each game turns "games by Morphy" into a lookup instead of a scan, costs about 4.8 MB of
    tokens at 100k games against the ~76 MB of movetext already stored, and is backfilled for
    games attached before this release — without that they would have quietly gone missing from
    search while everything still looked right. On top of it sits a MiniSearch index over the
    **distinct names** rather than the games: 0.8 MB instead of 10.1 MB at 100k games, built
    without reading a single game record, and it leaves results paged through an index rather
    than truncated to a relevance list. It is rebuilt whenever what you have attached changes,
    and rebuilt rather than trusted whenever there is any doubt it still matches.
  - **A total is exact where that is free and honest where it isn't.** When the index answers a
    filter by itself the count is exact at any size; when rows have to be re-checked it stops at
    a thousand and says "1,000+" rather than reading a hundred thousand games to put a number on
    screen.
  - **A year, rating or ECO filter leaves out the games whose file never said** — an undated
    game is not evidence of a date. This is the mirror of the import rule, which *keeps* those
    games precisely because the file's silence is not a fact about the game; unfiltered they are
    all still there, and "Unknown" is a time control you can filter *for*.
  - **Nothing attached, an import still running, and a filter that matched nothing are three
    different sentences**, not one empty table.
  - **Where to find a database, dead ends included**, on the screen itself (ADR 0018 §5):
    Lumbra's Gigabase (CC BY-NC-SA 4.0 and the only cleanly-licensed maintained OTB corpus),
    TWIC for personal use, Lichess CC0 for online play — and, unlinked, that Caissabase's domain
    lapsed and now redirects to a crypto-casino affiliate, and that KingBase and Millionbase are
    down. We redistribute none of it.
  - Deliberately not fuzzy below five letters: one edit on a four-letter name matches a great
    deal of a real name list and means nothing.
- **Study any game you attached (#55).** Open a game from your database and guess-the-move runs
  on it exactly as it does on the curated pack — commit a move and a reason, then see the
  master's move and the engine's verdict. This closes the "bring your own game database" epic:
  a file you already had is now training material, and the three classics we ship stop being the
  whole of what there is to study.
  - **A note that came with the file is shown at the reveal, in the file's own words and marked
    as the file's.** It sits *below* our "why" and beside it, never merged into it: the sentence
    above is ours and computed from the engine, the one quoted below is somebody else's prose
    out of a file we did not write and have not checked. Both say so. Blending the two would
    have been the friendlier layout and a straightforward lie about where a claim came from
    (constitution §9/§12). A game the file never annotated reveals exactly as it did before.
  - **A drawn game asks which side you want.** The pack takes the winner's side, which works
    because every pack game is decisive. A real database is full of draws and of games whose
    file recorded no result, and the obvious fallback — "no winner, so play White" — would have
    quietly quizzed you as White for most of the strong games in it. So a game with no winner
    offers both sides and picks neither, and says how many positions each one is.
  - **What the session will be is stated before it starts**, because a database row is whatever
    was in the file rather than something chosen to be instructive: which side you take and how
    many positions it will ask for. A 100-move game is a long session, not a broken one — so the
    number is shown and the choice is yours, rather than a cap we invented.
  - **A game that can't make a quiz says so instead of opening an empty one.** A header-only
    stub, a game that ends before the quiz starts, and movetext that doesn't replay as a legal
    game are three different sentences on the screen. The last one matters more than it sounds:
    an import stores movetext as text and deliberately never replays it — that decision is what
    keeps a 100k-game import minutes rather than hours — so the first thing that ever checks a
    game is legal is the thing about to study it, and finding out inside the reducer would have
    taken the screen down with it.
- **Take your own side of a game you played, including the ones you lost (#130).** Tell the
  study screen which names you play under, and a game from your database carrying one of them is
  studied from **your** side first, whatever the result. Until now a decisive game was always
  studied from the winner's side — so importing a game you lost quizzed you as the player who
  beat you, which locked you out of exactly the games most worth reviewing. The other side is
  still offered, and a game with none of your names on it is unchanged: the winner's side when
  there is a winner, both sides when there isn't. **Grading needed no change and got none.** A
  move is graded against the engine rather than against the move that was played, so the losing
  side of your own game is a session about your decisions rather than a re-run of them, and a
  move better than the one you found is still Tier A. Only the side *selection* was in the way.
  - **The names are a list, not a field, and case doesn't count.** A site writes your handle into
    the `White` tag; a PGN you exported by hand writes `Lastname, Firstname`. Both are you, so
    both can be listed — one per line, because that comma is part of a name. Matching is
    whole-name: a substring rule would hand you the wrong side of every game against someone
    whose name contains yours, and a short name would claim the database.
  - **The list is yours, starts empty and stays on your machine** — typed in the app, kept in
    this browser. There is no handle in the source and there will not be one.
  - Two cases are said out loud rather than guessed: a game you played **against yourself** has
    no side that is more yours, so it falls back to the ordinary rule, and a game where your side
    has nothing to guess says so and offers the other side rather than pretending it is yours.
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
- **A "My own games" import preset, and clock stamps no longer masquerade as annotations
  (#129).** Attaching your own games worked, in the sense that a wall you can walk around is not
  a wall. Measured against a real chess.com account on 2026-08-15, the import defaults kept
  **0 of 280 games** — 247 rejected as blitz/rapid/bullet, 19 under the 2200 rating floor, 14 as
  too short — and every one of the account's plies carried a `{[%clk 0:15:09.9]}` comment, which
  the reveal then showed as a note *attributed to your file*, at every single position of a
  session.
  - **One click now sets the four filters for your own games**, next to the fields that were
    always editable: every time control kept, no rating floor, and a length floor of five moves.
    Five is not a taste call — the quiz starts at ply 8, so a shorter game cannot produce a
    single position to ask about for either colour, and importing one only stores a row that
    study can refuse later. The **defaults are untouched**: ADR 0018 §4 chose them for the master
    corpus this trainer is built on, a test now pins them, and this sits beside them rather than
    replacing them. Neither button stays lit once you edit a field by hand, because at that point
    the settings are yours and claiming otherwise would be a small lie on the screen.
  - **`[%clk]`, `[%eval]`, `[%emt]`, `[%csl]` and `[%cal]` are stripped from imported comments,
    and whatever prose was around them is kept.** These are a program's data wearing a comment's
    clothes: a clock reading is not something a person wrote about the position, and an `[%eval]`
    from someone else's engine at someone else's budget is exactly the kind of number that put a
    `?!` beside a move our own coach had called good. Matching is on the `[%` syntax rather than
    on the five names, since every tool invents its own and the sixth would otherwise reach a
    reveal looking like an annotation.
  - **A comment that was only commands ends up absent, not empty**, which is the whole of why
    this is a change to the import rather than to the reveal. An empty-string comment is still a
    comment to everything downstream, so it would have rendered as an attributed *blank* under
    every reveal of every online game — the file credited with prose it never contained
    (constitution §9/§12). A game with no real notes now reveals exactly as it did before, and a
    test states that property rather than leaving it to be noticed.
- **Coach mode — rank your weaknesses across the whole archive (#137).** `npm run review`
  coaches off *one* game; this answers the question the owner actually asks between sessions:
  across everything I've played, where is my time worth spending? `scripts/coach/archive.mjs`
  grades every move you have played on chess.com at the same 4M nodes and with the same rule
  the single-game review uses — `gradeMove` on two evaluations from the mover's perspective —
  so a number here is comparable to a number there rather than a second scale nobody can
  reconcile. `scripts/coach/assess.mjs` prints the ranked report; the bucketing, aggregation and
  base-rate arithmetic are pure and tested in `domain/coachReport.ts`. **CLI plus a skill, no
  UI** — the capability was asked for, not a screen.

  **The headline is total win% given away, not error rate.** "Where is my time worth spending"
  is frequency × severity, and ranking by rate puts the rare-and-dramatic above the
  common-and-expensive — precisely the wrong advice for someone with a few hours a week. Every
  bucket carries its share of the *moves* beside its share of the loss, because a bucket holding
  a third of the loss over a third of the moves is not a weakness, it is a third of the game.

  **Time controls are never pooled, and the code refuses rather than advises.** The owner's
  archive is 232 blitz (all July, ~840–880) against 27 rapid and 17 daily, and he moved off
  blitz around 2026-08-08 — so a pooled ranking lets blitz outvote his current chess 5:1 and
  describes a player he no longer is, with numbers that look perfectly healthy. `bucketsBy`
  throws on a mixed sample; the archive fetcher will not default its time-class filter to
  "everything".

  **What earned the work is the discipline, in `.claude/skills/coach/SKILL.md` §4.** Doing this
  by hand on 2026-08-15 produced two near-misses that only a base rate caught. The one the skill
  is built around: 82% of the owner's middlegame errors moved a different piece than the
  engine's best, which reads as a clean candidate-generation finding and had already been
  drafted as a coaching conclusion — until those positions turned out to average 29.3 legal
  moves across 8.8 movable pieces, so a blind guess lands on the engine's piece 22% of the time
  and he was at 18%. The finding was chance, about one standard deviation into the direction
  that would have been reported as a discovery. `pieceMatchBaseline` now computes that
  comparison on the same positions, and the denominator it uses is load-bearing: one-over-pieces
  gives 11%, against which 18% reads as *above* chance and a null result becomes a finding
  pointing the opposite way.

  Three more refusals ride along. **The think-time curve carries its confound as a field, not a
  comment** — error rate rises monotonically from 3% under 5s to 34% over 60s, and the obvious
  reading is wrong in both directions, since hard positions cause the long think *and* the
  error; the claim it supports is only the weaker "extra time is not converting into accuracy",
  which is still enough to rule out "slow down" as advice. **A mechanism is not diagnosable from
  a move list** — "didn't consider it" and "considered it and misjudged it" are identical in a
  swing table, and separating them needs the stated reason from before the reveal (#49), not
  more engine depth. And **one session is one session**: the sample is reported with every
  ranking, buckets under 50 moves are marked thin, and under 30 games the report says outright
  that it describes these games rather than a pattern to train against (constitution §9, §12).

  A full run is hours, so it is resumable per game — a crash costs the game in flight — and
  `--limit` is there to try it. The chess.com archive reader moved out of
  `scripts/review/game.mjs` into `scripts/chesscom.mjs` rather than being copied; `npm run
  review` behaves exactly as before.

### Changed
- **The licence is AGPL-3.0, and `package.json` finally agrees (#121, ADR
  [0029](docs/decisions/0029-agpl-3-0-is-the-licence.md)).** The repo had declared MIT in
  `package.json` and AGPL-3.0 in `LICENSE` since its first commit — two different answers to
  what anyone may do with the code, in a public repository. The dependencies settle it rather
  than taste: **chessops is GPL-3.0-or-later and is linked into the bundle** for streaming PGN
  parsing, and Stockfish 18 ships as GPL-3.0 WASM, so the distributed work has to be
  GPL-compatible and MIT was never available. `LICENSE` was already right; the declaration was
  the bug. README now states the licence and points at the third-party notices.
- Home gained a fourth card, **Your game database**, with a live count of the games attached.
- **chessops joins the app for PGN parsing only** (ADR 0028, amending ADR 0009). It is GPL, and
  ADR 0009 set out to avoid it — but it ships the only JavaScript PGN parser that doesn't need
  the whole file in memory, and the project is AGPL, so the "keep our options open" argument
  that clause rested on was already spent. It is confined to one module, and the rules it feeds
  don't know it exists.

### Fixed
- **Review mode no longer calls your own move "the master's" (#158).** Reviewing a ~1100 blitz
  game of his own, the owner was told "you played Qa5+ · **master** e4" and "Solid — as strong
  as the master's choice" — about a move *he* had played, in a game with no master in it. The
  field was right and the word was not: `planStudy` fills the game's move from whatever the
  record holds, and every screen called it a master's. **"Master" is now true only of the
  curated pack** (`content/games.ts`), which declares it as a literal; a `StudyGame` carries a
  `MoveSource` (`domain/moveSource.ts`) decided where the game is built, and nothing downstream
  re-derives provenance.
  - **Three cases, three vocabularies.** The pack reads exactly as it did: "you played Qa5+ ·
    master e4". A game you played reads "you chose Qa5+ · **in the game you played** e4" — both
    moves are yours there, so naming only one of them "you" said nothing, and the arrow legend
    separates "the move you played in the game" from "the move you just chose". Anyone else's
    game is attributed to the player the file named ("other_player played e4"), falling back to
    the game itself, never to an invented person, when the file named nobody.
  - **The LLM clipboard mattered most**, because nobody proofreads it between the button and the
    model. It said `Master's move: e4` about club blitz and closed by asking the model to
    "explain why e4 is better than Qa5+" — a comparison **nothing in this app has ever made**.
    Grading is your move against **Stockfish's** (`engine/grading.ts`), never against the move
    played in the game. So the bundle now labels that move by who played it, asks its question
    about the engine's move, says outright which of the two produced the tier, and asks what a
    move *achieves* when there is nothing better to compare it against — "why X is better than
    X" is an invitation to invent, which ADR 0012 forbids.
  - **The verdicts say what actually measured you.** "Solid — as strong as the master's choice"
    is now "Solid — the engine rates it as strong as its own top choice", which is both true and
    the mechanism. Matching your own past move is reported as agreement rather than as a grade,
    and a move you played twice is no longer announced twice under two names.
  - This is constitution §9/§12 rather than copy: the discipline is not claiming authority a
    number or a move does not have. **Arrow colours did not move** — only words changed.
- **The board is sized to the window now, height included (#150).** On a 1920×1080 screen it
  rendered at 560px — 29% of the width, the smallest thing on the screen, on the surface where
  the whole product happens. Three caps stacked to produce that: a 960px page shell, a 560px
  grid track and a 560px cap on the board frame itself. It is **854px** on that screen now, and
  **574px** on a 1920×800 one.
  - **The 960px shell stayed**, because it is a typography decision — this app's reading
    measures are set in `ch` — and widening it would have stretched every text column to match.
    Board screens step out of the prose shell instead; the side panel keeps a measure of its
    own (20–28rem) and the board takes the rest.
  - **Height is the input that was missing.** A board sized on width alone is taller than a
    short, wide window, and then the board and the controls under it leave the screen in the
    same motion — worse than a small board, because you lose the position and the way to move
    in it together. The size is `min(width available, height available − the strip and the
    controls)`, so the board stays square and whole at any window size, which is what a
    resizable board is for.
  - The eval bar, the material strip and the board controls are all bounded by the board rather
    than by the column, so they still start and end exactly where it does at every size.
  - **Verified by driving a browser**, because jsdom lays nothing out and cannot tell a
    correctly sized board from a collapsed one: the invariants — square, big enough, controls on
    screen without scrolling, strip and bar aligned, and click-to-move still landing on the
    square you clicked after a resize — are now
    [`e2e/board-size.spec.ts`](e2e/board-size.spec.ts). It caught two of its own kind while
    being written: a board that collapsed to 271px on a 760px screen, and one that hung past its
    own column when a window was made shorter.
- **A game that starts from a set-up position is studiable, instead of being reported as a
  broken file.** Studies, endgame collections and puzzle sets carry their starting position in
  a `FEN` tag, and many carry no `Variant` tag at all — so nothing rejected them and nothing
  kept the position either. Their moves were replayed from move 1: usually illegal at once, so
  the game was refused as unreadable and the file blamed for what the import had discarded;
  occasionally legal, and then quietly a different game, with the board, the grading and the
  file's own notes all describing positions you weren't looking at. Games already imported
  can't recover what was dropped — re-attach the file and they come back.
- **Two games are no longer stored as one when a file gives no dates.** The key that decides
  whether two records are the same game ended at the first ten moves, which leaned on the date
  to tell the rest apart. Undated collections have none, so a match between the same players
  out of the same opening imported as a *single* game while the summary still counted them
  all. The key now covers the whole game. An attached database is rekeyed the first time you
  open it, so re-attaching a file still updates it rather than duplicating it.
- **The database screen can no longer hang on a spinner that never stops.** A failure while
  expanding a search term escaped every handler around it and left the screen loading for
  good, with no filter change able to clear it.
- **Importing while paged deep into the results takes you back to the first page**, instead of
  to a page of a result set that no longer exists — which reads as "nothing was added" right
  after an import that said it worked.
- The search index now records *which* games it was built over, not just how many, so it
  cannot be reused across a swap of one file for another of the same size.

### Engineering
- **The rule for which positions in a game are worth re-deciding (#132).** Studying an imported
  game quizzes *every* move you made past the opening: on the owner's session of 2026-08-14 that
  was ~30 questions a game, ~26 of them Tier A — moves with nothing to learn, asked at the same
  weight as the move that lost the game. `domain/keyMoments.ts` picks the handful that decided it
  instead, each carrying **why** it was picked: a blunder, a mistake, or a **missed punish** — a
  mistake made on the move right after the opponent handed something over, which is a different
  lesson from an unprovoked one and so gets its own label rather than a bigger number. Ranked by
  what the move cost, capped at six by default, and no reason weights the ranking: the thresholds
  are the tier boundaries the coach and the `??` glyphs already use, because a second grading
  scale would let one move be a mistake on this screen and fine on the next (constitution §9,
  ADR [0010](docs/decisions/0010-engine-architecture.md)). The swing arithmetic itself now
  lives in `domain/winPercent.ts`, so the whole-game pass and this cannot come to differ about
  what a move cost.

  Two things it refuses to do. **A move it cannot measure is skipped, never scored as 0 swing** —
  evaluations are sparse while a pass is still running, and reading a gap as "unchanged" is the
  easiest way to produce a confident, wrong "you played this perfectly". And **"no moments" is
  never reported bare**: the result carries how many of your moves were measured, because "you
  played clean" and "we haven't looked yet" are the same empty list and mean opposite things. It
  also does not offer "the critical position where you found the only move" — telling that from
  one of six good moves needs the breadth of a multi-line search the whole-game pass doesn't do,
  so it waits, the same way `!` does.

  **Nothing renders this yet**, which is intended: the rule and its tests ship first, and the
  screen that uses it is a later issue.
- **A game you imported can be analysed, not just one you played (#133).** The whole-game pass
  that scores every position of your own games (#68) now runs on a game out of your attached
  database too, at the same single node budget — one pass at one budget is what makes the scores
  within a game comparable to each other, and what the `?!`/`?`/`??` glyphs rest on. It is a
  *widening*: the pass now asks for the two things it actually needs — the moves, and what an
  earlier pass recorded — so a game you played and a game you imported both satisfy it, and every
  existing caller is untouched. **Nothing renders it yet** either: this exists so that #132 above
  has per-ply evaluations to choose its moments from.
  - **It replays the game from the position the file recorded**, so a study, an endgame collection
    or a puzzle set is scored in the positions it was actually played in rather than from move 1
    (#128). The positions are rebuilt from the same row the analysis is filed against, which makes
    losing the starting position impossible rather than merely unlikely — and the pass is filed
    with the position it ran from, so a re-import that replaces a row can never be served
    evaluations of a different game.
  - **The evaluations are kept beside the game rather than on it**, and that is a decision about
    what an import costs rather than about tidiness. Re-attaching a file overwrites row for row on
    purpose — that is what makes re-attaching after an eviction free — so evaluations stored on the
    row would be wiped by the next import, and keeping them would mean reading a hundred thousand
    rows back before writing them, to preserve the work of the handful of games anyone analyses by
    hand. Beside it, an import stays exactly as fast as it was, browsing reads exactly what it read
    before, and detaching a database leaves the analyses behind — so re-attaching the file gives
    you the engine time back instead of asking for it again. The schema bump adds a table and
    rewrites nothing, which is the safest migration there is.
  - **A pass the engine died partway through is not recorded as an analysis.** The positions it
    managed are still worth keeping; calling that complete would be indistinguishable later from a
    game where nothing went wrong.

### Tooling (off-app)

Nothing here ships in the browser bundle — it is the offline repertoire pipeline under
`scripts/repertoire/`. Closes the second half of #115; the first half (`studyOrder.mjs`
defaulting to a superseded book) shipped in #117. #122 finishes the job on `buildBook.mjs`,
which had been left out of #115's scope.

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
- **`buildBook.mjs` uses that parser too, and it is the one that mattered most (#122).** It
  kept a third local copy, with both of #115's defects. A typo ran the whole scan at the
  defaults and wrote a book that looks right; a bare `--max-games` was `Number(true)` = **1**,
  so the book was built from **one game**, written, and reported as a success. This is the
  front of the pipeline — every crawl, every trap statistic and every study ranking after it is
  computed against whatever book it produced — so the failure arrives hours later as numbers
  that look slightly odd, from scripts that all ran correctly. `verifyBook.mjs` catches the
  extreme cases, but it is a separate step you have to remember, and the point of #115 was that
  the failure should be impossible rather than detectable. The whole command line is now read,
  and rejected, before a byte is downloaded.
- **`--ratings` is a range, and is checked as one.** `1600,1800` — the explorer bucket syntax
  `crawl.mjs` takes — parsed as a single `NaN` that no game falls inside, and `1600` alone kept
  the default 2000 as its maximum. Both scanned an entire 27 GB month in order to write a book
  nobody asked for. A misspelled `--speeds` was worse: the scan excludes *known-wrong* speeds
  rather than requiring a known-right one, so `blizt` kept only games naming no speed at all,
  which on a Lichess month is none of them.
- **`--no-cache` still means exactly what it always meant.** It is the explicit off switch,
  absence is not, and it wins over `--cache` — with a test on each, because backwards this
  silently re-downloads 27 GB, or silently writes it to a disk that was never offered.
- **`--help` describes this script too.** Every default it quotes is interpolated from the
  constant it describes, `--help` itself is no longer the one flag it forgot to document, and
  the same two-directional test now holds its known-flag list and its `--help` to the same set.

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
