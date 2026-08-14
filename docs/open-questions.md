# Open questions & validation risks

> Living document. This is the honest list of what we don't know. An item here is a
> flag, not a blocker — but the big ones should be answered by evidence, not vibes.
> Format: **Q** = open question, **R** = known risk.

## Efficacy (the ones that could sink the premise)
- **R — Transfer.** People get much better at puzzles without getting better at chess. If
  our held-out sets improve but real game results don't, the whole thing is a puzzle toy.
  *Mitigation:* held-out families, tier+justify format, family rotation, hidden-mode
  queue, and eventually game-import measurement. Still unproven.
- **Q — Does frequency-weighted regret surface *pedagogical* mistakes, or noise?** Some
  high-regret moves are just tactics, hardware artifacts, or engine-depth flukes. How
  aggressive must the trenchcoat filter be before the pool is clean?
  - **Partly answered, 2026-08 (#112, #113), for the opening case.** `trapValue` — frequency ×
    swing × outperformance — was replicated across two independent months of 8M games: **98 of
    149** findings held for 1.d4 + Black, **184 of 217** for 1.e4, agreeing on magnitude and not
    merely presence. The shortfall is a **coverage gap, not a refutation**: **nothing was
    contradicted** in either run. Roughly a third simply could not be re-checked, because the
    second month's crawl never reached those lines — 46 of the 149 and all 33 of the 217 — and
    [`replicate.mjs`](../scripts/repertoire/replicate.mjs) reports them apart for exactly that
    reason. So what cross-month replication separates is *checked twice* from *checked once*,
    which a sample-size floor alone could not
    ([repertoire/v2/README.md](../repertoire/v2/README.md)). It does **not** clear the rest:
    not-contradicted is not confirmed, and the remaining 5 of the 1.d4 findings were seen by
    both months but moved by more than the agreement factor (4×), so they are held as unstable
    rather than kept or dropped. The noise question stands for everything the second crawl
    did not reach.
  - **And the trenchcoat filter turned out not to be the lever here.** At 4M nodes the
    shallow-versus-deep test decided **0 of 412** assessed positions, so it is off by default
    (ADR [0026](decisions/0026-retire-the-tactic-gap-at-high-node-budgets.md)). It still earns
    its keep below ~1M nodes — the question becomes "how deep is the search", not "how
    aggressive is the filter". Neither result says anything yet about the *tactics* pool, which
    is where the question was originally aimed.
- **Q — Is LLM justification-grading a clean enough telemetry channel** to actually
  identify the skill model, or does its noise swamp the signal we're trying to extract?
- **Q — Do the borrowed instructional-design effects hold for chess judgment** at useful
  magnitude? The chess-specific evidence (chunking, deliberate practice) is strong; the
  interleaving/desirable-difficulty evidence is imported from other domains.

## Content / ontology (the real bottleneck)
- **Q — How much of the priyome annotation can actually be automated** vs. needing a human
  (or a strong player) in the loop? Smith spent years on 1,000 positions.
- **Q — Where does the seed taxonomy come from legally?** *Woodpecker Method 2* is
  copyrighted; we can learn the *structure* of families from it but must build our own
  positions/annotations. What's the clean-room boundary?
- **Q — What's the minimum viable family count** for the evaluative mode to feel real at
  the 1200 band?

## Skill model / adaptivity (deferred, but flag early)
- **Q — Does multidimensional IRT with ~200 dims actually identify** from the sparse,
  noisy data one hobbyist generates, or does it need many users first?
- **Q — Cold-start from imported games:** how reliable are the classifier's labels on
  real amateur games (which are messy and full of mutual blunders)?
- **Q — ROI weights:** we want to *learn* band-conditional skill priorities from
  game-result correlations — that needs a user base. What do we assume until then?

## Product / scope
- ~~**Q — Tech stack.**~~ **Answered.** Locked by ADR
  [0009](decisions/0009-tech-stack.md) and settled by three shipped releases: a client-side
  React + Vite + TypeScript app with **no backend**, engines behind ports (ADR
  [0015](decisions/0015-pragmatic-hexagonal.md)). The "data-prep pipeline feeding a thin
  client" half did happen, in Node rather than Python and offline rather than served —
  `scripts/repertoire/` and `npm run review` produce files the app can consume. Kept here
  because the split it predicted is real, not because the question is still live.
- **Q — Single-user (you) vs. multi-user from the start.** Multi-user changes storage,
  auth, and privacy; v0 assumes single-user local-first. When does that flip?
- **Q — Licensing & data terms.** Maia weights and Syzygy have their own terms; check each
  before distribution.
  - **Answered for what we actually use, 2026-08.** Lichess's evaluation dump is **CC0** (ADR
    [0024](decisions/0024-gate-on-a-local-evaluation-index.md)); the monthly game dumps are the
    open Lichess data the generator's band books are built from. **Lumbra's Gigabase is CC
    BY-NC-SA 4.0** — fine here (permanently open, non-commercial) and we redistribute nothing
    (ADR [0018](decisions/0018-games-corpus-and-annotations.md)). Stockfish and the Maia nets
    are **GPL**, kept arm's-length in their own Workers with `NOTICE.md`s and fetched rather
    than committed.
  - **Still open:** Syzygy's terms if tablebases are ever bundled rather than probed, and
    whether hosting the app changes the GPL obligations that arm's-length vendoring currently
    satisfies.
- **Q — How "hidden" can the mixed queue really be** in a UI that still has to offer
  mode-appropriate input affordances (tier buttons vs. a move) without leaking the mode?
  This is a genuine design puzzle, not just a toggle.

## Measurement hygiene
- **R — Vanity metrics.** A speed/accuracy dashboard on evaluative material will look
  amazing and mean nothing (card recognition). Constitution §9 forbids it; stay honest.
- **R — Over-fitting to one user (you).** v0 is tuned to a single 1200 player; don't
  mistake "works for Jacob" for "works."
