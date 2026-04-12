# `test/workflows/` — workflow-invariant tests

Single-adapter (non-parameterized) tests that assert correctness of `claudeSessionWorkflow` invariants introduced or touched in the v0.25 rebuild.

## Scope

- **In scope**: workflow-level state machine / phase-transition invariants, timer races (§9.5), the CAN-boundary lease extension (§2.3), pause / spawn-drain interactions, stale `expectedAttachmentId` handling.
- **Out of scope**: per-adapter conformance (see `test/conformance/`), registry / descriptor validation (see `test/conformance/registry.test.ts`), wire-protocol drift detection (see `test/wire-protocol.test.ts`), cross-host / daemon reconcile (PR-E+ territory).

## Relation to existing PR-A coverage

PR-A shipped two flat test files covering primitives:

- `test/session-phase-machine.test.ts` — 15 cases for phase reachability and transition rules (§2.2, §2.4, §9.2).
- `test/session-lease.test.ts` — lease renewal + CAN-boundary boot-side restoration (§2.3 post-CAN).

Tests in this directory **do not duplicate** those — they cover invariants that PR-A could not reach (e.g. the pre-CAN extension math, pause interactions, future orphan-reconcile paths). Cross-references live in individual test-file docstrings.

## Why most tests are stubbed

PR-G is scaffolding. Several workflow-invariant tests depend on harness features that are not in place yet:

- `continueAsNew` deterministic triggering from TestWorkflowEnvironment (needed for extension-before-CAN)
- Mock spawn activities that record invocations without launching real processes (needed for pause + spawn-drain)
- Daemon reconcile-on-boot simulation (PR-E territory)

Each stub carries a specific `// TODO (PR-X):` comment naming the enabling change. Un-skip when the harness gains the feature or the upstream PR lands.

## Adding a new workflow-invariant test

1. Create `test/workflows/<invariant-name>.test.ts`.
2. Use `setupTestEnv()` / `teardownTestEnv()` / `withWorker()` from `test/helpers.ts` — same patterns as `test/session-phase-machine.test.ts`.
3. Reference the design doc section this invariant comes from.
4. If the test duplicates something already in `test/session-phase-machine.test.ts` or `test/session-lease.test.ts`, don't add it — extend the existing file instead (per architect-2 guidance).

Design reference: `docs/design/session-lifecycle-rebuild-v2.md` §§2.3, 8, 9.5, 10.
Sequencing memo: `docs/design/session-lifecycle-rebuild-v2-sequencing.md` §3 PR-G.
