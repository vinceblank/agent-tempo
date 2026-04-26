# ADR 0006 — Test-only hooks live with the module they reset, named `__<verb><Noun>ForTests`

- **Status:** Accepted
- **Date:** 2026-04-26
- **Closes:** #282
- **Drivers:** First test-only hook in the codebase (`__resetHostsCacheForTests`)
  surfaced the question of where these belong as more caching layers land.

## Context

`__resetHostsCacheForTests`, exported from `src/utils/hosts.ts`, is the codebase's
first `__reset*ForTests` symbol. It exists because the host-discovery join layer
(`listHosts`) holds a 3-second module-level cache, and unit tests need to reset
between cases. This pattern is likely to spread (other caches, memoized
clients, lazy-init singletons), so the convention deserves to be made explicit
before a second case forces an inconsistent precedent.

Three flavours have been observed in TypeScript codebases reviewed for this ADR:

1. **Co-located with module** — export `__reset*ForTests` from the same file
   that owns the state.
2. **Centralized hooks module** — gather hooks in `src/test-hooks/` (or similar)
   and re-export.
3. **No hooks; restructure for purity** — drop module-level state in favour of
   passing state through arguments. Avoids hooks but requires rewriting the
   API.

## Decision

**Co-locate test-only hooks with the module they reset and name them
`__<verb><Noun>ForTests`.**

Rules:

- **Naming:** `__<verb><Noun>ForTests` — leading double-underscore signals "do
  not call from production code"; the `<verb><Noun>` shape mirrors the action
  ("reset", "clear", "set", "freeze") plus the thing acted on. Always end in
  `ForTests`.
- **Location:** the same file that owns the state. No `src/test-hooks/`
  directory.
- **Scope:** hooks are an escape hatch, not API. They MUST NOT be re-exported
  through barrels (`src/index.ts`, `src/utils/index.ts`, etc.) or surfaced on
  `TempoClient`.
- **Doc-comment:** a one-line `/** Test hook — never call from production code. */`
  on the export. Helps grep and code review.
- **Consumers:** `test/`, `tests/`, and direct fixtures only. Production code
  never imports a `__*ForTests` symbol.

## Rationale

Co-location wins on three axes:

- **Cohesion.** The hook is mechanical knowledge about *this* module's state.
  Moving it elsewhere splits one concept across two files for no gain.
- **Discoverability.** Reading `hosts.ts` shows you everything that touches the
  cache, including the test escape hatch. A separate hooks directory hides this
  unless you also know to look there.
- **Refactor pressure.** When the hook list in a centralized module grows, it
  becomes its own god-object. Co-located hooks scale linearly.

The `__<verb><Noun>ForTests` shape is chosen over alternatives:

- `resetForTests` — too generic; ambiguous when a module exports more than one
  reset hook.
- `__reset` — conflicts with privately-scoped names; doesn't telegraph "test
  use only".
- `_reset` — single-underscore is sometimes used for module-private helpers; the
  `__` prefix reserves a clear lane for hooks.

## Enforcement

- **Formal:** none for now. With a single hook in the codebase, an ESLint rule
  (e.g., banning imports of `__*ForTests` from outside `test/` and `tests/`)
  is over-engineered. Revisit if a second hook lands and the rule pays for
  itself.
- **Informal:** PR review and this ADR. New `__*ForTests` exports should
  reference this ADR in their doc-comment if non-obvious.

## Consequences

- New hooks follow the same pattern; no migration required for the existing
  `__resetHostsCacheForTests`.
- If the hook count grows past ~5 and review cost rises, escalate to an ESLint
  rule (or a `no-restricted-syntax` config) and update this ADR.
- The numbering follows the `docs/adr/README.md` index established by ADRs
  0001–0004 (SSE protocol design, `design/sse-protocol-spec`) plus ADR 0005
  (Ink scroll via userland package, PR #316). This ADR claims `0006`; future
  ADRs increment from there.

## References

- Issue #282 — surfaced during QA review of #274.
- `src/utils/hosts.ts` — `__resetHostsCacheForTests` (current sole hook).
- `test/hosts.test.ts` — sole consumer.
