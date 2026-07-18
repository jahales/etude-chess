# AGENTS.md

Guidance for AI coding agents working in this repository.

**The canonical instructions live in [CLAUDE.md](CLAUDE.md).** This file exists so
non-Claude agents that look for `AGENTS.md` find their way there. Read CLAUDE.md, then the
docs it points to, before making changes.

## The 30-second version
- **etude-chess** is a chess *judgment* trainer organized by **decision type**, whose core
  differentiator is a **hidden-mode mixed queue**.
- **Status: planning / exploratory — no application code yet.** Don't scaffold or build
  unless explicitly asked.
- Before proposing design: read [docs/constitution.md](docs/constitution.md) (non-negotiable
  principles) and [docs/decisions/](docs/decisions/) (decisions already made, with reasons).
- **Sequencing is load-bearing:** content/curricula first, adaptive skill model last. Keep
  the first deliverable ([docs/first-deliverable.md](docs/first-deliverable.md)) small.
- To reverse a decision, add an ADR — don't quietly edit around it.
