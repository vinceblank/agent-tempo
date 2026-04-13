# QA Rubric — claude-tempo PRs

Primary code-correctness lens. Single-pass from PR-D onward.
Written by tempo-qa after PR-C review. No Temporal or claude-tempo prior knowledge assumed.

---

## 1. The 12 Review Criteria

Each criterion is tagged: **GENERIC** (every PR), **PHASE-MACHINE** (session lifecycle changes), **PR-C-SPECIFIC** (one-off, skip for PR-D+).

### C1 — Workflow Determinism `GENERIC`

No non-deterministic code in `src/workflows/`. Banned: `Date.now()`, `Math.random()`, `setTimeout`/`setInterval`, Node.js imports (`os`, `fs`, `crypto`, etc.), `new Date()`.

Allowed replacements: `workflow.now()` (time), `uuid4()` from `@temporalio/workflow` (random), `workflowLog` (logging).

**How to check:** `grep -r "Date\.now\|Math\.random\|setTimeout\|require('os')\|require('fs')" src/workflows/`

If any hit is inside `src/workflows/`, it's a blocker.

### C2 — `continueAsNew` state carry `GENERIC`

When workflow state variables are added or removed, the `continueAsNew` input spread (bottom of `session.ts` main loop, ~line 1385) must be updated. Every new field that must survive session restarts must appear there.

**How to check:** Find `await continueAsNew<typeof claudeSessionWorkflow>({` and verify every new `SessionInput` field is either spread from `...input` or explicitly listed.

### C3 — Signal handler registration order `GENERIC`

In Temporal workflow code, `setHandler()` calls must appear before the first `await` / `condition()` in the workflow body. Handlers registered after an `await` can miss signals sent before the await resolves.

**How to check:** Scan `src/workflows/session.ts` — all `setHandler(...)` calls should be in the pre-loop setup block, not inside the main `while` loop or after `await condition(...)`.

### C4 — Outbox compliance `GENERIC`

Tools in `src/tools/` must **never** directly signal another workflow. Cross-workflow actions go through the session's own outbox via `handle.executeUpdate(submitOutboxUpdate, ...)`. New outbox entry types need:
1. New `*OutboxEntry` interface in `src/types.ts` added to the `OutboxEntry` union.
2. A `case 'newtype':` branch in the dispatch loop in `src/workflows/session.ts`.

**How to check:** Grep `src/tools/` for `.signal(` and `.executeUpdate(` — any direct cross-workflow call is a blocker.

### C5 — Wire protocol stability `GENERIC`

Signal/query/update names in `src/workflows/signals.ts`, `scheduler-signals.ts`, `maestro-signals.ts` must not be renamed or removed. These are the stable public API.

If names are added, `docs/WIRE-PROTOCOL.md` must be updated in the same commit.

**How to verify:** `npm run test:conformance` — the wire-protocol drift detector fails if source and docs diverge.

### C6 — Tool pattern `GENERIC`

New tools in `src/tools/` must:
- Use `defineTool()` helper (not `server.tool()` directly)
- Declare Zod schema as `Record<string, z.ZodTypeAny>` (not a Zod object shape)
- Cast args: `args as { fieldName: type }`
- Return `{ content: [{ type: 'text', text }], isError?: boolean }`
- Be registered in `src/server.ts`
- Use constants from `src/utils/validation.ts` for limits (not hardcoded numbers)

### C7 — Activity pattern `GENERIC`

Activities in `src/activities/` must use `ApplicationFailure.nonRetryable()` for permanent failures (not generic `Error`). Retry-safe / idempotent where possible. Factory function pattern: exported interface + `createActivities(client, config)` factory.

### C8 — Feature flag behaviour `PR-C-SPECIFIC`

`CLAUDE_TEMPO_LIFECYCLE_V2`: default ON, explicit `0/false/off/no` disables, typo-safe (any other value stays ON). Verified in PR-C. Skip for PR-D unless the flag surface changes.

### C9 — SIGINT / shutdown semantics `PHASE-MACHINE`

Session shutdown (SIGINT/SIGTERM) must result in graceful detach (`adapterExited` → `draining → detached`), not destroy. Only the `stop` tool / CLI explicit-terminate path uses `destroyUpdate`. Check `src/server.ts` and adapter `cleanup()` functions.

**How to check:** Grep `updateMetadata.*terminated\|status.*terminated` in `src/server.ts` and adapter files. Any hit outside a `hardTerminate` guard is a blocker.

### C10 — Phase transition correctness `PHASE-MACHINE`

When touching `src/workflows/session.ts` signal/update handlers, verify transitions against the seven-phase spec (`docs/design/session-lifecycle-rebuild-v2.md` §2.4):

```
booting → attached (claimAttachment)
attached → processing (processingStart)
processing → attached | awaiting (processingEnd, in-flight hits 0)
awaiting → processing (processingStart)
attached | awaiting → draining (requestDetach)
draining → detached (adapterExited OR drainingDeadline)
detached → attached (claimAttachment)
any → gone (destroy)
```

`awaiting` is the idle refinement of `attached` — entered from `processingEnd` when outbox is also idle, or from the main-loop refinement after outbox drain. It is NOT a separate attachment state.

### C11 — Shim non-regression `PHASE-MACHINE`

The PR-A compat shim (`updateMetadata({ status: 'terminated' })` → `destroyRequested = true`) must remain intact until PR-D explicitly retires it. Tests in `test/workflow.test.ts` and `test/destroy.test.ts` exercise pre-v0.25 callers. Do not remove the shim handler without updating those tests first.

### C12 — Test coverage completeness `GENERIC`

New features must have tests. Bug fixes must have a regression test (failing test first). Minimum expectations:

- New workflow signal/update handlers → test in `test/session-phase-machine.test.ts` or a dedicated file
- New tools → test in `test/tools.test.ts` or dedicated file
- New adapter behaviour → test in `test/adapter-*.test.ts`
- `spawnProcess` activity must be mocked in recruit tests (don't actually spawn processes)
- All workflows terminated cleanly in tests (either `destroyUpdate` or `handle.result()` drain)

---

## 2. PR-D Watch-List

PR-D scope: **performEncore retirement + SpawnOutboxEntry consumer**.

### Determinism in encore path

Encore logic currently lives in `src/activities/outbox.ts` (`performEncore` activity). If any encore work moves into `src/workflows/session.ts`, verify no `Date.now()`, `crypto.randomUUID()`, or fs/os imports leak in.

### SpawnOutboxEntry full wiring

PR-C planted `SpawnOutboxEntry` but left 5 fields unused at the activity layer (`attachmentId`, `attachmentRunId`, `resumeAttachment`, `sessionId`, `adapterId`). PR-D wires them through `spawnProcess`. Verify:
- `spawnProcess` activity signature accepts all 5 new fields
- Fields are forwarded to the adapter spawn command (not silently dropped)
- `SpawnProcessInput` in `src/activities/outbox.ts` updated to match
- `case 'spawn':` in session.ts passes the fields through

### Outbox ordering invariant

`continueAsNew` carries `outbox.filter(pending|processing)` entries. If PR-D adds new entry types or changes dispatch priority, verify the order is preserved — outbox is processed FIFO and `stop` entries bypass pause (see `case 'stop':` dispatch branch). Adding new bypass cases must be explicit and tested.

### Phase invariants through encore

Encore revives a `stale` session (status-based pre-v0.25 concept). After PR-D the revived adapter must go through `claimAttachment` to transition `detached → attached`. Verify the encore path does NOT skip the claim step and does NOT fire the old `updateMetadata({ status: 'active' })` signal.

### Shim retirement

If PR-D retires the `updateMetadata({ status: 'terminated' })` shim, verify:
1. All 3 remaining callers in `test/` are updated
2. The shim handler block is removed from `src/workflows/session.ts`
3. `SessionStatus.terminated` usages audited (`src/types.ts` deprecation comment)

---

## 3. Test Commands

```bash
# Full build (must pass before any review verdict)
npm run build

# Full test suite (670 passing baseline as of PR-C; 21 pending = conformance stubs)
npm test

# Wire-protocol drift detector + conformance suite
npm run test:conformance

# Focused: phase machine (most relevant for lifecycle changes)
npx mocha --require ts-node/register test/session-phase-machine.test.ts

# Focused: adapter lifecycle
npx mocha --require ts-node/register test/adapter-claude-code-lifecycle-v2.test.ts test/adapter-sdk-lifecycle-v2.test.ts

# Focused: outbox + activities
npx mocha --require ts-node/register test/outbox.test.ts test/activities.test.ts

# After any workflow code change — rebuild the bundle explicitly
# (npm run build does this; the tsc-only step does NOT rebundle)
npm run build
```

**Workflow bundle note:** `src/workflows/` changes require `npm run build` to regenerate `workflow-bundle.js`. `tsc --noEmit` (CI type-check) does not update the bundle. Tests run against the compiled bundle — a stale bundle will produce confusing test failures that don't match the TypeScript source.

---

## 4. Red Flags — Block vs. File Follow-Up

### Block the PR immediately

| Flag | Why |
|------|-----|
| Determinism violation in `src/workflows/` | Silent history corruption; workflow will replay incorrectly after worker restart |
| Wire-protocol name rename/removal without WIRE-PROTOCOL.md update | Breaking change for all running sessions |
| Direct cross-workflow signal from `src/tools/` (outbox bypass) | Breaks at-least-once delivery guarantees |
| SIGINT path calling `destroyUpdate` or `updateMetadata({status:'terminated'})` | Destroys sessions on every terminal close |
| Missing `continueAsNew` field for new persistent state | Silent data loss on history boundary |
| New tool not registered in `src/server.ts` | Tool silently unavailable to callers |
| Tests deleted or `it.skip`'d without explanation | Regression coverage gap |

### File a follow-up issue (not a blocker)

| Flag | Action |
|------|--------|
| String literal signal/query name at call site (not a `defineSignal` const) | Drift risk; create issue for typed export |
| Missing `ApplicationFailure.nonRetryable` on permanent activity errors | Retry storm risk; file issue |
| `configureV2()` called after `startV2Lifecycle()` (no runtime guard) | Defense-in-depth gap; file issue |
| CHANGELOG missing operator rollback notes | Documentation gap; file issue |
| Inconsistent `DetachReason` in terminal paths | No functional impact; file issue |

---

## 5. Review Cadence

### Standard pattern: full pass + delta verify

**Full pass** (new PR):
1. Read the branch diff top-to-bottom to understand intent and scope.
2. Check determinism (C1) first — it's the highest-severity class.
3. Walk the 12 criteria in order, marking each.
4. Run `npm run build` and `npm test`.
5. For lifecycle PRs, run the phase-machine focused test to confirm transitions.
6. File verdict.

**Delta verify** (author pushed a fix commit):
- Read only the new commit's diff.
- Re-run build + full tests.
- Confirm the specific criterion that was failing now passes.
- Do NOT re-read the full diff — the initial pass already captured the baseline.

### What delta verify checks

When an author fixes a flagged issue, verify:
1. The fix addresses the root cause (not just the symptom).
2. The fix did not introduce a new issue in adjacent code.
3. Tests still pass end-to-end (not just the targeted test).

### Time expectations

- Full pass (50-file PR like PR-C): 45–60 min including test run
- Delta verify (1–3 commit fix): 10–15 min
- Wire-protocol conformance: always run, adds ~30s
