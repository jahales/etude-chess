# Development workflow (LLM-assisted, GitHub, trunk-based)

> How we build etude-chess. Adopted 2026-07-18 after a pass on current best practices
> for AI-agent-assisted development. Applies to human and agent contributors alike.

## Branching — trunk-based with short-lived branches
- **`main` is the trunk** and must always be green (tests + typecheck + build pass). Deploys
  come from `main`.
- Do work on **short-lived branches** (hours to a day), one per issue, named by type:
  `feat/…`, `fix/…`, `chore/…`, `docs/…`, `refactor/…`. Filterable prefixes on purpose.
- **No long-running feature branches** and **no feature flags** yet — keep changes small enough
  to land quickly instead.

## The per-change loop
`spec → context → plan → implement (small batches, TDD) → verify → review the diff → commit`
- **TDD for pure logic**: write/adjust tests first in `src/domain/**` and the pure parsers
  (`src/engine/uci.ts`). The engine and UI are exercised behind interfaces / with fakes.
- **Verify locally before every commit**: `npm run verify` (typecheck → lint → test, ~4s,
  cheapest-first so it fails fast). `npm run build` and the Playwright E2E run in CI. See
  [testing.md](testing.md).
- **Commit only explainable changes.** Human-readable subject line describing the change; end
  the message with the model trailer:

  ```
  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  ```

## Pull requests
- **Small and single-purpose** — reviewable in one sitting. One concern per PR.
- **Link the issue**: put `Closes #N` (or `Refs #N`) in the body so the merge auto-closes it.
- PR body says **what changed, why, and how it was verified** (test counts; screenshots/notes
  for UI). Call out **dependency changes** explicitly — they're a distinct approval point.
- **The agent manages the full process, including merging** (owner delegated this 2026-07-18).
  Still open a PR per change for traceability, and let **CI + `npm run verify` gate the merge**
  (green before merge). Prefer squash-merge and delete the branch.

## CI
- GitHub Actions (`.github/workflows/ci.yml`) runs **typecheck → lint → test → build** on every
  PR and on pushes to `main`. Green before merge.

## Issues
- Track everything as GitHub issues with a **priority** (`P0`/`P1`/`P2`) and an **area** label
  (`area:engine|ui|content|quality`). Reference issue numbers in branch names, commits, and PRs.

## Repo-specific rules (see CLAUDE.md for the full list)
- Engine access stays **behind the `Analyser` interface**; never import the Worker into domain code.
- Grade by **win% swing → A/B/C tiers**; an engine-equal move is Tier A. **No speed metric.**
- Engine calls are **reproducible** (fixed nodes/depth, never movetime for grading).
- The LLM only ever renders/grades the **fact bundle**; it never computes chess facts.

## Security hygiene for agent work
- No secrets in the repo (LLM stays clipboard/BYOK; keys live in the user's environment, never
  committed). `settings.local.json`, `.env` are git-ignored.
- Don't execute model output as shell commands without review; keep tokens least-privilege.
