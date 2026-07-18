# Constitution

> The non-negotiable principles. These govern every later design and implementation
> decision. Changing one is not a bug fix — it is a deliberate amendment, and it
> should come with a new or superseding ADR in [decisions/](decisions/).
>
> Living, but *heavy*: everything else in the repo is free to change as we learn;
> this file changes only on purpose.

## Principles

1. **Train judgment, not memory of lines.** No memorizing book theory. Every item is
   "given this position, make a judgment." Openings are trained as structures, plans,
   and traps — never as move sequences to recall. The one sanctioned exception is
   procedural **technique** (Lucena, Philidor, opposition…), which is an algorithm
   with a proof, quarantined into its own mode.

2. **The mode is hidden in the mixed queue.** Acquisition may be blocked by mode;
   transfer is always tested with the mode concealed. We never build a feature that
   leaks "this is a tactic" before the solver has judged the position. This is the
   product's reason to exist.

3. **Grade tiers, not rankings.** Candidate moves are bucketed (A: playable / B:
   concession / C: structurally bad) with an eval-gap requirement. We never grade a
   full ordering — engine ordering within a tier is an artifact that flips with depth
   and version. A-vs-C discrimination is weighted heavier than A-vs-B.

4. **Distractors come from humans, not the engine.** Candidate moves are sourced from
   *human move frequency* (Lichess / masters data), then scored by the engine. The
   curation signal is **frequency-weighted regret** — a natural move many players make
   that quietly costs eval. Never source candidates from engine top-N; that yields
   four good moves and no temptation.

5. **A justification is required, and it is telemetry.** The solver states the key
   feature / plan before or with the move. This is not decoration — it is the second
   signal channel that makes the skill model *identifiable* (right-feature/wrong-move
   ⇒ calculation; wrong-feature/right-move ⇒ a guess we must not credit).

6. **Filter out tactics wearing a trenchcoat.** Any "positional" item must survive a
   check that no short forcing line explains its eval gap (shallow-vs-deep eval
   agreement, or explicit forcing-line search). If a concrete line explains it, it is
   a concrete item, not an evaluative one.

7. **Play humans, grade with the engine.** The sparring opponent is Maia (a
   human-move predictor), not reduced-strength Stockfish (which blunders inhumanly).
   Stockfish/Syzygy is the referee, never the opponent.

8. **Schedule families, not positions** (for evaluative work). Rep 2 of a theme is a
   *different* member of the same family, forcing re-derivation. Position-level recall
   is the failure mode we are designing against, not the goal. (Concrete/technique
   modes are exempt — there, recall *is* the goal.)

9. **Hold out a test set.** For every evaluative family, reserve a slice that is never
   drilled, and measure against it. It is the only way to tell "learned the priyome"
   from "memorized N cards." Speed-and-accuracy dashboards from the tactics side are
   forbidden on evaluative material — they measure card recognition and will look
   fantastic while meaning nothing.

10. **ROI-weighted and band-conditional, not balanced.** "Balance all skills" is the
    wrong objective; below ~1800 tactics dominate results, so balanced training for a
    1300 is malpractice. Training priority is weighted by rating band and expected
    return, and those weights are something we learn from data, not assume.

11. **Content before adaptivity.** The scheduler and skill model are worthless without
    a dense, annotated item pool. Ship band-fixed curricula first; build the adaptive
    engine last, on top of the data the curricula generate.

12. **Be honest about the ceiling.** We state what the system cannot train (clock,
    calculation stamina, practical defense) and we do not let a metric imply transfer
    we haven't measured. Elegance of design is not evidence of efficacy.
