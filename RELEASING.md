# Releasing

How we cut a release — and, just as important, how we **keep the project legible to an LLM** so
each new feature is built on an accurate, high-signal base. This is a deliberate step, not an
afterthought: the context files are re-sent to the model on every request and compensate for it
being stateless, so they must stay lean *and* true (see [docs/dev-workflow.md](docs/dev-workflow.md),
[docs/architecture.md](docs/architecture.md)).

## Why the re-orientation step exists
An LLM makes good decisions only when the always-loaded context (`CLAUDE.md`) accurately says
**what the project is, what exists now, and where things live** — and stays short enough that the
model actually follows it (~150–200 lines max; bloat degrades performance). Progressive
disclosure: `CLAUDE.md` is the *map*; the detail lives in `docs/` and is read on demand. Left
untended, that map goes stale (e.g. "no application code yet" after v0.1.0 shipped) and quietly
misleads every future session. So we refresh it every release.

## Release checklist
1. **Green.** `main` passes `npm run verify` and `npm run test:e2e`; CI green.
2. **Version.** Bump `version` in `package.json` (SemVer).
3. **Changelog.** Move `Unreleased` items into a dated `## [x.y.z]` section in
   [CHANGELOG.md](CHANGELOG.md); reset `Unreleased`.
4. **Re-orient the context (do not skip):**
   - Update `CLAUDE.md` **Current status** to match reality; keep it lean (prune anything now
     covered by a doc; replace detail with a pointer).
   - Update [docs/architecture.md](docs/architecture.md) "what exists / module map / major
     features" to match the code.
   - Mark superseded ADRs; prune or update any doc that a session would now be misled by.
   - Sanity check: could a fresh agent, reading only `CLAUDE.md` + the docs it points to, make a
     correct decision about the next feature? If not, fix the gap.
5. **Tag & release.** Commit on a `chore/release-x.y.z` branch → PR → merge, then:
   ```
   git tag vX.Y.Z && git push origin vX.Y.Z
   gh release create vX.Y.Z --title "vX.Y.Z — <name>" --notes-file <notes>   # or --generate-notes
   ```
6. **Deploy** (once hosting exists): build and publish the static bundle (S3/CloudFront). N/A for
   v0.1.0.

## Cadence
Do this at each meaningful release (roughly each `v0.x` milestone). Small `chore:`/`fix:` merges
don't need a release, but they **should** keep `CHANGELOG.md`'s `Unreleased` section current.
