# Research: what actually makes a chess training app effective

> Research digest, 2026-07-17. Applied product-layer companion to
> [../learning-science.md](../learning-science.md) (which covers the underlying
> cognitive science). Evidence is tagged: **[SOLID]** controlled/large-N ·
> **[PRACTITIONER]** structured but uncontrolled · **[REASONED]** expert reasoning ·
> **[CONSENSUS]** broad user/coach agreement · **[VENDOR]** self-reported marketing.

## 0. The finding that should reshape our priorities

**Southwick, Harwell, Wright, Olsen & Ogles (2026), "Not All Practice Is Created
Equal," *Psychological Science*, N = 44,213** Chess.com players, time-stamped activity
vs. rating over 6 months. **[SOLID]** Per-hour rating gains:

| Activity | Rating pts / hour |
|---|---|
| Video lessons | **5.21** |
| Game review / analysis | **4.41** |
| Playing rapid games | 0.86 |
| **Tactics puzzles** | **0.73** — statistically ≈ just playing |

Deliberate-practice activities were **~3.6× more efficient** than gameplay — yet players
spent **~90%** of their time playing, ~4% on puzzles, ~1% on lessons.
Source: https://journals.sagepub.com/doi/full/10.1177/09567976261452568

**Two consequences for etude-chess:**
1. **The biggest lever is structured *game review*, not a better puzzle engine.** The
   market over-invests in puzzles (cheap, engaging, *low-yield*) and under-invests in
   guided mistake-review (hard, *high-yield*). That gap is our opening.
2. **Puzzle-grinding barely moves ratings on its own.** This is the empirical backbone
   of the transfer gap (§2). Nuance: it measures puzzles *as casually used*, not our
   anti-overfitting design — but it's a strong prior that "add more puzzles" is not the
   answer. (Myth-flag: blog citations of a "Stanford 96,000-player study" are a
   misattribution of *this* 44,213-player paper. Cite the real one.)

This directly motivates ADR [0011](../decisions/0011-game-review-first.md): lead v0.1.0
with a personalized game-review loop, and make tactics/opening/endgame drills *downstream*
of it, sourced from the user's own mistakes.

## 1. What existing apps get right / wrong

| App | Core mechanic | Strength | Weakness |
|---|---|---|---|
| **Chessable** (MoveTrainer) | Books → SRS move-by-move | Best for opening *retention* | Recalls the *exact line*, not understanding; over-memorization past a 1200's needs |
| **Aimchess** | Analyzes *your* games → weakness metrics → drills | Closes the feedback loop; good for plateaued players | Clunky UX; diagnoses well but you still do the work |
| **Chess.com** | Puzzles / Lessons / Insights | Lessons + Insights map to the high-yield activities in §0 | Free puzzles capped; paywalled; puzzle volume is the low-yield part |
| **Lichess** | Free puzzles, Streak, Practice, Studies | Free, unlimited, real-game puzzles; Studies underrated | Minimal scaffolding/explanations |
| **Chess Tempo** | Themed tactics **with real SRS** + endgames | Precise difficulty; resurfaces *your* failures | Dated UI |
| **Listudy / Chessdriller** | Each repertoire move = an SRS card | "Play against your repertoire" is exactly right for openings | Thin content |
| **Disco Chess** | Woodpecker cycles + SRS on misses (1/3/7/14/30d) | Operationalizes Woodpecker + SRS | Repeating exact positions → overfitting critique (§3) |

**Cross-app pattern:** the apps that best match the §0 evidence (Aimchess, Chess.com
Insights/Lessons, Lichess Studies) all **connect training to the user's own game
mistakes.** Pure puzzle/line-volume apps are engaging but low-yield.
Sources: https://www.chessable.com/movetrainer/ ·
https://www.raindropchess.com/aimchess-review-does-personalized-chess-training-actually-work/ ·
https://circlechess.com/blog/is-chesscom-worth-it-for-serious-chess-improvement-in-2026/

## 2. The puzzle-rating vs. real-improvement gap

Real and large — users routinely report puzzle ratings 500–950 pts above game rating.
**[CONSENSUS]** Why it doesn't transfer:
1. **You're told a tactic exists.** In a game the hard skill is *noticing* a position is
   tactical at all. Puzzles train solving; games require detection.
2. **No clock, no fatigue, no opportunity cost.**
3. **Tactics are a slice**, not the whole game.
4. **§0 quantifies it:** puzzles ≈ playing (0.73 pts/hr). **[SOLID]**

Practitioner corroboration: Justesen's 14-day study (n=89) — Puzzle *Rush* beat *Storm*
(timed Storm "enforces guessing"); **high-volume solvers improved least**; no transfer to
games demonstrated. **[PRACTITIONER]** https://saychess.substack.com/p/will-14-days-of-puzzle-rush-or-storm

**Mitigations we should build in:** puzzles from the user's *own* games/blunders;
**untimed, full-calculation** formats over speed; **detection drills** ("is there a tactic
here — yes/no/nothing?"); force a **why/verbalize step before reveal**; curate by
**pattern/theme** (fresh instance each rep, not the identical FEN); tie every miss back to
the game it came from.

## 3. Spaced repetition, applied to chess — the key subtlety

**Recalling a position ≠ learning the pattern.** Repeating the *same* FEN risks
**overfitting** — you memorize a position you'll never see again instead of the transferable
motif. Nate Solon's critique (GM-level coach): Woodpecker's famed results are likely
**survivorship anecdotes**, and its real mechanism is **adherence** ("the best tactics are
the ones you'll actually do"); its *decreasing* intervals also contradict ~40 years of
spacing research favoring *increasing* intervals. **[REASONED]**
https://www.zwischenzug.gg/p/the-woodpecker-method-revisited ·
https://www.zwischenzug.gg/p/spaced-repetition

**By content type:**
- **Openings / endgames:** discrete, "one right move" → SRS is a *good* fit. Prefer
  **FSRS** (models retrievability/stability/difficulty; ~20–30% fewer reviews than SM-2 on
  Anki data; avoids SM-2 "ease hell") or simple **Leitner**. Drill by **playing against
  your repertoire**, not reading it. **[SOLID for Anki benchmark; REASONED for chess]**
  https://flica.app/article/fsrs-vs-sm2
- **Tactics:** SRS the **motif and your failures**, with *fresh instances*, not the exact
  position. "Return to failed items at 1/3/7 days" is the practical sweet spot.
- **Positional / strategic:** SRS is a **poor fit** (abstract, non-discrete) — use worked
  examples, guided review, free recall instead.

**Takeaway:** schedule by the underlying *pattern and the learner's error*, not the literal
position. Store the motif as the card; draw a fresh position each review.

## 4. Session & feedback design

- **Session length:** focused, short, *complete* units (10–20 min) beat open-ended
  grinding; diminishing returns after ~90 min. **[PRACTITIONER]**
- **Feedback:** immediate + honest is the definition of deliberate practice — **but** apply
  the desirable-difficulty rule: make the learner **commit an answer and articulate the
  why *before* the reveal.** Instant reveal with no retrieval attempt is the engine-crutch
  trap (feels like learning, isn't).
- **Presenting engine eval without it becoming a crutch** (strong **[CONSENSUS]**): gate the
  engine behind the user's own attempt; **translate eval into human language** (raw "−1.4"
  teaches a 1200 nothing — say *why*: undeveloped piece, weak king, hanging pawn); surface
  only **decisive moments**, not every 0.3 inaccuracy; explanations, not just answers.
  https://www.chessworld.net/chessclubs/openingguide/how-to-analyze-with-engines.asp
- **Gamification:** reliably boosts *engagement*; effect on *learning* is weak and
  design-dependent, and worse when heavily competitive. Two chess-specific risks:
  **overjustification** (extrinsic rewards erode intrinsic interest) and **rating-avoidance**
  (leaderboards make players dodge hard, high-learning games). **Design rule:** gamify the
  *behavior the evidence rewards* (a streak for **reviewing a game**, not for solving 100
  fast puzzles); reward consistency/mastery, not speed/rank; keep competition optional.

## 5. Opening training that ISN'T rote memorization (the "don't take damage" goal)

For a ~1200, the goal is reaching a playable middlegame, not theory. **[CONSENSUS + REASONED]**
1. **Principles + threat-checking over lines:** center, rapid development, castle early,
   "what is my opponent threatening?" before each move — prevents most sub-1400 opening
   disasters.
2. **Narrow scope:** one White opening + one reply each to 1.e4 / 1.d4, **3–5 moves deep,
   plans only.** Depth beyond that is wasted at this level.
3. **Trap *avoidance* as pattern recognition** (Scholar's, Fried Liver, Légal, Englund,
   early …Qh4/Qa5) — the defensive idea, not a memorized line.
4. **Structure & plan recognition:** "in this pawn structure your plan is X" — a plan for
   when you leave book (which, for a 1200, is move ~4).
5. **Drill the repertoire by *playing against it* as SRS cards** (Listudy model), then test
   in a game and patch the leak.

**Market gap:** almost nobody teaches *plans, structures, and trap-defense* well for
beginners — most tools just drill *moves*. That's an opening for etude-chess.

## 5b. Master-game study (guess-the-move) vs. reviewing your own games

Different jobs, both high-yield — **not** interchangeable ROI:
- **Your own games** fix *your* leaks (the Southwick 4.4 pts/hr figure is own-game review).
  Highest value for what's actively losing you points, especially below ~1800.
- **Master games** build the pattern library you don't have yet — this is the "serious study"
  that Charness et al. found to be the single best predictor of skill. **[SOLID for the
  category]** The multiplier for both is **active vs. passive**: watching/reading is low-yield;
  *committing your move before the reveal* (solitaire chess / guess-the-move, the Move-by-Move
  format) is the retrieval-first version. Solon independently recommends the format. **[REASONED]**
  https://zwischenzug.substack.com/p/solitaire-chess
- **Density favors master games per session:** every move is a graded retrieval event (~25–35
  per game) vs. ~3 coached moments from reviewing one played game.

**Prior-art note:** guess-the-move exists (ChessTempo, chessgames.com premium, Lucas Chess) and
is a recurring unfulfilled request on Chess.com — but every implementation grades "matched the
master's move" (engine-equal alternatives marked wrong), captures no justification, and coaches
no why. https://chesstempo.com/guess-the-move/ ·
https://www.chess.com/forum/view/help-support/guess-the-move-feature

## 6. Prioritized recommendations (highest evidence-backed impact first)

1. **A frictionless game-review loop keyed to the user's own games.** Import games →
   auto-surface 2–4 decisive moments → **guess the better move before reveal** → explain
   *why* in human terms. Highest per-hour yield in §0; most under-served. **This is the
   core, not an add-on.** → v0.1.0.
2. **Weakness diagnosis → targeted drills.** Tag recurring error types from those games;
   route to specific practice. (Aimchess proves demand.)
3. **Pattern-based tactics from the user's own misses** — untimed, retrieval-first,
   fresh instances of the failed motif, plus detection drills. Puzzles done the way the
   evidence supports.
4. **A lightweight opening *safety* module** (plans & traps, not theory), drilled by
   playing against your repertoire.
5. **FSRS/Leitner SRS for openings & endgames only** — not for tactics/strategy.

**Mistakes to avoid:** building a puzzle-grinder (low-yield, saturated); equating engagement
with learning; SRS-ing literal tactic positions (overfitting); letting the engine answer
before the user attempts; over-teaching openings; dumping raw eval on a beginner; rewarding
speed; believing survivorship "+400 points" marketing.

**Thesis:** the winning product for a 1200 is **not a better puzzle app** — it's a
frictionless *"review your own games → diagnose real weaknesses → drill the exact pattern
with fresh instances and retrieval-first feedback → verify in a game"* loop, with SRS
reserved for openings/endgames and gamification pointed at the review habit.

### Key sources
- **[SOLID]** Southwick et al. 2026, *Psychological Science*, N=44,213 — https://journals.sagepub.com/doi/full/10.1177/09567976261452568
- **[PRACTITIONER]** Justesen 14-day puzzle study — https://saychess.substack.com/p/will-14-days-of-puzzle-rush-or-storm
- **[REASONED]** Solon, *Zwischenzug* — https://www.zwischenzug.gg/p/the-woodpecker-method-revisited · https://www.zwischenzug.gg/p/spaced-repetition
- FSRS vs SM-2 — https://flica.app/article/fsrs-vs-sm2
- Engine-as-crutch / hybrid analysis — https://www.chessworld.net/chessclubs/openingguide/how-to-analyze-with-engines.asp
- Aimchess review — https://www.raindropchess.com/aimchess-review-does-personalized-chess-training-actually-work/
