# CLAUDE.md — working agreement for AI agents in this repo

This is the canonical guidance file for AI coding agents (Claude Code and others).
Human-facing overview is in [README.md](README.md).

## What this project is
**etude-chess** — a unified, adaptive chess *judgment* trainer organized by **decision
type** (concrete / evaluative / technique / prophylactic / play-it-out), whose signature
feature is a **hidden-mode mixed queue**. Read [docs/vision.md](docs/vision.md) and
[docs/decision-types.md](docs/decision-types.md) before doing design work.

## Current status: v0.2.0 released (play vs Maia + in-game coach) — 2026-07-18
- Two modes ship: **coached guess-the-move** (v0.1.0) and **play vs client-side Maia with an
  ambient coach** (v0.2.0). What exists: [CHANGELOG.md](CHANGELOG.md) +
  [docs/architecture.md](docs/architecture.md). Next: **v0.3.0 — complete the core loops**;
  the design is decision-complete in [docs/v0.3.0-plan.md](docs/v0.3.0-plan.md) (work = the
  GitHub **v0.3.0 milestone**, one branch per issue).
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
   Ratified into the version sequence by ADR
   [0019](docs/decisions/0019-why-layer-next.md): **v0.4.0 is the "why" layer**, and the three
   curricula each moved back a slot.

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
- Prose is direct and technical; the primary audience is the owner (a USCF ~1200 player)
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
  `npm run test:e2e` (Playwright).

## Workflow (see [docs/dev-workflow.md](docs/dev-workflow.md), [RELEASING.md](RELEASING.md))
- **Trunk-based**: `main` stays green; short-lived `feat/…`·`fix/…`·`chore/…`·`docs/…` branches, one per issue.
- **TDD** the pure logic; **`npm run verify`** before every commit; CI runs verify + e2e.
- Small single-purpose **PRs** linking the issue (`Closes #N`). The agent manages the full loop
  including merging (owner delegated 2026-07-18); CI + verify gate the merge.
- Track work as GitHub issues (`P0/P1/P2` + `area:*`). **Each release, run
  [RELEASING.md](RELEASING.md)** so CLAUDE.md + the docs stay accurate for the next session.

## Environment notes
- Windows / PowerShell primary shell; a POSIX Bash tool is also available.
