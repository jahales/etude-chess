# CLAUDE.md — working agreement for AI agents in this repo

This is the canonical guidance file for AI coding agents (Claude Code and others).
Human-facing overview is in [README.md](README.md).

## What this project is
**etude-chess** — a unified, adaptive chess *judgment* trainer organized by **decision
type** (concrete / evaluative / technique / prophylactic / play-it-out), whose signature
feature is a **hidden-mode mixed queue**. Read [docs/vision.md](docs/vision.md) and
[docs/decision-types.md](docs/decision-types.md) before doing design work.

## Current status: v0.3.0 released (hardening) — 2026-08-14
- **Three modes ship**: coached **guess-the-move** on a master game (v0.1.0), **play vs
  client-side Maia** with an ambient coach (v0.2.0), and **review your own games** (v0.3.0),
  which closed the own-game review loop *inside the app*, not just in the `npm run review` CLI.
  v0.3.0 **added no features**: it made the assembled surface trustworthy. Milestone: **12
  issues, all closed**. What each mode does: [docs/architecture.md](docs/architecture.md);
  what changed when: [CHANGELOG.md](CHANGELOG.md).
- **Repertoire v2 (2026-08-11) is off-app CLI tooling**, no UI — it serves the P1 own-game
  review loop in [docs/development-focus.md](docs/development-focus.md). Two invariants to know
  before touching it: moves are gated on a **local index of Lichess's evaluation dump**, not on
  the crawl's own search, and a trap keeps that label only where **two independent months
  agree**. Output is **staged decks** (`standard`, then `complete`) in
  [repertoire/v2](repertoire/v2/) — deck counts, crawl settings and rationale live there and in
  [scripts/repertoire/README.md](scripts/repertoire/README.md); ADRs
  [0024](docs/decisions/0024-gate-on-a-local-evaluation-index.md)–[0026](docs/decisions/0026-retire-the-tactic-gap-at-high-node-budgets.md).
- **What's next**: hardening was epic 1 and v0.3.0 was that cut, so the top of
  [docs/backlog.md](docs/backlog.md) is now **epic 2 — "bring your own game database"**
  (#53 → #54 → #55, plus #70; designs in [docs/v0.3.0-plan.md](docs/v0.3.0-plan.md) §9–11).
  Nothing beyond that is committed to.
- The design is still **living**; every doc except the constitution is revisable.

## Read these before proposing anything
1. [docs/constitution.md](docs/constitution.md) — the non-negotiable principles. If a
   suggestion violates one, don't make it; if you think a principle is wrong, say so and propose
   an amendment — don't quietly work around it.
2. [docs/decisions/](docs/decisions/) — the ADR log. Decisions already made, with reasons.
3. [docs/architecture.md](docs/architecture.md) — what exists now, the module map, and where to
   make changes. [docs/backlog.md](docs/backlog.md) — **epics in priority order, no version
   numbers** (ADR [0020](docs/decisions/0020-backlog-of-epics.md)). A version is a *cut* we name
   when work is pulled off the backlog, never a slot we plan into.
4. [docs/research/](docs/research/) — the evidence behind the design (effectiveness; engines; LLM).
5. [docs/development-focus.md](docs/development-focus.md) — **read before adding a mode.** What the
   priorities are and why: the "why" layer (P0) before breadth, the own-game review loop (P1),
   produce→review in one cycle (P2). Names the real bottleneck (annotation/ontology labor).
   ADR [0019](docs/decisions/0019-why-layer-next.md) argues the "why" layer's priority; its
   *sequencing* clause ("v0.4.0 is the why layer") is **superseded by ADR 0020** — the epic
   sits below the database in the backlog, since its ontology is seeded from a corpus.

## How to work here
- **Sequencing is load-bearing.** Content/loop first; the **adaptive skill model is last**
  (ADR 0007). Keep each release small; if a task seems to need the skill model, flag it.
- **Changing a decision = an ADR.** To reverse or amend an accepted decision, add a new ADR
  (or mark the old one Superseded) — don't just edit docs to match new code.
- **The constitution is heavy.** Amend it only deliberately, with a linked ADR. Everything
  else is free to evolve.
- **Be honest about the ceiling.** Don't add or imply metrics that suggest transfer we
  haven't measured (constitution §9, §12). No speed dashboards on evaluative material.

## Conventions
- Docs live in `docs/`; decisions in `docs/decisions/NNNN-kebab-title.md` (lightweight ADR
  format — see the existing ones). Cross-link liberally with relative markdown links.
- Prose is direct and technical; the primary audience is the owner (USCF ~1355)
  plus agents. State honest caveats inline rather than hiding them.
- Dates are absolute (YYYY-MM-DD), not "recently."

## The app
A client-side React + Vite + TypeScript app (no backend). **Architecture, module map, and where
to make changes: [docs/architecture.md](docs/architecture.md).** In short: pure `src/domain`, a
pure `src/app` reducer, an `Analyser` port with a Stockfish WASM adapter, `src/ui` on top.
Key rules: keep the domain pure; keep the engine behind the `Analyser` port; grade by win% swing
(engine-equal = Tier A, no speed metric); the LLM only renders the fact bundle (ADR 0012).

### Commands
- `npm run dev` (port 5173) · `npm run verify` (typecheck→lint→test) · `npm run build` ·
  `npm run test:e2e` (Playwright; run `node scripts/setup-maia.mjs` first or 4 spec files
  (5 cases) skip).
- The `rep:*` scripts are the off-app repertoire pipeline (build → decks → audit) and need
  `db/`. Stages, flags and rationale: [scripts/repertoire/README.md](scripts/repertoire/README.md).
- `npm run review -- --me <chess.com user> --last` — engine-review a finished game of the
  owner's (win% swing per move, phase-vs-clock split, chances the opponent gave). Accepts a
  game URL/id or `--pgn <file>`. Add `--deep` to re-examine each imperfect move with
  alternatives + win/draw/loss, per-piece values, and the tablebase under 8 pieces.
  **The process for coaching off this — including what the numbers do not support saying —
  is the `game-review` skill (`.claude/skills/game-review/`); follow it rather than
  improvising.**

## Workflow (see [docs/dev-workflow.md](docs/dev-workflow.md), [RELEASING.md](RELEASING.md))
- **Trunk-based**: `main` stays green; short-lived `feat/…`·`fix/…`·`chore/…`·`docs/…` branches, one per issue.
- **TDD** the pure logic; **`npm run verify`** before every commit. CI never invokes `verify` —
  it runs those checks as separate steps, plus build, plus a separate e2e job.
- Small single-purpose **PRs** linking the issue (`Closes #N`). The agent manages the full loop
  including merging (owner delegated 2026-07-18); CI + verify gate the merge.
- Track work as GitHub issues (`P0/P1/P2` + `area:*`). **Each release, run
  [RELEASING.md](RELEASING.md)** so CLAUDE.md + the docs stay accurate for the next session.

## Environment notes
- Windows / PowerShell primary shell; a POSIX Bash tool is also available.
- **`CHESSCOM_USER`** — the owner's chess.com handle, which `npm run review` needs (or pass
  `--me`). Set it in the shell profile and keep it out of committed files; it is the owner's to
  publish. It **is in this public repo's git history** (usage examples, 2026-08-08) — scrubbed
  from the working tree, not from the past. Don't re-add it, and ask rather than guess it.
- **`STOCKFISH_PATH`** — overrides the En Croissant install the engine driver defaults to.
- `db/` (game dumps) and `out/` are gitignored and **must stay that way**. They do not travel
  with the repo. Sizes as of 2026-08-14: **`db/` is 89 GB**, `out/` is 22 MB — so a re-fetch is
  a bulk download of third-party dumps, never a casual step. Check what is already on the
  machine before deciding a crawl or book build needs anything downloaded.
