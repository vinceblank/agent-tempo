# ADR 0005 — Use `ink-scroll-view`; don't fork Ink

- **Status**: Accepted
- **Date**: 2026-04-26
- **Authors**: tempo-architect (with research from tempo-researcher Phase 1)
- **Related**: [`docs/SSE-PROTOCOL.md`](../SSE-PROTOCOL.md) Phase 3 PR-4, issue #95

## Context

The TUI cutover (Phase 3 PR-4) needs scroll containers for the chat view and the player-detail view. Ink — the React renderer the TUI is built on — does not ship a scroll primitive. The original issue text proposed **forking Ink** to add one.

Three options were evaluated by tempo-researcher in Phase 1:

1. **Fork Ink** — add native scroll primitives, maintain a downstream branch.
2. **Userland package** — adopt `ink-scroll-view` + `ink-scroll-list`, both cited in Ink's official README.
3. **Switch renderer** — abandon Ink for OpenTUI, react-blessed, or similar.

## Decision

**Use `ink-scroll-view` + `ink-scroll-list` from npm.** Add as direct dependencies; no fork.

## Consequences

- **Positive**:
  - Zero maintenance burden — upstream maintenance covers Ink major bumps and bug fixes.
  - ~50 k weekly downloads, MIT-licensed — broad ecosystem use confirms production-readiness.
  - Cited in Ink's own README as the recommended scroll solution → maintainer-endorsed userland.
  - Drop-in for the two views that need it — App.tsx ChatView and PlayerDetailView. PR-4 stays small.
  - When Ink's planned native scroll primitives land (issue [vadimdemedes/ink#765](https://github.com/vadimdemedes/ink/issues/765)), migration is mechanical: replace component imports, keep API surface.
- **Negative**:
  - One more peer dep — fixable with `package.json` `overrides` if `ink-scroll-view`'s peer range falls behind a future Ink major. We pin Ink to `^6` (current `^6.8.0`) explicitly to avoid the bump-skew until upstream catches up.
  - We don't control the package's release cadence. Mitigated by the small surface area we use (two components) and the fact that Ink itself is the harder upgrade.
- **Neutral**:
  - Bundle size impact is negligible (the TUI ships as a Node CLI, not a browser bundle).

## Alternatives considered

- **Fork Ink** — rejected. Ink maintainer's stated position on issue [vadimdemedes/ink#222](https://github.com/vadimdemedes/ink/issues/222) is that scroll lives in userland. PR [vadimdemedes/ink#764](https://github.com/vadimdemedes/ink/pull/764) (Gemini CLI's full native scroll implementation) closed unmerged in November 2025 — confirming the maintainer's position. Forking would mean diverging from a healthy upstream over a feature its author has explicitly chosen not to absorb. Maintenance burden compounds with every Ink release we'd need to rebase.
- **OpenTUI** — rejected. Not production-ready as of Phase 1 evaluation; would force a TUI rewrite for a benefit (scroll) we can buy as a 50-LoC peer-dep import.
- **react-blessed** — rejected. Repository abandoned. Migrating to a dead renderer trades one missing feature for unbounded technical debt.

## Forward-looking notes

When Ink lands native scroll primitives (tracked in issue [vadimdemedes/ink#765](https://github.com/vadimdemedes/ink/issues/765); no timeline announced), migrate by:

1. Replacing `ink-scroll-view` / `ink-scroll-list` imports with the native equivalents.
2. Removing the peer-dep from `package.json`.
3. Removing this ADR's `Status` from `Accepted` to `Superseded by NNNN` and filing the new ADR.

PR-4 reviewers should confirm `ink-scroll-view`'s peer range covers Ink 6.8.0 at the time of merge. If it falls behind, hold the PR until the package catches up rather than pinning a stale version — the whole point of userland-over-fork is letting upstream do the work.

## References

- Phase 1 research report by tempo-researcher (2026-04-26).
- [Ink issue #222](https://github.com/vadimdemedes/ink/issues/222) — maintainer position on scroll-in-userland.
- [Ink PR #764](https://github.com/vadimdemedes/ink/pull/764) — Gemini CLI's native scroll PR, closed unmerged.
- [Ink issue #765](https://github.com/vadimdemedes/ink/issues/765) — future native scroll primitives.
- npm package: [`ink-scroll-view`](https://www.npmjs.com/package/ink-scroll-view).
