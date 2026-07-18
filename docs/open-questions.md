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
- **Q — Tech stack.** Web-first client-only (current proposal) vs. native/offline vs. a
  Python data-prep pipeline feeding a thin client. Locked when v0 starts.
- **Q — Single-user (you) vs. multi-user from the start.** Multi-user changes storage,
  auth, and privacy; v0 assumes single-user local-first. When does that flip?
- **Q — Licensing & data terms.** Lichess data is open (verify the exact license and
  attribution terms); Maia weights and Syzygy have their own terms; check each before
  distribution.
- **Q — How "hidden" can the mixed queue really be** in a UI that still has to offer
  mode-appropriate input affordances (tier buttons vs. a move) without leaking the mode?
  This is a genuine design puzzle, not just a toggle.

## Measurement hygiene
- **R — Vanity metrics.** A speed/accuracy dashboard on evaluative material will look
  amazing and mean nothing (card recognition). Constitution §9 forbids it; stay honest.
- **R — Over-fitting to one user (you).** v0 is tuned to a single 1200 player; don't
  mistake "works for Jacob" for "works."
