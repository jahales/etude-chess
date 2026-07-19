# Research: what actually makes a chess training app effective

> Research digest, 2026-07-18 (rev. 2 — adds §0.5 chunk-encoding foundation, §7 the
> semantic "why" gap, §8 Maia as game-generator). Applied product-layer companion to
> [../learning-science.md](../learning-science.md) (which covers the underlying cognitive
> science). Evidence is tagged: **[SOLID]** controlled/large-N · **[PRACTITIONER]**
> structured but uncontrolled · **[REASONED]** expert reasoning · **[CONSENSUS]** broad
> user/coach agreement · **[VENDOR]** self-reported marketing.

## 0. The finding that should reshape our priorities

**Southwick, Harwell, Wright, Olsen & Ogles (2026), "Not All Practice Is Created
Equal," *Psychological Science*, N = 44,213** Chess.com players, time-stamped activity
vs. rating over 6 months. **[SOLID]** Per-hour rating gains:

| Activity               | Rating pts / hour                       |
| ---------------------- | --------------------------------------- |
| Video lessons          | **5.21**                                |
| Game review / analysis | **4.41**                                |
| Playing rapid games    | 0.86                                    |
| **Tactics puzzles**    | **0.73** — statistically ≈ just playing |

Deliberate-practice activities were **~3.6× more efficient** than gameplay — yet players
spent **~90%** of their time playing, ~4% on puzzles, ~1% on lessons.
Source: <https://journals.sagepub.com/doi/full/10.1177/09567976261452568>

**Read the study honestly before acting on it.** It is *observational* — "associated
with," no randomization — so some of the video/lesson advantage is selection (serious
learners choose lessons), not causation. And "lessons" is a single undifferentiated
bucket; on Chess.com the *Lessons* product is short video **+ an immediate interactive
position you must solve.** The likely active ingredient in the top row is therefore
**video-with-forced-retrieval, not passive watching** — which makes it the same
recall-first mechanism driving every other high-yield row, not a separate phenomenon.
Design implication: never ship passive video; always gate it behind a commit-a-move step.

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

## 0.5 Why repetition works — and what it must repeat

> Added rev. 2. This is the *scientific backbone* under §2 and §3. It also settles the
> most common misconception about our own design ("isn't Woodpecker good *because* it
> burns positions into memory?").

**Expertise is memory — but not the memory people assume.** The classic literature is
unambiguous that mastery *is* a large stored library, not faster calculation. De Groot
(*Thought and Choice in Chess*, 1946/1965) found strong and weak players search to
similar depth and breadth; the master simply *perceives* better moves immediately.
Chase & Simon ("Perception in Chess," *Cognitive Psychology*, 1973) explained why:
experts store tens of thousands of recurring board *configurations* (chunks). Shown a
real position for five seconds, a master reconstructs it near-perfectly; shown **random**
pieces, the advantage largely collapses — the skill is pattern storage, not general
visual memory. (Gobet & Simon, 1996, later showed a small but reliable residual
advantage even on random boards, from partial chunk overlap — which *strengthens* the
chunk account rather than weakening it.) **[SOLID]**
And Charness et al. (*Applied Cognitive Psychology*, 2005) found cumulative **serious,
often solitary study** — not tournament play — the single strongest predictor of rating.
**[SOLID]**

**So the instinct "burn patterns into long-term memory" is correct at the root. The
error is the *unit* being stored.** Repetition can encode either of two things:

- **The specific position** — that exact FEN, that exact solution. Episodic, and nearly
  worthless: you will never see that board again. This is what repeating an identical
  puzzle trains.
- **The motif** — deflection, the overloaded defender, the back-rank geometry —
  *abstracted across many different boards that share it.* This is the transferable
  chunk, and it is what actually appears over the board.

Repeating the same position trains the first; repeating the same *motif with a fresh
position each rep* trains the second. This is the entire basis for the §3 rule "store the
motif as the card; draw a fresh position each review."

**What this makes of Woodpecker.** Its famed results are usually credited to same-position
repetition and its shrinking intervals. On the evidence, those are the *weakest* parts:
identical-FEN repetition trains episodic recall, and *decreasing* intervals contradict
~40 years of spacing research favoring *expanding* ones (§3). Woodpecker's real active
ingredients are (a) **adherence** — a fixed set with a countdown actually gets finished
(Solon's point) — and (b) **within-cycle motif density** — one pass hits the same motif
across dozens of *different* boards, and that cross-position exposure builds the chunk
almost as a side effect. **It works *despite* its packaging, not because of it.** Our
design keeps the two real ingredients (density, completa­ble sets) and discards the two
incidental ones (identical positions, contracting intervals). **[REASONED]**

## 1. What existing apps get right / wrong

| App                         | Core mechanic                                     | Strength                                                     | Weakness                                                                           |
| --------------------------- | ------------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| **Chessable** (MoveTrainer) | Books → SRS move-by-move                          | Best for opening *retention*                                 | Recalls the *exact line*, not understanding; over-memorization past a 1200's needs |
| **Aimchess**                | Analyzes *your* games → weakness metrics → drills | Closes the feedback loop; good for plateaued players         | Clunky UX; diagnoses well but you still do the work                                |
| **Chess.com**               | Puzzles / Lessons / Insights                      | Lessons + Insights map to the high-yield activities in §0    | Free puzzles capped; paywalled; puzzle volume is the low-yield part                |
| **Lichess**                 | Free puzzles, Streak, Practice, Studies           | Free, unlimited, real-game puzzles; Studies underrated       | Minimal scaffolding/explanations                                                   |
| **Chess Tempo**             | Themed tactics **with real SRS** + endgames       | Precise difficulty; resurfaces *your* failures               | Dated UI                                                                           |
| **Listudy / Chessdriller**  | Each repertoire move = an SRS card                | "Play against your repertoire" is exactly right for openings | Thin content                                                                       |
| **Disco Chess**             | Woodpecker cycles + SRS on misses (1/3/7/14/30d)  | Operationalizes Woodpecker + SRS                             | Repeating exact positions → overfitting critique (§3, §0.5)                        |

**Cross-app pattern:** the apps that best match the §0 evidence (Aimchess, Chess.com
Insights/Lessons, Lichess Studies) all **connect training to the user's own game
mistakes.** Pure puzzle/line-volume apps are engaging but low-yield.
Sources: <https://www.chessable.com/movetrainer/> · <https://www.raindropchess.com/aimchess-review-does-personalized-chess-training-actually-work/> · <https://circlechess.com/blog/is-chesscom-worth-it-for-serious-chess-improvement-in-2026/>

## 2. The puzzle-rating vs. real-improvement gap

Real and large — users routinely report puzzle ratings 500–950 pts above game rating. **[CONSENSUS]** Why it doesn't transfer:

1. **You're told a tactic exists.** In a game the hard skill is *noticing* a position is
tactical at all. Puzzles train solving; games require detection.
2. **No clock, no fatigue, no opportunity cost.**
3. **Tactics are a slice**, not the whole game.
4. **§0 quantifies it:** puzzles ≈ playing (0.73 pts/hr). **[SOLID]**

Practitioner corroboration: Justesen's 14-day study (n=89) — Puzzle *Rush* beat *Storm* (timed Storm "enforces guessing"); **high-volume solvers improved least**; no transfer to
games demonstrated. **[PRACTITIONER]** <https://saychess.substack.com/p/will-14-days-of-puzzle-rush-or-storm>

**Mitigations we should build in:** puzzles from the user's *own* games/blunders; **untimed, full-calculation** formats over speed; **detection drills** ("is there a tactic
here — yes/no/nothing?"); force a **why/verbalize step before reveal**; curate by **pattern/theme** (fresh instance each rep, not the identical FEN); tie every miss back to
the game it came from.

## 3. Spaced repetition, applied to chess — the key subtlety

**Recalling a position ≠ learning the pattern** (the §0.5 episodic-vs-chunk distinction,
applied). Repeating the *same* FEN risks **overfitting** — you memorize a position you'll
never see again instead of the transferable motif. Nate Solon's critique (GM-level coach):
Woodpecker's famed results are likely **survivorship anecdotes**, and its real mechanism is
**adherence** ("the best tactics are the ones you'll actually do"); its *decreasing*
intervals also contradict ~40 years of spacing research favoring *increasing* intervals.
**[REASONED]** <https://www.zwischenzug.gg/p/the-woodpecker-method-revisited> · <https://www.zwischenzug.gg/p/spaced-repetition>

**By content type:**

- **Openings / endgames:** discrete, "one right move" → SRS is a *good* fit. Prefer
**FSRS** (models retrievability/stability/difficulty; ~20–30% fewer reviews than SM-2 on
Anki data; avoids SM-2 "ease hell") or simple **Leitner**. Drill by **playing against
your repertoire**, not reading it. **[SOLID for Anki benchmark; REASONED for chess]** <https://flica.app/article/fsrs-vs-sm2>
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
teaches a 1200 nothing — say *why*: undeveloped piece, weak king, hanging pawn — see §7);
surface only **decisive moments**, not every 0.3 inaccuracy; explanations, not just answers.
<https://www.chessworld.net/chessclubs/openingguide/how-to-analyze-with-engines.asp>
- **Gamification:** reliably boosts *engagement*; effect on *learning* is weak and
design-dependent, and worse when heavily competitive. Two chess-specific risks:
**overjustification** (extrinsic rewards erode intrinsic interest) and **rating-avoidance** (leaderboards make players dodge hard, high-learning games). **Design rule:** gamify the
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
that Charness et al. found to be the single best predictor of skill (§0.5). **[SOLID for the
category]** The multiplier for both is **active vs. passive**: watching/reading is low-yield;
*committing your move before the reveal* (solitaire chess / guess-the-move, the Move-by-Move
format) is the retrieval-first version. Solon independently recommends the format. **[REASONED]** <https://zwischenzug.substack.com/p/solitaire-chess>
- **Density favors master games per session:** every move is a graded retrieval event (~25–35
per game) vs. ~3 coached moments from reviewing one played game.

**Prior-art note:** guess-the-move exists (ChessTempo, chessgames.com premium, Lucas Chess) and
is a recurring unfulfilled request on Chess.com — but every implementation grades "matched the
master's move" (engine-equal alternatives marked wrong), captures no justification, and coaches
no why (§7). <https://chesstempo.com/guess-the-move/> · <https://www.chess.com/forum/view/help-support/guess-the-move-feature>

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

## 7. The semantic gap: engines give the "what," not the transferable "why"

> Added rev. 2. This is, on reflection, the intellectual core of what etude-chess is —
> and the reason a Stockfish-plus-Maia trainer alone has a hole where the teaching goes.
> Companion detail lives in [llm-integration.md](llm-integration.md).

An engine supplies the **what** (best move) and the **how-much** (eval delta). It is
essentially incapable of supplying the **why in transferable language.** "−1.4," or even
"Nd5 is best," teaches a 1400 nothing. The pedagogical payload — *"Nd5 is an outpost no
pawn can ever challenge, and it trades off his only active piece"* — has never lived in
engines. It lives in **literature**: Silman's imbalances, the Move-by-Move Q&A format,
Dvoretsky, Watson. Every trainer built purely on engine output inherits this
**semantic hole.** **[REASONED]**

The subtle part that makes this both hard and valuable:

- **The engine's reason and the teacher's reason are often not the same thing.** The
  engine's "true" cause may be a 20-ply concrete line. The teacher's cause is a
  *generalizing verbal principle.* For a sub-~1800 player the **teacher's version is more
  useful even when the concrete line is the real cause**, because the principle transfers
  to the next position and the line does not. Our job is therefore not to *surface the
  engine's reason* — it's to produce the **pedagogically optimal explanation**, a
  genuinely different artifact.
- **A confidently wrong explanation is worse than none** for a learner who can't detect
  the error. This constrains how we generate the "why."

**Three sourcing routes for the "why":**

| Route | Scales? | Honest/authoritative? | Problem |
| --- | --- | --- | --- |
| LLM-generated free-form | ✅ | ⚠️ | confident hallucination, undetectable by target user |
| Curated from literature | ❌ | ✅ | annotations are copyrightable — can't ingest Silman/Dvoretsky |
| **Hybrid: LLM grounded in a concept ontology** | ✅ | ✅ | **requires building the ontology (annotation labor)** |

The **hybrid** — LLM explanation anchored to a real conceptual ontology (priyome families,
imbalance types) and cross-checked against the engine line for factual consistency — is the
only route that both scales and stays honest. Its cost is that **building the grounding
ontology is the same annotation-labor bottleneck** flagged for the positional taxonomy.
That bottleneck now shows up **twice** (taxonomy + explanation grounding), which is a strong
signal it is *the* project bottleneck and deserves dedicated tooling (semi-automated seeding
from CC0 master-game annotations, human spot-check).

**Product consequence:** a guess-the-move that grades correct/incorrect is a commodity. One
that explains *why*, in transferable language, is the thing that does not exist. The "why"
layer is worth more than any additional mode — see [../development-focus.md](../development-focus.md).

## 8. Maia as game-generator: strong, with one systematic blind spot

> Added rev. 2. Relevant because "play a game you can then review" is the upstream step the
> whole review loop depends on, and Maia is our engine for it. Engine mechanics in
> [engines.md](engines.md).

**Maia is the right sparring engine.** It is trained to predict *human* moves, so it makes
human-like mistakes a learner can practice punishing, and the positions it produces are
representative. Reduced-strength Stockfish is the wrong tool: it blunders *inhumanly*
(random drops, not human errors), so you learn to punish things you will never see. **[REASONED]**

**But Maia systematically under-samples one error class — and it's a big one below ~1600:
pressure errors.** No rating stakes, no tilt, no fatigue, no "move 35 and I'm tired," no
fear of losing points. A large fraction of sub-1600 rating loss is not knowledge gaps —
it's blunders under exactly those conditions, and Maia cannot manufacture them because the
conditions aren't present. So Maia yields a clean sample of a player's **technical** errors
and almost none of their **psychological** ones.

Two smaller caveats: base Maia plays **endgames unreliably** (don't mine Maia games for
endgame technique — use tablebase/Syzygy positions instead); and it is largely
**deterministic**, which is why pre-playing or randomizing the opening is necessary or the
user grooves a single structure.

**Design consequence — three stimuli, three jobs (do not blur them):**

| Stimulus | Trains | Role |
| --- | --- | --- |
| **Timed Maia** (per-move or total-budget clock) | pattern speed + decision-under-constraint; partial fix for the pressure-error gap | the sustainable, always-available default |
| **Correspondence Maia** (over days) | deep calculation + planning (the depth skill Woodpecker doesn't touch) | occasional; the *opposite* stimulus to timed |
| **Occasional real rated game** | the honest error sample, **including the psychological errors Maia can't produce** | periodic calibration; don't let Maia fully replace stakes |

A no-clock engine removes decision-under-constraint entirely, so an **imposed decision
clock is the cheapest single thing that restores it** — start with a flat per-move cap,
graduate to a total-time budget (which also trains "is this position critical enough to
spend on?" allocation).

**Cheap position generation:** starting a Maia game (or a guess-the-move) from a **rich
middlegame position drawn from a real master game** — rather than move 1 — is a strict
time-efficiency win, inherits a position with actual content, and serves both modes
(predict-the-master and play-it-out-vs-Maia). For a time-constrained user this is the
workhorse for manufacturing decision-dense, review-worthy positions.

### Key sources

- **[SOLID]** Southwick et al. 2026, *Psychological Science*, N=44,213 — <https://journals.sagepub.com/doi/full/10.1177/09567976261452568>
- **[SOLID]** de Groot, *Thought and Choice in Chess* (1946/1965) — perception, not search, distinguishes masters
- **[SOLID]** Chase & Simon, "Perception in Chess," *Cognitive Psychology* 4 (1973) — chunking; the random-position control
- **[SOLID]** Gobet & Simon (1996) — template theory; the small residual random-position effect
- **[SOLID]** Charness et al., "The role of deliberate practice in chess expertise," *Applied Cognitive Psychology* 19 (2005) — serious study as the top predictor
- **[PRACTITIONER]** Justesen 14-day puzzle study — <https://saychess.substack.com/p/will-14-days-of-puzzle-rush-or-storm>
- **[REASONED]** Solon, *Zwischenzug* — <https://www.zwischenzug.gg/p/the-woodpecker-method-revisited> · <https://www.zwischenzug.gg/p/spaced-repetition> · <https://zwischenzug.substack.com/p/solitaire-chess>
- FSRS vs SM-2 — <https://flica.app/article/fsrs-vs-sm2>
- Engine-as-crutch / hybrid analysis — <https://www.chessworld.net/chessclubs/openingguide/how-to-analyze-with-engines.asp>
- Aimchess review — <https://www.raindropchess.com/aimchess-review-does-personalized-chess-training-actually-work/>
