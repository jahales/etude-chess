# Architecture / Design Decision Records

Short records of decisions already made and *why*, so the reasoning survives even as the
docs around them change. Lightweight ADR format. A decision reversed later isn't edited
away — it's marked **Superseded** and a new ADR explains the change.

Status values: **Accepted** · **Proposed** · **Superseded** · **Deferred**.

| # | Decision | Status |
|---|----------|--------|
| [0001](0001-decision-types-not-phases.md) | Organize by decision type, not game phase | Accepted |
| [0002](0002-hidden-mode-mixed-queue.md) | The hidden-mode mixed queue is the core differentiator | Accepted |
| [0003](0003-human-frequency-not-engine-topn.md) | Source candidates from human frequency, not engine top-N | Accepted |
| [0004](0004-tier-not-rank.md) | Tier candidates (A/B/C); never grade a ranking | Accepted |
| [0005](0005-justification-as-telemetry.md) | A justification is required and is telemetry | Accepted |
| [0006](0006-maia-opponent-stockfish-referee.md) | Maia is the opponent; Stockfish/Syzygy is the referee | Accepted |
| [0007](0007-content-first-adaptive-last.md) | Build content/curricula first, adaptive engine last | Accepted |
| [0008](0008-skill-model-multidim-irt.md) | Learner model is a multidimensional-IRT skill vector | Deferred |
| [0009](0009-tech-stack.md) | Tech stack: client-side browser app, permissive UI, Stockfish arm's-length | Accepted |
| [0010](0010-engine-architecture.md) | Engine integration: one thin interface, WASM-first, grade by win% swing | Accepted |
| [0011](0011-game-review-first.md) | Lead v0.1.0 with a personalized game-review loop, not puzzles | Accepted |
| [0012](0012-llm-grounded-explainer.md) | LLM is a grounded explainer/grader over engine facts, never an evaluator | Accepted (usage deferred) |
| [0013](0013-v0.1.0-play-vs-maia.md) | Play-vs-Maia coaching loop; Maia runs client-side | Superseded in timing (→ v0.2.0) |
| [0014](0014-v0.1.0-guess-the-move.md) | v0.1.0 is coached guess-the-move on master games | Accepted |
| [0015](0015-pragmatic-hexagonal.md) | Pragmatic hexagonal architecture (ports & adapters) | Accepted |
| [0016](0016-maia-onnx-delivery.md) | Client-side Maia delivery: Maia-1 via onnxruntime-web in a Worker | Accepted |
| [0017](0017-in-game-coach.md) | Coach during the game (coach-every-move), not only after | Accepted |
| [0018](0018-games-corpus-and-annotations.md) | Games database: **users attach their own**; we ship no bulk corpus | Accepted |
| [0019](0019-why-layer-next.md) | The "why" layer is the next major build, via a grounded concept ontology | Accepted |

> These are provisional. This is an exploratory project; expect amendments.
