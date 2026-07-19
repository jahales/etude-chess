# 0020 — Plan with a prioritized backlog of epics; versions are cuts, not slots

**Status:** Accepted · 2026-07-19
**Supersedes** the version-spine structure of the roadmap (introduced 2026-07-19) and the
sequencing clause of ADR [0019](0019-why-layer-next.md) — its *content* decisions stand.

## Context
The roadmap was organised as a spine of version numbers, each holding a planned chunk of work.
In a single week that structure was renumbered **twice**:

- once when bring-your-own PGN import landed in v0.3 and made the old "games corpus" slot
  redundant, moving opening/endgame/mixed-queue back a slot;
- again when ADR 0019 put the "why" layer ahead of the curricula, moving all three back again.

A third renumber was queued the moment the database was pulled ahead of the "why" layer.

Every one of those edits was pure churn. Nothing about the *work* changed — only the labels
attached to it — yet each pass touched the roadmap, the ADR index, CLAUDE.md and any doc that
referenced a version. The renumbering also actively misled: a reader seeing "v0.6.0 — endgame"
could reasonably infer a commitment that was never made.

The mistake is planning in units of *release* rather than units of *work*. A version number is
a statement about **when**, and we don't know when. An epic is a statement about **what**, and
we do know what.

## Decision

1. **The backlog is a prioritized list of epics.** [../backlog.md](../backlog.md) (formerly
   `roadmap.md`) holds them, ordered, with **no version numbers attached**. Reordering the
   backlog is a one-line edit that invalidates nothing.

2. **A version is a cut, named when the work is pulled.** We decide what a release contains by
   taking epics (or slices of them) off the top of the backlog, and *then* create the milestone.
   A milestone therefore only ever describes work we have actually committed to, in flight or
   shipped. **No milestone exists for work we have merely intended.**

3. **Epics are labels, not tickets.** `epic:*` on GitHub, so every issue carries its epic and
   the backlog can be reconstructed by query. Priority stays on the existing `P0`/`P1`/`P2`
   labels. An epic is a theme with a shared goal, not a parent issue to keep in sync.

4. **Sequencing arguments live with the epic, not with a number.** ADR 0019's *reasoning* — the
   "why" layer is the differentiator and must precede new modes — remains binding as the
   argument for that epic's priority. What is withdrawn is its claim that the layer *is
   v0.4.0*.

5. **Ordering constraints are stated as dependencies.** Where one epic genuinely requires
   another (the mixed queue is a queue *over a pool*; the "why" layer's ontology is seeded from
   a corpus), the backlog says so in the epic itself. A dependency survives reordering; a
   version number does not.

## Consequences
- **Reprioritising costs one edit.** The database moving ahead of the "why" layer — the change
  that prompted this ADR — becomes a reorder, not a renumber of four releases plus their
  inbound links.
- **`docs/roadmap.md` becomes `docs/backlog.md`**, with inbound links updated. The name was
  half the problem: a "roadmap" invites dates, and we don't have any.
- **We lose the ability to say "this ships in v0.5.0."** That is the point. We were never able
  to say it truthfully; the structure just made it easy to imply.
- Existing shipped versions (v0.1.0, v0.2.0) keep their numbers — those are facts about what
  happened, not plans.
- CLAUDE.md, README and the ADRs that referenced the version spine are updated to point at the
  backlog.

## Alternatives rejected
- **Keep versions and renumber when needed.** Two renumbers in a week with a third queued is
  the evidence against it. The cost recurs every time priorities move, which is often, and this
  is an exploratory project where they *should* move.
- **Keep versions but only for the next one or two.** Better, but it still forces the question
  "so what's v0.5?" at every planning turn, and the answer is invented rather than known.
- **Epics as parent issues with checklists.** Requires manual synchronisation that goes stale
  the moment anyone edits a child. Labels are queryable and can't drift.
