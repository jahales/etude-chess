# CLAUDE.md — working agreement for AI agents in this repo

This is the canonical guidance file for AI coding agents (Claude Code and others).
Human-facing overview is in [README.md](README.md).

## What this project is
**etude-chess** — a unified, adaptive chess *judgment* trainer organized by **decision
type** (concrete / evaluative / technique / prophylactic / play-it-out), whose signature
feature is a **hidden-mode mixed queue**. Read [docs/vision.md](docs/vision.md) and
[docs/decision-types.md](docs/decision-types.md) before doing design work.

## Current status: PLANNING / EXPLORATORY (as of 2026-07-17)
- **There is no application code yet.** This repo is design docs + decision records.
- The design is **provisional** and the owner expects to change their mind as things are
  learned. Treat every doc except the constitution as living and revisable.
- Don't scaffold app code, pick libraries, or start building unless explicitly asked. When
  in doubt, we are still planning.

## Read these before proposing anything
1. [docs/constitution.md](docs/constitution.md) — the non-negotiable principles. If a
   suggestion violates one of these, don't make it; if you think a principle is wrong, say
   so explicitly and propose an amendment — don't quietly work around it.
2. [docs/decisions/](docs/decisions/) — the ADR log. Decisions already made, with reasons.
3. [docs/v0.1.0-plan.md](docs/v0.1.0-plan.md) — the concrete first release (a personalized
   game-review loop) and the chosen stack. [docs/roadmap.md](docs/roadmap.md) for the phase
   order; [docs/first-deliverable.md](docs/first-deliverable.md) for the medium-term drill modes.
4. [docs/research/](docs/research/) — the evidence behind the plan (effectiveness; engines).

## How to work here
- **Respect the sequencing.** Content/curricula first, adaptive skill model **last** (ADR
  0007). Do not pull classifier / Maia / skill-model / adaptivity work forward into v0.
  If a task seems to need them, flag it rather than building them.
- **Keep v0 small.** The deferred list in [docs/first-deliverable.md](docs/first-deliverable.md)
  is a fence, not a suggestion. Resist scope creep toward "the full vision."
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

## The app (v0.1.0 — coached guess-the-move)
A client-side React + Vite + TypeScript app at the repo root. Layout:
- `src/domain/` — pure, fully-unit-tested logic (winPercent, grade tiers, harness, factBundle,
  session). No React, no engine, no I/O. **Add tests here first (TDD).**
- `src/engine/` — the `Analyser` interface + `StockfishAnalyser` (WASM Worker) + `grading.ts`.
  Grading depends only on the interface, so it's tested with a fake analyser.
- `src/content/games.ts` — the public-domain game pack (validated by `games.test.ts`).
- `src/persist/db.ts` — best-effort IndexedDB (Dexie); never throws.
- `src/ui/` — React components + hooks + styles.
- `public/engine/` — vendored Stockfish 18 WASM (GPLv3, arm's-length; see its `NOTICE.md`).

### Commands
- `npm run dev` — Vite dev server (port 5173).
- `npm test` — Vitest (run once). `npm run test:watch` to watch.
- `npm run typecheck` — `tsc --noEmit`. `npm run build` — typecheck + production build.

### Conventions
- Keep engine access behind the `Analyser` interface; never import the Worker into domain code.
- Grade by **win% swing** and tier A/B/C; a move as good as best is Tier A (never "match the
  master"). No speed metric (constitution §9).
- The LLM "why" is rules-based over the fact bundle for now; the bundle format is the eventual
  LLM input (ADR 0012) — don't let the LLM compute chess facts.

## Workflow (see [docs/dev-workflow.md](docs/dev-workflow.md))
- **Trunk-based**: `main` stays green; do work on short-lived `feat/…`·`fix/…`·`chore/…`·`docs/…`
  branches, one per issue.
- **TDD** the pure logic; **verify before every commit** with `npm test && npm run typecheck &&
  npm run build`.
- **Open a PR, don't self-merge.** Link the issue (`Closes #N`); the repo owner reviews and merges.
- Track work as GitHub issues with `P0/P1/P2` + `area:*` labels.

## Environment notes
- Windows / PowerShell primary shell; a POSIX Bash tool is also available.
