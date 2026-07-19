# etude-chess

A unified, adaptive chess **judgment** trainer. Not "puzzles by phase" — a single
system organized around the *decision type* a position demands, with the mode
deliberately hidden in a mixed queue so it trains the one skill every other
trainer gives away for free: *noticing what kind of position you're in.*

> **Status: v0.2.0 released (2026-07-18).** Two modes, both fully client-side: coached
> **guess-the-move** on master games, and **play vs Maia** — a human-like opponent running in
> your browser — with a coach on every move, accuracy, and a post-game review. What exists:
> [docs/architecture.md](docs/architecture.md) and [CHANGELOG.md](CHANGELOG.md).
> Next: v0.3 — learn from your own games. Design docs live in [docs/](docs/).

## Running it

```
npm install
node scripts/setup-maia.mjs   # fetch the Maia nets (needed to play vs Maia)
npm run dev                   # http://localhost:5173
npm run verify                # typecheck + lint + 153 unit tests
npm run build                 # typecheck + production build
```

Fully client-side — no backend, no accounts. Stockfish runs as a WASM Web Worker from
`public/engine/` (GPLv3, arm's-length). See [docs/v0.1.0-plan.md](docs/v0.1.0-plan.md).

## The one-paragraph pitch

Games give you ~3–5 genuinely instructive decisions per 30 minutes and one bit of
feedback (the result). This trades that for **density and retrieval**: many
instructive decisions per session, each one graded, each one measured. It targets
players roughly **USCF 1200 and up**, where the honest ceiling is ~75% of trainable
skill at 1200–1600 and it erodes above ~2000. It will not teach clock management,
deep calculation stamina, or "worse-but-tricky" practical defense — see
[docs/vision.md](docs/vision.md) for the honest scope.

## Repo map

| Path | What it is |
|------|-----------|
| [docs/architecture.md](docs/architecture.md) | **What exists now** — architecture, module map, features |
| [CHANGELOG.md](CHANGELOG.md) · [RELEASING.md](RELEASING.md) | Release history · the release ritual |
| [docs/vision.md](docs/vision.md) | Problem, value proposition, honest ceiling, who it's for |
| [docs/constitution.md](docs/constitution.md) | Non-negotiable principles that govern every later decision |
| [docs/learning-science.md](docs/learning-science.md) | The cognitive-science grounding, with sources |
| [docs/decision-types.md](docs/decision-types.md) | The core taxonomy (concrete / evaluative / technique / prophylactic / play-out) |
| [docs/roadmap.md](docs/roadmap.md) | Phased plan — curricula first, adaptive engine last |
| [docs/development-focus.md](docs/development-focus.md) | **Where the leverage is** — why these priorities, and the one bottleneck |
| [docs/v0.1.0-plan.md](docs/v0.1.0-plan.md) | **The concrete first release** + technology selection |
| [docs/first-deliverable.md](docs/first-deliverable.md) | The multi-mode drill trainer (medium-term, fed by review) |
| [docs/research/effectiveness.md](docs/research/effectiveness.md) | What actually makes a chess trainer work (sourced) |
| [docs/research/engines.md](docs/research/engines.md) | How to utilize Stockfish & Maia (sourced) |
| [docs/research/llm-integration.md](docs/research/llm-integration.md) | LLM integration & position-feature extraction (sourced) |
| [docs/glossary.md](docs/glossary.md) | Priyome, tiers, regret-weighting, Maia, Syzygy, IRT… |
| [docs/open-questions.md](docs/open-questions.md) | Unknowns and validation risks |
| [docs/decisions/](docs/decisions/) | ADR log — the choices already made and why |
| [CLAUDE.md](CLAUDE.md) / [AGENTS.md](AGENTS.md) | Guidance for AI coding agents working in this repo |

## Where the concept came from

The design was worked out in a long planning conversation
([shared transcript](https://claude.ai/share/787a5489-4e50-41a6-a1d4-caa56fe655d7)).
The decision records in [docs/decisions/](docs/decisions/) capture the conclusions;
[docs/vision.md](docs/vision.md) captures the reasoning.
