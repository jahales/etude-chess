# 0027 — Blunder rate per game: a stated figure, not a dashboard

**Status:** Accepted · 2026-08-14
**Relates to:** issue #65 · [development-focus.md §Measurement](../development-focus.md) ·
constitution §9, §12 · ADR [0004](0004-tier-not-rank.md) (tiers, and the swing they rest on)

## Context

[development-focus.md](../development-focus.md) §Measurement fixes the measurement policy:
rated game rating is the only real metric and it moves in months; **puzzle rating moves faster
and lies**; the earliest honest signal is the user's own **blunder rate per game** from the
review loop. "Instrument it from the start."

Issue #65 named the tension rather than resolving it: this is a metric *across games*, and the
constitution is deliberately hostile to displays that imply improvement nobody measured. §9
forbids speed-and-accuracy dashboards on evaluative material because they measure card
recognition and "will look fantastic while meaning nothing." §12 forbids letting a metric imply
transfer we have not measured.

Two things make the tension resolvable rather than fatal. The data already exists — the
whole-game pass (#68) scores every position and persists the result, so nothing new is captured
and nothing is recomputed. And there is a shipped precedent for the failure mode this feature
would otherwise repeat: #74, where a game showed **99.18% accuracy** directly above a move
flagged as a 16% mistake, because the figure was a mean over the moves the coach had finished
grading — the early ones — presented as if it described the game.

## Decision

Ship the rate. Ship it as a **stated figure with its sample attached**, in the library, next to
the games it was computed from. Five rules, each of which is the thing that makes it honest
rather than a decoration on it.

**A game earns its way in.** Only a game with a *completed* whole-game analysis pass, at the
current budget, that measured **every move you played**. Anything less is the #74 failure with a
new name: the coach grades in order and stops when the game does, so a partial analysis is a
mean over your opening moves. It reads well and it is wrong in a direction the user cannot
detect. A game that does not clear the bar is **uncounted**, never assumed clean, and the count
of uncounted games is printed beside the figure.

**A blunder is exactly a `??`.** `isBlunder` delegates to `annotationForSwing` rather than
re-comparing against `BLUNDER_MIN_SWING`, so the set counted here and the set glyphed in the
move list cannot drift apart. A metric that disagrees with the game it came from discredits
both — the same reason the glyphs share the coach's tier boundaries.

**The `n` travels with the number.** Games, moves, and what was left out, always, in the same
block. Below ten games the display says the sample is too thin to read anything into. Blunders
per game behave like counts, so the standard error is about `√rate / √games`: at a rate near 1
and ten games that is ±0.32, a third of the value. Under ten it is noise with two decimal
places. The owner has played a few hundred games in total, so the thin sample is the normal
case here, not an edge case to handle politely.

**No trend, no goal, no bar.** No line chart, no progress bar, no target, no "you're
improving". We have not measured that this number moving means anything about the user's chess,
and drawing it as something to fill in would make exactly the claim §12 prohibits. It is a
*leading indicator for the project* — cheap validation data from the one person dogfooding at
~1355 — and a description of the games below it. Not a score.

**Over no games it does not exist.** `perGame` is `undefined` over an empty sample rather than
`0.00`, which would render as a perfect record over games nobody measured.

## Where it is *not*

**Not on Home.** The Home cards have room for one line, and this number is not safe at one
line: strip the sample, the threshold and the "these games only" qualifier and what is left is a
score on a card. The library is where the games are, where the caveats fit, and where the
per-row column makes the total checkable against its inputs instead of merely asserted.

## Consequences

- The rate is derived on read from records already in IndexedDB. No new field, no migration, no
  extra query — the library already loads these rows.
- **Blunders per game moves with game length.** A 20-move game and a 70-move game count the
  same. This is the metric development-focus.md asked for and we ship it as specified; a
  per-100-moves figure alongside it would invite comparing two numbers that answer different
  questions, so the move count is published and the second rate is not.
- Play-outs (#48) are excluded. They start from a position rather than move 1, so ply parity no
  longer identifies who moved — we would credit the opponent's blunders to the user — and "per
  game" over a fragment is not the quantity being measured. Same deferral `app/replay.ts` makes.
- Games analysed at a superseded node budget fall out on their own, through the existing
  `isAnalysed` check. Re-running the pass brings them back.
- The threshold is `BLUNDER_MIN_SWING` (30 win%). Moving it moves this metric and every `??` in
  the app together, which is the intended coupling and worth knowing before touching it.
- What this still cannot tell us: whether the number falling means the user improved, or that
  Maia's level changed, or that the games got shorter. Establishing that needs the rated-game
  series §Measurement steers by, and nothing here anticipates it.
