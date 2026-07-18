# Learning-science grounding

> Living document. The point of this file is to keep design choices anchored to what
> is actually supported by cognitive-science evidence, and — just as important — to be
> honest about where the evidence is thin or where our instantiation departs from what
> was studied. Sources are listed at the bottom.

## The pillars we're building on

### 1. Retrieval practice (the testing effect)
Being *tested* produces more durable learning than re-studying. It is one of the most
robust findings in the field: meta-analytic effect sizes around **g ≈ 0.50**, with
transfer effects around **d ≈ 0.40**, replicated across hundreds of lab and classroom
studies. **Design consequence:** the post-mortem's core weakness is that it's study,
not retrieval — you read the answer and never have to *produce* it. Every item in this
system is a retrieval event, and we store the attempt as data.

### 2. Spacing
Distributing practice over time beats massing it. Combined spaced-**retrieval** practice
is reliably positive across STEM courses and math instruction. **Design consequence:**
the mistake-review queue resurfaces failures at expanding intervals (1/3/7/14/30 days);
concrete-mode set cycles follow Woodpecker's geometric spacing.

### 3. Interleaving — but conditionally
Interleaving different problem types improves **discrimination** ("which *kind* of
problem is this?") and long-term transfer, even though it feels harder and depresses
performance *during* practice. Crucially, the benefit is largest when the categories
are **highly similar** and confusable — exactly the "is this concrete or evaluative?"
judgment. **But** the evidence is not unconditional: for low-similarity categories, and
for *initial acquisition* by lower-achieving learners, **blocked** practice can win
(you need within-category structure before contrast helps). **Design consequence:** this
is precisely our *block-to-acquire, interleave-to-transfer* split — block by mode while
learning a theme, then hide the mode in a mixed queue to train and test discrimination.
The hidden-mode queue is the interleaving payoff; it is not free, and we don't apply it
before a learner has some blocked footing.

### 4. Desirable difficulties (Bjork)
Retrieval, spacing, and interleaving are "desirable difficulties": they cost effort and
*reduce* apparent performance during practice while *improving* long-term retention and
transfer. **Design consequence:** we must expect our own metrics during a session to
look *worse* than a massed/blocked trainer's, and not treat that as failure. It also
warns us against vanity metrics (constitution §9).

### 5. Cognitive Load Theory & the expertise-reversal effect
Working memory is small; instruction should minimize extraneous load. Worked examples
beat unguided problem-solving **for novices** — but that advantage **reverses** as
expertise grows (the expertise-reversal effect): what helps a beginner hinders an
expert, who should be problem-solving instead. **Design consequence:** scaffolding must
be **band-conditional**. A 1200 sometimes needs the worked example / the named feature
shown; a 1900 needs it withheld. This is a first-class reason the system must know your
level, and a reason "one difficulty for everyone" is wrong.

### 6. Chunking, templates, and pattern recognition (chess-specific)
Chess skill is largely **pattern recognition**: experts store tens of thousands of
*chunks* / *templates* (piece configurations linked to typical moves); masters have on
the order of ~50,000. Recognition triggers candidate moves, which is what makes fast,
"intuitive" strong play possible. **Design consequence:** the concrete and evaluative
modes are, mechanically, chunk-acquisition engines — motif density (concrete) and family
rotation (evaluative) are two ways of building transferable templates rather than
position-specific memories.

### 7. Deliberate practice: study > play (chess-specific)
Charness et al. found the strongest predictor of chess skill is hours of **serious,
solitary study**, more than tournament-play hours — because study can be aimed at
specific weaknesses with many repetitions, while a game move once made can't be redone.
**Design consequence:** this is the evidential backbone for building a study tool at all.
**The honest caveat:** "serious study" in those samples meant analyzing master games and
prep, not puzzle drilling. So the evidence supports the *category* (structured solitary
study), not our *specific* instantiation. Our held-out test sets exist to close that gap.

## The transfer problem (our biggest risk)
People get dramatically better at *puzzles* without getting better at *chess*. Puzzle
rating and game rating correlate but diverge. This is the central threat to the whole
premise, and design choices are aimed squarely at it:
- **Grade tiers + justification, not single moves** — an ordering + a stated reason is
  much harder to memorize than "the answer is Nd5," so it resists card-recognition.
- **Family rotation** — never the same position twice for evaluative work.
- **Held-out test sets** — measure transfer *within the training distribution* at least;
  it doesn't prove transfer to real games, but it's the minimum bar.
- **The hidden-mode mixed queue** — trains the mode-selection skill that only shows up
  over the board, which is the part puzzle-rating gains most conspicuously miss.

We should treat "does this transfer to real games?" as an empirical question we will
have to *measure with imported game data*, not assume. See
[open-questions.md](open-questions.md).

## Where we are knowingly guessing
- That LLM-graded justifications are a *clean enough* telemetry channel to identify the
  skill model. Plausible, unproven.
- That frequency-weighted regret reliably surfaces *pedagogical* mistakes rather than
  noise. Needs curation checks (constitution §6).
- That the effects above, all studied in other domains, hold at useful magnitude for
  chess judgment specifically. The chess-specific evidence (chunking, deliberate
  practice) is strong; the instructional-design evidence is borrowed.

## Sources
- Testing effect / retrieval practice meta-analyses: [Frontiers 2023](https://www.frontiersin.org/journals/psychology/articles/10.3389/fpsyg.2023.1258359/full), [health-professions state-of-the-art review (PMC)](https://pmc.ncbi.nlm.nih.gov/articles/PMC12292765/)
- Spacing + retrieval in STEM/math: [Educational Psychology Review 2025](https://link.springer.com/article/10.1007/s10648-025-10035-1), [Int. J. STEM Education 2024](https://link.springer.com/article/10.1186/s40594-024-00468-5), [Meta-analytic review of spacing (PDF)](http://www.lscp.net/persons/ramus/docs/EPR20.pdf)
- Interleaving / discriminative-contrast: [Memory & Cognition (why interleaving helps)](https://link.springer.com/article/10.3758/s13421-012-0272-7), [category-learning generalization (Frontiers 2014)](https://www.frontiersin.org/journals/psychology/articles/10.3389/fpsyg.2014.00936/full), [depends-on-strategy (PMC 2025)](https://pmc.ncbi.nlm.nih.gov/articles/PMC12108632/), [blocked-first for low achievers (Language Learning 2025)](https://onlinelibrary.wiley.com/doi/10.1111/lang.12659)
- Desirable difficulties vs. cognitive load: [Pyke et al. 2025 (comparative analysis)](https://journals.sagepub.com/doi/10.1177/17470218241308143), [desirable difficulties overview](https://notes.andymatuschak.org/zYB7kwEFRu8QALcbzbcoy9T)
- Expertise-reversal effect / worked examples: [Kalyuga 2007 (PDF)](https://www.uky.edu/~gmswan3/EDC608/Kalyuga2007_Article_ExpertiseReversalEffectAndItsI.pdf)
- Chess chunking / template theory: [Gobet & Simon, pattern recognition makes search possible (PDF)](http://www.chrest.info/Fribourg_Cours_Expertise/Articles-www/II%20Donnees%20empiriques/Gobet&Simon--PsycResearch--1998.pdf), [chess knowledge predicts memory (Memory & Cognition 2017)](https://link.springer.com/article/10.3758/s13421-017-0768-2)
- Deliberate practice in chess: [Charness et al. 2005 (PDF)](http://www.chrest.info/Fribourg_Cours_Expertise/Articles-www/II%20Donnees%20empiriques/CharnessEtal2005ACP.pdf), [Cambridge Handbook — Expertise in Chess](https://www.cambridge.org/core/books/cambridge-handbook-of-expertise-and-expert-performance/expertise-in-chess/6E7F07A536AED091520EE9AE31128CCE)
