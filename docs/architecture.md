# Architecture & current state

> The on-demand system map (CLAUDE.md stays lean and points here). Keep this
> accurate — updating it is a release step (see [../RELEASING.md](../RELEASING.md)).
> Last updated: v0.3.0, 2026-08-14.

## What exists today (v0.3.0)
A **client-side, no-backend** React app with **three modes**, plus a body of **off-app Node
CLI tooling** that ships no UI (see [Off-app tooling](#off-app-tooling--scripts) — it is not
part of the browser bundle, and a session reading only the module map would not know it exists).

1. **Coached guess-the-move** (v0.1.0) over a pack of public-domain master games. You take the
   winner's side; at each move you commit a move + a one-line reason before the reveal;
   Stockfish grades it by **win%-swing tier**; the reveal shows alternatives, an eval bar,
   material, and a plain-language "why".
2. **Play vs Maia + in-game coach** (v0.2.0). Play a full game against **Maia** — a neural net
   that predicts *human* moves at a chosen rating (1100–1900) — running in the browser. You
   move, Maia replies immediately, and Stockfish grades your move: tier, what it cost, what it
   dropped. The better move hides behind **"Show me"** so the verdict doesn't bias your next
   decision; **Take back** undoes the pair. Scores (toggleable) appear on the bar, the current
   position, and every move. At the end: **accuracy + a post-game review** (by-phase, worst
   moments) plus a **take-back count**.
3. **Review your own games** (v0.3.0). Every finished game is saved to a **library** and
   replayable: step with the arrow keys or click any move, with the coach's verdict on each of
   your moves and the eval after every ply, read back from storage rather than recomputed.
   On top of that:
   - **Whole-game analysis in one pass** (#68) — one button scores *every* position at one
     uniform budget, so the move list shows where the game actually turned rather than only the
     moves the live coach happened to grade. It runs a position at a time, you can keep stepping
     while it fills in, and the result is stored so the work happens once.
   - **Engine analysis on demand while reviewing** — an eval bar and "Analyse this position"
     with the engine's top lines. The coach only ever graded *your* moves, so before this every
     other position in your own game was unexplained.
   - **Honest glyphs** (#67) — `?!`, `?`, `??` derived from win% swing at the existing tier
     boundaries. Deliberately **no `!!`/`!?`/`!`**: the first two are human judgments no engine
     number implies, and `!` needs a multi-line search the coverage pass doesn't do. A glyph is
     a claim; guessing at one costs more trust than it buys.
   - **"Worth studying"** — your worst measured moves, biggest first, as buttons that jump
     straight to the position. This is what closes the loop: a flagged mistake is navigation,
     not a note.
   - **Persistent storage** (#78) and **delete + storage usage** (#81) — the library asks to
     stay saved and says plainly whether it was granted.

v0.3.0 was a **hardening cut**: alongside the above it made the assembled surface trustworthy —
real e2e coverage in CI, long games, failure paths, and numbers that no longer contradict each
other (#74, #79, #80, #82). Full list in [../CHANGELOG.md](../CHANGELOG.md).

See [vision.md](vision.md) for *why*, [v0.1.0-plan.md](v0.1.0-plan.md) and
[v0.3.0-plan.md](v0.3.0-plan.md) for the release designs, and ADRs
[0013](decisions/0013-v0.1.0-play-vs-maia.md)/[0016](decisions/0016-maia-onnx-delivery.md)/
[0017](decisions/0017-in-game-coach.md) for the earlier scopes.

## Shape: pragmatic hexagonal (ports & adapters) — ADR [0015](decisions/0015-pragmatic-hexagonal.md)

> **Dependencies point one way.** The domain imports nothing. An adapter (`engine`, `persist`)
> may import the **domain and nothing else** — not `app`, not `ui`, and **not the other
> adapter**, so `engine → persist` and `persist → engine` are violations exactly like
> `persist → app` is — two adapters wired to each other are one adapter under two names, and
> neither can be swapped or faked alone again. `app` may use the domain and both adapters, never
> `ui`. `ui` sits on top and may use everything. The `ALLOWED` map in the test is the exact
> statement of this; prose that says less than it says is a bug in the prose. It is
> **enforced** by [`src/architecture.test.ts`](../src/architecture.test.ts), not just asserted
> here — it went unnoticed twice while it was only prose (`persist/db.ts` importing reducer
> types; `app` importing `AnalyserState` from `ui`). Types shared between the app and an adapter
> belong in `src/domain` — that's what `domain/gameRecord.ts` is for.
>
> What the test does **not** cover, so you still have to think: `src/content` is outside the
> check entirely (it is neither scanned nor recognised as an import target), test files are
> exempt on purpose because they assert across layers, and detection is textual — it reads
> `from '../<layer>/…'` specifiers, so an alias would slip past.

### Domain core — `src/domain/**`
Pure functions + types: **no React, no engine, no I/O, no `Date.now`**. Fully unit-tested, and
fast to test precisely because nothing in here can touch anything. TDD here.

- **Grading and scores** — `winPercent` (Lichess win% model), `grade` (A/B/C tiers by win%
  swing), `annotation` (`?!`/`?`/`??` from the *same* boundaries, so a glyph can never contradict
  the coach), `accuracy` (per-move/per-game accuracy + phase detection), `types`.
- **Position facts** — `material`, `see` (static exchange evaluation), `notation` (SAN + score
  formatting, incl. White-perspective labels), `replay` (rebuild every FEN of a game from SAN;
  positions are derived, never stored, so they can't drift from `sanHistory`).
- **Explanation** — `factBundle` (guess-mode "why" + the LLM clipboard bundle; also home to
  `hangingAfterMove`, which nets a capture against the recapture so a normal trade stops reading
  as a hung piece), `coach` (play-mode, engine-based "why"), `mistakeKind` (labels a mistake the
  search already found as hung material / missed material / positional — **a label only**, never
  a finding of its own, since SEE cannot see x-rays or pinned defenders).
- **Measurement** — `blunderRate` folds per-game counts into the project's leading indicator
  (#65, ADR [0027](decisions/0027-blunder-rate-as-the-leading-indicator.md)). `isBlunder`
  *delegates* to `annotation`'s `??` rather than re-testing `BLUNDER_MIN_SWING`, so the moves
  counted and the moves glyphed cannot drift; `perGame` is `undefined` over no games, because a
  rate over an empty sample is not 0.00. Everything a caller needs to state the sample — games,
  moves, what was left out, whether it is too thin to mean anything — is on the result, so the
  figure cannot be rendered without it.
- **Sessions and records** — `harness` (PGN→quiz), `session` (attempt + summary),
  `gameRecord` (`CoachEntry` + `PositionEval` — the vocabulary a played game is *recorded* in,
  in the domain so `persist` never has to import from `app`), `studyGame` (`StudyGame` — what a
  guess session runs on, whichever source it came from — plus the mapping and the refusals for a
  game out of the attached database; see #55 below).
- **Choosing what to re-decide** — `keyMoments` (#132) picks the handful of your moves worth
  asking about again, on `grade.ts`'s own tier boundaries and never a second scale, and reports
  `measured`/`total` so an empty list can be told apart from an unmeasured game. `reviewPlan`
  (#144) is the judgment between that and a screen: which games to open first (losses, then
  draws, then wins; unanalysed ahead of analysed — and `not-yours` is a real bucket, not a
  fallback), and whether the list may be offered at all. It refuses on anything short of a
  complete pass and names which of four things happened, because three of them are *not* "you
  played clean" and all four render as no list.
- **Whole-game review** — `gameReview` grades a *finished* game rather than a single guess: win%
  swing per move for both sides, where win% leaked by phase against the time spent there, and
  which of the opponent's mistakes went unpunished. Each position is evaluated **once** —
  the eval before move N+1 *is* the eval after move N, so consecutive entries give both sides'
  swings and a separate "before/after" pass would double the engine cost for the same answer.
  `tablebase` turns a Syzygy probe into a verdict: under eight pieces the result is a solved
  fact, not an evaluation, which matters most in exactly the phase the owner is weakest. Its one
  real trap is the perspective flip — the API reports each move's category from the position
  *after* it, so a move leaving the opponent lost is a win.
- **Archive-wide coaching** — `coachReport` ranks buckets of the owner's moves across every game
  he has played (#137, `scripts/coach/`). Three rules are in the code rather than in a comment,
  because each one produced a wrong conclusion when it was only convention: the headline is
  **total win% given away, not error rate**; every bucket carries its **share of the moves**
  beside its share of the loss; and `bucketsBy` **throws on a sample spanning two time classes**.
  `pieceMatchBaseline` is the module's reason to exist — a chance baseline computed on the same
  positions, which turned "82% of his errors moved the wrong piece" back into a coincidence.
- **Repertoire rules (shared with the CLI tooling)** — `repertoire` (coverage, trap scoring, the
  quiet-position test), `repertoirePgn` (PGN-with-variations rendering), `repertoirePlan`
  (branch ownership across a manifest of crawls — ADR
  [0022](decisions/0022-repertoire-branch-ownership.md)), `bookQuality` (data-quality assertions
  over a generated opening book: of the defects found building the generator, **none** were
  caught by logic tests and **every one produced a plausible-looking result rather than an
  error**, so these assert against the data itself). ADR
  [0021](decisions/0021-opening-repertoire-generator.md). **In the domain although only
  `scripts/repertoire/` uses them today** — they are pure rules, they are unit-tested here, and
  `epic:opening` will want them.

**Two constraints** run through the modules above, both worth knowing before you edit them, and
both there for the same reason: the `.mjs` scripts load domain modules directly under Node's type
stripping, which erases the types but resolves what's left as plain ESM.

The repertoire four (`repertoire`, `repertoirePgn`, `repertoirePlan`, `bookQuality`) are
deliberately **runtime-import-free** — `import type` only, so nothing survives stripping to be
resolved at all. They therefore speak win% and never centipawns, and `repertoirePgn.ts`
re-declares grade.ts's tiers instead of importing them (its test pins the two together so they
cannot drift).

`grade.ts`, `gameReview.ts`, `mistakeKind.ts` and `factBundle.ts` solve it the other way round,
and the rule is narrower than "these modules import with an extension": **only the *runtime*
imports carry the explicit `.ts`. A type-only import doesn't, because stripping deletes the whole
statement before anything is resolved.** So `grade.ts` writes
`import { winPercent } from './winPercent.ts'` alongside a plain
`import type { Score, Tier } from './types'`; `factBundle.ts` reaches for `./see.ts` but takes
`MoveGrade` from `'./grade'`; `mistakeKind.ts` carries `./factBundle.ts` and `./see.ts`;
`gameReview.ts` carries `./grade.ts` and `./winPercent.ts`. It is the extension on a *value*
import that is load-bearing, and that is the option to reach for in new shared modules:
`allowImportingTsExtensions` is on and Vite resolves the extension unchanged, so nothing has to
be duplicated and kept in sync by hand. All four say so in a comment at the import, because the
extension reads as an untidiness someone will otherwise tidy away.

### Content — `src/content/**`
`games.ts` (the public-domain v0.1.0 pack — game *scores* are facts, not copyrightable) and
`openings.ts` (longest-prefix opening detection; not a full ECO database). Consumed by `app` and
`ui`. Note that the layering test does not police this directory — keep it data-shaped. `games.ts`
holds only data now: `PackGame` is an alias for `domain/studyGame`'s `StudyGame`, because at #55
the pack stopped being the only source of a game to study and the session must not be able to
tell one source from the other.

`pgnImport.ts` and `chesscom.ts` are the exceptions to "data-shaped": they are the two readers
that bring games in, and the only modules in `src/` that import **chessops** (GPL — ADR
[0028](decisions/0028-chessops-for-streaming-pgn.md)). `pgnImport.ts` streams an attached PGN
database (#53); `chesscom.ts` fetches your own games from chess.com (#145).

`pgnImport.ts` streams because a user's database can be larger than memory, so the file is
consumed through `stream()` and never `text()`, games are handed on in batches, and each batch is
**awaited** before reading continues. Its test asserts all three — including that a game is
delivered before the last chunk is pulled — because a refactor that reintroduced the whole-file
read would otherwise pass every other test in the repo.

### PGN import — `domain/pgnImport.ts` + `content/pgnImport.ts` + `app/pgnImportWorker.ts`
We ship **no** corpus; the user attaches their own file and it is parsed, filtered and indexed
locally (ADR [0018](decisions/0018-games-corpus-and-annotations.md), plan §9). The split is the
usual one: `domain/pgnImport.ts` holds the pure rules — normalising a parse tree to our own
`ImportedGame`, the derived `GameFacts`, the ingest filters and the dedup key — and declares the
parse tree it consumes **structurally**, so the domain has no chessops in it at all.

Three things about this that are easy to get wrong on a later edit:

- **Nothing replays a move.** Movetext is stored as *text*. One byte per move is 5× smaller but
  needs legal-move generation at every ply — ~12 games/sec, over two hours for a 100k-game
  import. CPU is the binding constraint, not storage ([spike](spikes/games-corpus.md) §5). The
  byte encoding stays a documented escape hatch.
- **Unknown is never a guess.** A game whose time control or rating the file doesn't state is
  kept and marked unknown; a filter may only reject on what the file actually says (ADR 0018 §4).
- **A malformed game is skipped with a reason, never fatal.** chessops' budget guard is terminal
  once it fires, so the driver feeds the parser *line at a time* and replaces it on error — a
  whole-chunk feed would cost every game after a pathological one.

`app/pgnImportWorker.ts` runs the parse and filter off the main thread and hands back batches;
`app/usePgnImport.ts` writes them via `persist/dbGames.ts` and **acknowledges each batch after
it is stored**, which is what stops the parser buffering a whole database ahead of the writer.
`navigator.storage.persist()` is asked for from the hook rather than the worker: it is a window
API, and being refused is reported rather than assumed. `ui/Database.tsx` is the screen.

### Syncing your own games — `domain/chesscom.ts` + `content/chesscom.ts` + `app/useChesscomSync.ts` (#145)
The **second door into the same room**, not a second import path: it fetches your own games from
chess.com's public read-only API (`Access-Control-Allow-Origin: *`, so no backend — ADR 0009) and
takes every one of them through `normalizeGame` → `describeGame` → `filterGame` → `putDbGames`
with `MY_GAMES_FILTERS`. That is what makes a synced game and the same game exported by hand land
on **one row**: the dedup key is computed from the game, never from its provenance.

Same split as above. `domain/chesscom.ts` is pure — which months are worth asking for, which
games to keep before spending a parse on them, how a finished month is recorded.
`content/chesscom.ts` does the fetching; `app/useChesscomSync.ts` stores what comes back and
records the account.

Four rules here exist because each has a specific failure behind it:

- **A month is only "done" once it has ended *and* for the classes you asked for.** Recording the
  month you are in would strand the rest of it; a bare done-flag would skip every month you had
  already visited when you later add a second time class, and return nothing.
- **The API is free and public, and we behave like it.** Index once, months serially with a pause
  between them, each write awaited before the next request, one `Retry-After`-obeying retry on a
  429 and then a reported failure. **Nothing syncs on load** — it is a button.
- **A 404 is `no-such-user`, never an empty archive.** Falling through would end the run with "0
  games imported", which reads as success.
- **Time class is the user's pick with no default** (`coach` skill: pooling blitz with rapid and
  daily describes a mixture of players), and **no `User-Agent`** — browsers forbid setting it.

The handle is typed at runtime and kept in `localStorage` (`app/chesscomAccount.ts`), the same way
#130 keeps the names you play under. There is no default and there will not be one: it is the
owner's to publish and it appears nowhere in this repo.

### Browsing the attached database — `domain/dbQuery.ts` + `persist/dbGames.ts` + `persist/searchIndex.ts` (#54, plan §10)
Same split again. `domain/dbQuery.ts` is pure: the query type, the `matchesQuery` predicate, and
`queryPlan`, which chooses **one index to drive a query** and hands back everything it did not
enforce as a `residual` re-checked per row. `persist/dbGames.ts` turns a plan into a Dexie
collection and pages it; `app/useDbBrowse.ts` holds the form, the page and the counts.

**Free text is resolved before anything queries.** `persist/searchIndex.ts` (MiniSearch, ADR 0018
§6) turns each word typed into the set of index tokens that satisfy it; the domain receives that
as data (`TermMatch`) and never learns how a name was matched. So the fuzzy matcher is injected,
the rules stay pure, and swapping the matcher touches one file.

- **The plan is a cost decision, never a correctness one.** Reordering the driver preferences,
  adding an index or dropping one cannot change *which* games come back, only how much work it
  takes — a property a test pins directly, which is what makes the preference order free to be
  a heuristic.
- **A page is all that is ever loaded**, and `hasMore` comes from reading one row past the page
  rather than from a count. A total is exact when the driving index answers the query by itself
  and **capped at `COUNT_CAP` otherwise** (shown as "1,000+"), because an exact total behind a
  residual filter means reading every row in the driver's range to put one number on screen.
- **`*names` is a multiEntry index** of the tokens in White, Black and Event. It does two jobs:
  it is how a matched name becomes a set of games (`anyOf` on the resolved tokens, or a
  `startsWith` range when a word is too broad to enumerate), and its `uniqueKeys()` **is** the
  vocabulary the search index is built from — an index-only read, no records touched. A multiEntry
  index cannot be part of a compound one, and one row can sit at several keys inside the range
  being walked, so every query through it is `.distinct()`. It costs ~6.6 entries per game
  (~4.8 MB of token text at 100k games, against ~76 MB of movetext for the same import), and
  `db.ts`'s **v4 upgrade backfills it** — rows imported by #53 carry no `names`, and IndexedDB
  indexes only what a row holds, so without the backfill they would drop out of search silently.
- **A browse filter excludes what the file never stated** — an undated game is not evidence of a
  date — which is the mirror image of #53's ingest rule and agrees with the indexes for free,
  since IndexedDB doesn't index `undefined`. Unfiltered, those games are all still there.

#### The search index — `persist/searchIndex.ts`
Fuzzy name matching exists because **chess databases spell the same player several ways and those
are not typos**: Alekhine / Aljechin, Nimzowitsch / Nimzovich, Botvinnik / Botwinnik. `aljechin`
and `alekhine` share no prefix, so no prefix index can connect them.

- **Documents are the name vocabulary, not the games.** A search returns *tokens*, which
  `dbGames.ts` then looks up through `*names`. Measured on a synthetic 100k-game corpus (~33k
  distinct tokens): a document-per-game index serializes to **10.1 MB** and needs every row —
  ~76 MB of movetext — pulled out of IndexedDB to reach three header fields; the vocabulary index
  is **0.8 MB**, builds in ~0.2 s, and reads no records at all. It also keeps real pagination:
  games still come back through an index rather than as a truncated relevance list.
- **The "identical options" hazard is closed structurally.** `OPTIONS` is module-private and
  neither the build nor the load path takes options, so within a build they cannot differ. Across
  builds the stored index carries `INDEX_STAMP` — a fingerprint that includes the *source* of the
  function options, because `JSON.stringify` drops functions silently — and a mismatch discards
  and rebuilds. It errs towards rebuilding: minification changes function source, so an app
  update can rebuild an index whose options never changed. That is the safe direction.
- **A missing index is a rebuild, not an empty result.** A database attached before this existed
  has no stored index; so does one whose stored index is stale, unreadable, or built over a
  different number of games. Same failure class as the `names` backfill — silent, and it looks
  exactly like "you have no games by that player".
- The index is rebuilt after an import and on detach, but **the listing never waits for it**; a
  search issued mid-rebuild awaits the same build, so results are correct either way.

Opening a game goes through `App.tsx` (`openDbGame`), not through the database screen, because
that is the seam #55 hangs off: studying an imported game is building a `PackGame` from the row.

### Moving your history between profiles — `domain/historyArchive.ts` + `persist/historyArchive.ts` + `app/useHistoryTransfer.ts` (#152)
Same split again, and the same reason `persist/storage.ts` is *not* where this went: that module
is durability **within** a profile (it asks for persistent storage after you have made something
worth keeping). This is **portability**, which nothing addressed — IndexedDB is per-origin and
per-profile, so `localhost:5173` and `127.0.0.1:5173` do not share a byte.

**The games are the cheap part**, and the module's shape follows from that. Since #145 a re-sync is
one click; the analysis (#133) is minutes of engine per game and the **attempts** — answers, tiers,
and the reason typed before each reveal — have no source to be re-derived from at all. So the
attached database is behind its own switch, and its *analyses* travel whether or not it does.

- **The format is JSON Lines** — a header, a record per row, a footer — because `JSON.stringify`
  over 100k games builds the whole file as one string first, which is `content/pgnImport.ts`'s
  whole-file-in-memory mistake in the other direction. Both ends stream; the export folds lines
  into `Blob` parts so a large one leaves the JS heap.
- **An import reads the file twice.** Pass one validates the version, every record type and the
  footer's counts; pass two writes. That is what makes "refused whole, or applied whole" true
  rather than aspirational — a training history missing an unknown fraction of itself is worse
  than one that never arrived. Storage running out is the one exception and is reported as itself.
- **Idempotency is per-table and each answer is different.** `dbGames` gets it free from the dedup
  key (#128). An **attempt has no key at all**, so it is identified by its whole content
  canonically serialised — the only records that collapse are byte-identical ones, which errs
  towards keeping both. A played game's `gameId` is `m${Date.now()}`, unique on one machine and not
  across two, so a clash with a *different* game lands at `~1` deterministically instead of
  overwriting it.
- **Two fields on an analysis are load-bearing and must survive the trip.** `startFen`, because the
  dedup key hashes movetext but not the `[FEN]` tag, so an analysis is checked against the game now
  under its key and dropped on a mismatch — the same answer `getDbAnalysis` gives. And
  `analysisNodes`, because `gameAnalysis.supersedes` (#144) reads it: an import that lost the budget
  would make a 4M pass look like a 400k one.

### Studying an imported game — `domain/studyGame.ts` + `ui/Reveal.tsx` (#55, plan §11)
A mapping, not a mode. The guess session already runs on a `StudyGame` (which is what `PackGame`
now *is* — the pack stopped being the only source of one), so `domain/studyGame.ts` turns a
stored row into one: a title from the players, event and year, a PGN rebuilt from the columns it
was derived from, the file's comments, and the side you take. It consumes the row
**structurally** (`DatabaseGame`), the same trick `pgnImport.ts` uses for its parse tree, so the
domain still imports nothing.

- **Plan §11 said "no reducer change needed"; that is nearly true and worth knowing where it
  isn't.** Nothing about the machine's shape, actions or transitions moved, but `START_GAME` now
  reads `game.heroColor` before falling back to `heroColorFromResult`. The plan assumed the pack's
  world, where every game is decisive. `studySides` is the reason: a decisive game is studied from
  the winner's side, and a **draw, an unfinished game, or a file that recorded no result offers
  both sides and picks neither**. The fallback the pack can afford — no winner, so White — would
  quietly quiz you as White for most of the strong games in a real database.
- **A game *you* played is the case that rule gets backwards** (#130). The winner is the player
  worth imitating in content someone else made; in your own game you are the player being
  trained, so `yourSide` matches **the names you play under** (kept by `app/settings.ts` — a
  list, compared whole-name and case-insensitively, because a site writes your handle into the
  tag and a hand-made export writes `Lastname, Firstname`) and `studySides` puts that side
  first, with the other still offered. Nothing in grading moved and nothing needed to:
  `planStudy` grades against the engine rather than against the move played, so the side that
  lost is a session about your decisions. Side *selection* was the whole of what made the games
  most worth reviewing unreachable.
- **`planStudy` is the gate, and it exists because a row is not curated content.** It builds the
  quiz, throws it away, and returns the *count* — so the screen can promise "13 positions" before
  a session opens, and can refuse with a reason instead of opening an empty one. Three refusals:
  no moves, no decision for that side past the opening cutoff, and **movetext that doesn't
  replay**. That last one is only reachable because #53 deliberately never replays a game at
  import (~12 games/sec would make a 100k import a two-hour job), so this is the first code that
  ever tries — and inside the reducer it would have thrown during render.
- **A note from the file and our "why" are two attributed blocks, never one paragraph**
  (constitution §9/§12). `Annotations` carries `byPly` *and* its `source` in one value, and
  `annotationAt` returns both or neither, so there is no way to get the prose onto the screen
  without the name of the file it came from. `ui/Reveal.tsx` is its own module for exactly this
  — its test pins that the annotated reveal minus the note is byte-for-byte the un-annotated one,
  which is §11's "a game without comments reveals exactly as today" as an assertion rather than a
  hope.
- The count the screen promises comes from `harness`'s `DEFAULT_START_PLY` and the session quizzes
  from `sessionMachine`'s `OPENING_CUTOFF_PLY`. They are the same number and a test says so; if
  they drift, the promise is wrong on every imported game and nothing else notices.

### Application — `src/app/**`
Orchestration: **pure reducers/derivations** plus the hooks that bind them to async work.

- `sessionMachine.ts` — guess→commit→grade→reveal→next (guess mode). Unit-tested.
  `useGuessSession.ts` binds it to the engine + persistence.
- `playMachine.ts` — the play-vs-Maia loop: `yourTurn → thinking → over`, coach feedback,
  per-ply evals, take-back-a-pair, accuracy/take-backs. Unit-tested. `usePlaySession.ts` binds it
  to **Maia** (opponent) and **Stockfish** (coach), plus persistence.
- `useAnalyser.ts` — owns the one shared Stockfish worker for the app's lifetime. In `app`, not
  `ui`: it manages an engine lifecycle rather than rendering, and the session hooks consume it.
  While it sat in `ui`, `app` had to import *upward* to name `AnalyserState`.
- `replay.ts` (pure) — derivations for the replay screen: `buildReplayMoves`, `replayRows`,
  `coachAtCursor`, `clampCursor`, and `movesWorthStudying` (your worst moves only — a list
  dominated by the opponent's blunders would bury the point; moves the analysis couldn't measure
  are omitted rather than assumed fine).
- `gameAnalysis.ts` (pure) + `useGameAnalysis.ts` — the whole-game pass (#68): *coverage* at a
  uniform budget (`BATCH_NODES`) as opposed to the *depth* of a single-position analysis.
  Persists `evalByPly` and `startEval` plus `analysedAt`/`analysisNodes`, so a later pass can
  tell whether the stored work still counts; a partial run is kept but never marked complete
  (and, since #144, still records the budget it ran at, so it can only be topped up by a pass at
  the same one). **The budget is a bounded choice, and its bound is the honest part** (#144):
  `ANALYSIS_BUDGETS` offers 250k/400k/800k, `REFERENCE_NODES` is the 4M every measurement in this
  repo is stated against, and `trustworthyAbsences` is false for every budget a browser can
  afford — so a screen may report what a pass *found* and must not report what it did not.
  `supersedes` is the seam for an off-app deep pass: a stored complete pass at a deeper budget
  wins outright and no WASM search runs over it. `accuracyReport` is the accuracy
  figure everything *after* the game reads: Home (`useHomeStats.ts`) and both halves of
  `Library.tsx`, the stored-game table and replay. The play screen's post-game review is the
  one that doesn't — it reports `gameAccuracy` (`playMachine.ts`) off the live coach log, which
  is all a game that has just ended has behind it. They cannot drift in *method*, since both are
  `domain/accuracy.ts`'s `meanAccuracy` over win% swings, and each states what it covers. That
  pair — one rule underneath, coverage declared on top — is the invariant to hold, not "one
  calculation": #74 was Home and the library reporting different numbers for the same game
  because Home read the stored `accuracy` field, which is written once from the coach log and
  never rewritten when a later analysis pass scores every move.
- `blunderRate.ts` (pure) — the leading indicator over your stored games (#65). Decides which
  games may contribute: a *completed* pass that measured **every** move you played, and not a
  play-out, whose ply parity no longer says who moved. A game that misses the bar is reported
  as uncounted with the reason, which is what the library prints per row. `yourPlies` lives in
  `gameAnalysis.ts` so this and `accuracyReport` cannot disagree about which moves were yours.
- `usePositionAnalysis.ts` — analyse an arbitrary position on request (replay's "what should I
  have played here"), with the same stale-result guard the reducers use. Kept here rather than in
  a component so the staleness rule lives in one place.
- `useHomeStats.ts` — the Home cards' history counters, read from a count plus a short scan
  rather than by loading every stored game.
- `settings.ts` — analysis strength / lines-shown presets (pure), plus **the names you play
  under** (#130): the list itself and its `localStorage` round trip. `localStorage` rather than
  the IndexedDB adapter because it is a preference read *synchronously* while deciding which
  side a study control offers — a screen that awaited a database read would render the wrong
  side and correct itself. Whether a name matches a game is `domain/studyGame.yourSide`; only
  the list lives here, and it has no default.

### Ports & adapters — the edges
- `src/engine/analyser.ts` — the **`Analyser` port**. Grading depends only on it.
- `src/engine/stockfish.ts` — `StockfishAnalyser` adapter (WASM Worker, serialized UCI);
  `uci.ts` (pure parsers, also loaded by the Node scripts), `grading.ts` (evaluate best + played
  → win%-swing), `evalTable.ts` (parses Stockfish's `eval` piece-value grid — the closest a
  modern engine comes to explaining itself, and best read on a trade, where it prices both
  pieces).
- `src/engine/maia/` — the **`MaiaOpponent` port** (`opponent.ts`) + the **`MaiaOnnxOpponent`**
  adapter (`maiaOpponent.ts`) driving `maiaWorker.ts` (onnxruntime-web). `encoding.ts` (112-plane
  Lc0 tensor), `decoding.ts` (1858-move policy → legal moves), `policyIndex.ts`. **GPL,
  arm's-length.** `probeMain.ts` is **not part of the app**: it is the browser entry for the
  root-level `maia-probe.html`, a standalone page that exercises the whole in-browser path
  (module Worker + onnxruntime-web wasm + model fetch + encode/decode) so `e2e/maia-probe.spec.ts`
  can check it headlessly. [`vite.config.ts`](../vite.config.ts) adds it as a second build entry
  only under `MAIA_PROBE=1`, so a normal `npm run build` never ships it.
- `src/persist/storage.ts` — durability: requests persistent storage on the first game saved
  (after the user has made something worth keeping, not on load — browsers weigh engagement) and
  reports usage. IndexedDB is **not permanent by default** — Safari evicts script-written storage
  after ~7 days without interaction — so the library says whether it was granted rather than
  looking permanent.
- `src/persist/db.ts` — IndexedDB/Dexie adapter (attempts + games); best-effort, never throws.
  A stored game carries the coach's output (`coachLog`, `evalByPly`, `startEval`) so replay never
  re-analyses; those fields are **optional** because v0.2 records predate them. `kind`
  (`StoredGameKind` = `'game' | 'playout'`) separates a game played from move 1 from a position
  played out from somewhere else (#48) — also optional, so read it through **`gameKind()`**,
  which applies the `'game'` default in one place rather than leaving each caller to decide what
  `undefined` meant. Reads go through `listGames`/`getGame`/`lastGame`/`countGames`; `deleteGame`
  removes one. Two rules earned the hard way: saving a game is **one transaction** (two writers
  each read "no row" and each inserted, so a game appeared twice), and a save **merges** rather
  than replaces — the play session and the analysis pass write from separate snapshots, so a full
  `put` had each silently reverting the other's fields (#82). `saveAnalysis` re-reads inside the
  transaction and writes only its own fields.
- `src/persist/dbGames.ts` — the **attached PGN database** (#53): a `dbGames` table kept
  deliberately apart from the played-`games` table above, plus `dbSources` for what has been
  attached. The **dedup key is the primary key**, so re-importing a file overwrites row for row
  instead of doubling the database — which is what makes re-attaching after an eviction free
  rather than a merge problem. Writes are chunked (`BULK_CHUNK`, 500/tx) and, unlike the rest of
  persistence, a failed *write* is **reported**: an import that hits the quota at 40k of 100k
  games has to say so. Reads still degrade quietly. The schema lives in db.ts with every other
  table (version 3); the indexes declared there are the ones #54 will query.

### UI — `src/ui/**`
React adapter. `App.tsx` routes `home | maia-setup | maia | guess-pick | guess | library |
replay | database | database-game | review-pick | review-game` — Home is a card chooser, each mode gets a focused setup screen (`Screen`
supplies the title + back). `Review.tsx` is review mode (#144): the picker reuses #54's browse
*machinery* (`useDbBrowse` + `app/useReviewList.ts`, which adds the one thing an index cannot
answer — has this been analysed at this budget) while drawing its own table, and the review
screen runs the pass, states its cost and its limits before it starts, and offers either the
plies `reviewPlan` selected or the whole game. Both go through the ordinary `startGuess`;
`focusPlies` on `START_GAME` is the only thing the session machine learned. `YourNames.tsx` is
the shared "who are you" fold (#130), used by review and by the study control.
`Database.tsx` is the attach-a-PGN screen (#53): filters shown
*before* the import runs, per-reason skip counts after it, what is attached, and the note that an
import is never the only copy. It also holds `HistoryTransferPanel` (#152) — export and import the
history that cannot be re-fetched, with the size stated before a file is written and what a merge
did stated after. `MaiaMode.tsx` is the play screen + coach; `Analysis.tsx` holds the eval bar,
material strip and engine lines; `Library.tsx` is the stored-game table **and** the replay
screen — replay reads stored data by default but can drive the engine on request (one position,
or the whole-game pass). It also renders the **blunder rate** (#65) above the table, with its
sample and caveats in the same block and a per-row count so the total is checkable rather than
asserted; ADR [0027](decisions/0027-blunder-rate-as-the-leading-indicator.md) governs the
framing, and it is the feature. `format.ts` and `useBoardWidth.ts` are the shared trivia.

**Guess mode is almost the exception to that map: it has no file of its own.** Where every other
mode names a component, guess-the-move lives *inline in `App.tsx`* — `GamePicker`, `Play` (board +
reason + commit), `Summary`, and `StudyThisGame` (the control #54 left a `children` seam for,
which turns a database row into a session) with `YourNames` folded under it — the names you play
under sit on the study control rather than in the settings panel because this is the only screen
where knowing who you are changes anything (#130). There is no `GuessMode.tsx`; looking for one
is the obvious wrong turn. Note too that `Play` is the **guess** screen — the play-vs-Maia screen is
`MaiaPlay` in `MaiaMode.tsx`.

The one part that *did* get its own file is `Reveal.tsx`, and the reason is not size: it is where
an imported game's annotation sits next to our engine-derived "why", which is a claim about
authorship rather than a layout (#55, constitution §9/§12). A component you can render in a test
is what lets that be asserted instead of reviewed.

`BoardPanel.tsx` is **the board column every mode shares**: sizing, orientation, flip, eval bar,
material strip, plus a slot for per-screen controls. Guess, play and replay each had their own
copy and they drifted (replay shipped with no eval bar). Anything that belongs on "a board" goes
here so it can't reach only some screens.

`public/engine/` and `public/models/` hold vendored **Stockfish WASM** and the fetched **Maia
nets** (both GPL; see their `NOTICE.md`). Nets are fetched by `scripts/setup-maia.mjs`, not
committed — CI caches them and then *requires* them, which turned "nets missing → skip" into
"nets missing → fail".

## Off-app tooling — `scripts/`
**Node CLI tooling, not part of the browser bundle. Nothing in `src/` imports it** — the
dependency runs the other way, and only ever into pure leaf modules: `src/domain/*` plus the two
parsers `src/engine/uci.ts` and `src/engine/evalTable.ts`. It ships no UI and is invisible to
`npm run build`.

- `scripts/repertoire/` — the opening-repertoire pipeline (ADR
  [0021](decisions/0021-opening-repertoire-generator.md)). A **book builder** over the Lichess
  monthly dumps (`buildBook.mjs`, `decompress.mjs`, `verifyBook.mjs`); a **401M-position
  evaluation index** built from Lichess's eval dump and queried in sub-ms
  (`buildEvalIndex.mjs`, `evalKey.mjs`, `evalDb.mjs`, `verifyEvalDb.mjs`) — moves are gated on
  that index rather than on the crawl's own search, ADR
  [0024](decisions/0024-gate-on-a-local-evaluation-index.md); a **crawler** (`crawl.mjs`, one
  branch) and its whole-repertoire driver (`build.mjs`, every branch of a manifest); an
  **engine pool** (`enginePool.mjs`); a **deck stager** (`studyOrder.mjs`, `studyDecks.mjs`) that
  cuts the tree into prefix-closed tiers you learn in order; an **auditor**
  (`auditRepertoire.mjs`) that re-grades every shipped move against the index instead of the
  search that chose it; and a **cross-month replicator** (`replicate.mjs`) that keeps only traps
  which survive a second month — constitution §9's held-out set applied to the generator itself.
  Also ADRs [0025](decisions/0025-curated-lines-run-to-the-structure.md) (curated lines run to
  the structure) and [0026](decisions/0026-retire-the-tactic-gap-at-high-node-budgets.md) (the
  tactic-gap filter is off by default). **Detail lives in
  [../scripts/repertoire/README.md](../scripts/repertoire/README.md)** — read that rather than
  inferring the pipeline from here.
- `scripts/review/game.mjs` — engine-reviews one of the owner's finished games end to end
  (`npm run review`), over `src/domain/gameReview.ts`, `mistakeKind.ts` and `tablebase.ts`.
- `scripts/coach/` — the same grading over the *whole* chess.com archive (#137): `archive.mjs`
  grades every move the owner has played at the review's own 4M nodes and appends JSON-lines,
  resumable per game because a full run is hours; `assess.mjs` (`npm run coach`) prints the
  ranked report over `src/domain/coachReport.ts`. Ranked by **total win% given away**, never by
  error rate — frequency × severity is the question, and a rate ranks the rare-and-dramatic
  above the common-and-expensive. `coachReport.ts` **refuses a sample spanning two time
  classes** rather than trusting the caller to have split it. The process for coaching off the
  output, and the base-rate checks without which its tables produce confident wrong findings,
  is the `coach` skill (`.claude/skills/coach/`).
- `scripts/chesscom.mjs` — reading a player's public archive, shared by the two above. Extracted
  rather than copied at #137: two archive scans is two places for the "no public endpoint takes
  a game id" workaround to drift.
- `scripts/setup-maia.mjs` — fetches the Maia nets into `public/models/`.

Three things about this boundary:

- **`src/domain/repertoire*.ts` and `bookQuality.ts` are shared pure domain code the scripts
  import.** That is exactly why they live under `src/domain` and not under `scripts/`: they are
  judgment, so they belong where judgment is unit-tested, and they are covered by the app's test
  suite. The scripts are IO, orchestration and reporting around them. `vitest` also runs
  `scripts/**/*.test.mjs` (see [../vite.config.ts](../vite.config.ts)) — that code carries real
  logic and its defects have cost more than the app's — so `npm run verify` covers both sides of
  the line. One test reaches the other way on purpose:
  `src/domain/repertoirePlan.test.ts` validates the scripts' `manifest.*.json`, because a
  manifest with a coverage gap produces a repertoire that looks complete and has no answer to a
  common move.
- **`enginePool.mjs` is how a high node budget is afforded** without breaking the
  reproducibility rule `engine.mjs` documents: raising `Threads` makes a search unreproducible at
  fixed nodes, whereas running N separate single-threaded engines on separate positions leaves
  each search bit-for-bit what one engine would have done. Only for work whose positions are
  known up front — a crawl that chooses its next position from the last result cannot use it.
  Measured on a 50-move game: 4M nodes/position across six engines finished faster than 800k on
  one, and 800k was missing a real Tier B mistake, so the review's default budget is 4M.
- **`db/` and `out/` are gitignored and must stay that way** — third-party data (Lichess dumps,
  the eval index, crawl output) under their own licences. Measured 2026-08-14: **`db/` is 89 GB**
  and `out/` 22 MB, so effectively all of it is the source data rather than what we generate from
  it. Neither travels with the repo; **re-fetch before any crawl, book build or audit**. The
  *generated repertoire* is tracked, in [../repertoire/](../repertoire/) — that is our own
  output, not the source data.

## Where to make changes
- New **pure rule / calculation** → `src/domain/**` (+ test first).
- New **flow / state transition** → the relevant reducer (`sessionMachine` / `playMachine` /
  `gameAnalysis`), pure and tested; wire side effects in its hook.
- New **engine capability** → behind the `Analyser` or `MaiaOpponent` port; never import a
  Worker into domain code.
- New **screen / control** → `src/ui/**`, driven by hook state + handlers. Anything that belongs
  on "a board" → `BoardPanel.tsx`.
- New **source of games** → the judgment about what to fetch and keep in `src/domain/**`, the
  I/O in `src/content/**`, the storing in a hook — and then through the *existing*
  `normalizeGame` → `describeGame` → `filterGame` → `putDbGames` path. A second way into
  `dbGames` is a second set of rules about what a stored game is, and the dedup key stops
  deduplicating across them.
- New **offline/batch capability** → `scripts/**`, with any judgment it makes lifted into
  `src/domain` (runtime-import-free, or importing with an explicit `.ts` extension).

## Cross-cutting rules
- Grade by **win% swing → A/B/C**; engine-equal = A. **No speed metric** (constitution §9).
- **Glyphs share the tier boundaries** and wait for the uniform whole-game pass. Comparing evals
  recorded at two different budgets manufactures swings out of nothing, which is how a `?!` came
  to sit beside a move the coach had called good.
- Engine calls are **reproducible** (fixed nodes, never movetime; `ucinewgame` before each search
  offline, so a warm hash can't change an answer).
- **Engine/board sync by construction:** every engine result carries the FEN it was computed
  for, and the reducer drops it if the board has moved on. Never render engine output against
  a position it wasn't computed for.
- **Scores are always White's perspective** in the UI (bar, chip, move list, lines).
- Maia is the **opponent**, Stockfish the **referee** — never the reverse (ADR 0006).
- The LLM only ever **renders/grades the fact bundle** (ADR 0012).
- Keep the domain pure; keep both engines at arm's length (GPL + testability).
- Metrics describe **this game**, never implied transfer (constitution §9, §12) — and where a
  number covers only part of a game, it says so rather than implying it covers all of it.
- Stored records are **forward-compatible**: new fields are optional, and absent means "not
  recorded", never an error.

## Major features (v0.3.0)
Guess-the-move loop · play vs Maia (1100–1900, client-side) · ambient coach with "Show me" ·
win%-swing tiering · game library + replay (arrow keys, click any move) · whole-game analysis in
one pass · engine analysis on demand while reviewing · `?!`/`?`/`??` annotations · "Worth
studying" jump-to-position · persistent storage + delete + usage · accuracy + take-back count +
post-game review (by-phase, worst moments) · toggleable evaluation (bar, current score, per-move
scores) · engine alternatives (MultiPV) · click/drag + flip + promotion picker (guess mode) ·
SEE hanging detection · opening detection · draw/resign · local-first persistence of attempts
and games · Home as a mode chooser with live stats from your own history.

## Build, test, verify
`npm run dev` · `npm run verify` (typecheck→lint→test) · `npm run build` · `npm run test:e2e`
(Playwright) · `node scripts/setup-maia.mjs` (fetch the Maia nets before playing/e2e).
`npm test` covers `src/**` *and* `scripts/**/*.test.mjs`.

Off-app: `npm run review -- --me <chess.com user> --last` (engine-review your own last game;
takes a game URL/id or `--pgn <file>` instead, `--deep` for alternatives + WDL + per-piece values
+ tablebase, and `STOCKFISH_PATH` to point at a different binary) ·
`node scripts/coach/archive.mjs --me <user>` then `npm run coach` (grade the whole archive —
hours, resumable, `--limit` to try it — and rank where the win% goes) · `npm run rep:build` /
`rep:build:e4` (crawl the repertoire) · `rep:decks` (stage the study decks) · `rep:audit` ·
`rep:study` · `rep:verify` (assert the eval index is right). The `rep:*` scripts need `db/`
populated — see [../scripts/repertoire/README.md](../scripts/repertoire/README.md).

CI ([`.github/workflows/ci.yml`](../.github/workflows/ci.yml)) runs typecheck → lint → test →
build as **separate steps** — not `npm run verify`, which it never invokes — plus a second e2e
job, on every PR and every push to `main`, with the Maia nets cached and then required. `verify`
is the local gate; CI reproduces it step by step, so a failure names the stage that broke.
See [testing.md](testing.md), [dev-workflow.md](dev-workflow.md).

## What's next
Roadmap in [backlog.md](backlog.md), as **epics in priority order with no version numbers** —
a version is a *cut* we name when work comes off the backlog, never a slot we plan into (ADR
[0020](decisions/0020-backlog-of-epics.md)). Hardening was epic 1 and v0.3.0 was that cut, so
the top is now **epic 2 — bring your own game database** (#53 → #54 → #55, plus #70; designs in
[v0.3.0-plan.md](v0.3.0-plan.md) §9–11): we ship **no** corpus (ADR
[0018](decisions/0018-games-corpus-and-annotations.md)), users attach their own. Then the
**"why" layer**, which needs that corpus to seed its grounding ontology. The adaptive skill model
stays **last** (ADR 0007).
