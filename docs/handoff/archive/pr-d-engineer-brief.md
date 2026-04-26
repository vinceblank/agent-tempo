# PR-D engineer brief — v0.25 session lifecycle rebuild

> Handoff from the PR-C engineer. Written at the squash-merge of PR #133
> (`a5feca5` — "feat(v0.25): session lifecycle rebuild — 7-phase machine +
> attachment lease model"). Target reader: a competent TypeScript engineer
> with no prior `claude-tempo` exposure beyond [`CLAUDE.md`](../../CLAUDE.md).

## 1. What's on main

**PR-A/B/C foundations are live at `origin/main`** (tip `a5feca5`):

- **Adapter registry** (`src/adapters/index.ts`, `src/adapters/base.ts`) —
  `AdapterRegistry` keyed by `adapterId`. Shipped: `InteractiveAttachment`
  (Claude Code CLI, 60s heartbeat, `src/adapters/claude-code/`),
  `CopilotSdkAttachment` (Copilot bridge, 30s heartbeat,
  `src/adapters/copilot/`). Both extend `BaseAttachment`; the SDK class
  additionally extends `SdkAttachment` (`src/adapters/sdk/base.ts`) for
  synchronous `processingStart`/`End` pairing + split-brain cancel.
- **7-phase state machine** — `booting`, `attached`, `processing`,
  `awaiting`, `draining`, `detached`, `gone`. Phase is surfaced as the
  `ClaudeTempoAttachmentState` search attribute and via the
  `attachmentInfo` query. Transitions are driven by `claimAttachment` /
  `heartbeat` / `processingStart` / `processingEnd` / `requestDetach` /
  `adapterExited` / `forceDetach` / `destroy`. Authoritative reference:
  [`docs/design/session-lifecycle-rebuild-v2.md`](../design/session-lifecycle-rebuild-v2.md)
  §§2.2, 2.4.
- **Feature flag** — `CLAUDE_TEMPO_LIFECYCLE_V2` default **ON**
  (`src/config.ts` `lifecycleV2Enabled()`). Rollback to V1 shim is
  opt-out via `CLAUDE_TEMPO_LIFECYCLE_V2=0`.
- **Quarantined legacy shim** at `src/workflows/session.ts` ~line 364
  (look for `TODO(v0.25.1): remove this shim branch — tracked in #132`).
  The `updateMetadata({ status: 'terminated' })` signal handler redirects
  onto the §2.5 destroy path to keep ~30 legacy test fixtures working.
  Prod callers all migrated to `destroyUpdate`.
- **`SpawnOutboxEntry` union variant** (`src/types.ts` ~line 340, added in
  PR-C commit 6 for #118). Type is live; dispatcher branch is live; the
  5 attachment-specific fields (`attachmentId`, `attachmentRunId`,
  `resumeAttachment`, `sessionId?`, `adapterId`) are typed but **not yet
  forwarded** into the `startRecruitedSession` / `spawnProcess` activities.
  That wiring is PR-D's core job.

Test count on main post-PR-C: 670 mocha passing + 21 pending + 0 failing,
69 vitest passing + 3 todo, wire-protocol drift detector green.

---

## 2. Remaining ladder scope

### PR-D — new verbs + spawn activity wiring (NEXT)

Two retirement sites remain after PR-C:

1. **`performEncore` / `checkAndSetStatus` site** — PR-C deferred this.
   The `checkAndSetStatusUpdate` update is still called from
   `src/activities/outbox.ts` `performEncore` activity (~line 356) to do an
   atomic `stale → pending` transition before restart. Design §11.4 calls
   for `checkAndSetStatus` to be removed entirely; the replacement is a
   `forceDetach` + fresh `claimAttachment` pair on the restart path
   (§8.2 "restart algorithm"). This touches encore orchestration, which is
   why PR-C left it alone.

2. **`SpawnOutboxEntry` consumer wiring** — the 5 attachment fields on
   the union variant must be forwarded into the spawn path so an adapter
   can boot into a pre-claimed attachment rather than the current
   "claim-on-first-boot" pattern. Design §8.2 spells out the restart
   algorithm this enables.

PR-D also owns the new-verbs wiring for `restart` and `migrate` per §8.1
("three verbs"). Unknown to me: whether `migrate` is in PR-D scope or
deferred — design §9.6 exists but the sequencing memo doesn't pin it.
**Ask the conductor before designing for `migrate`.**

### PR-E — daemon restore / reconcile-on-boot

Design §10 territory. My read, stated as "best guess — verify before
coding":

- `claude-tempo daemon` gains a reconcile-on-boot pass that queries for
  orphaned detached sessions via `ClaudeTempoAttachmentState=detached`
  search attribute, reads `orphanSummary` query for each, and applies a
  `restorePolicy` decision tree (§10.2). Sessions in `detached` with a
  `preferredHost` matching the local host get auto-restored via a fresh
  `spawnProcess` → `claimAttachment` flow.
- CLI `restore` command (§10.3) for manual operator intervention.
- This depends on PR-D's `restart` verb landing first.

**Do not invent §10 details.** Read the design doc and cue the conductor
if anything looks ambiguous.

### PR-F — unknown-to-me scope

I never touched PR-F directly; my handoff notes didn't list its contents.
**Ask the conductor** for the scope before planning. My best guess based
on the ladder memo: either polish + stabilization (if PR-D/E are large)
or the v0.25.0 GA cut itself (flag removal + v0.25.1 shim cleanup #132).

---

## 3. PR-D specifics

### Site (a): `performEncore` migration

- **Current state**: `src/activities/outbox.ts` `performEncore` activity
  (~line 340-380) queries the target session's metadata, calls
  `handle.executeUpdate(checkAndSetStatusUpdate, {args: [{expectedStatus:
  'stale', newStatus: 'pending'}]})`, then injects a context message and
  returns spawn params.
- **Target state per design §8.2**: replace the CAS with `forceDetach`
  (idempotent on `detached` — will return `{reaped: false}` if already
  free) followed by a fresh `claimAttachment`. Carry the new attachment
  token into the spawn entry so the restarted adapter picks up the
  pre-claimed attachment without racing.
- **Wire-protocol touches**: none new. Reuses existing `forceDetach` +
  `claimAttachment` + `enqueueSpawn` updates.
- **Test home**: `test/activities.test.ts` has existing `performEncore`
  coverage. Migrate those assertions to expect `forceDetach` + `claim`
  updates instead of `checkAndSetStatus`.
- **After migration**: delete the `checkAndSetStatusUpdate` handler from
  `src/workflows/session.ts` (~line 434) AND the update definition from
  `src/workflows/signals.ts`. This is a wire-protocol removal → **MUST**
  update `docs/WIRE-PROTOCOL.md` in the same commit (ts-morph drift
  detector will catch it otherwise).

### Site (b): `SpawnOutboxEntry` consumer wiring

- **Type reference**: `src/types.ts` `SpawnOutboxEntry` interface
  (~line 340). The 5 fields to plumb: `attachmentId`, `attachmentRunId`
  (maps to `runId` on `Attachment`), `resumeAttachment` (boolean —
  `claude --resume` or fresh), `sessionId?`, `adapterId`.
- **Dispatcher**: `src/workflows/session.ts` `case 'spawn':` branch
  (~line 1260, at end of the outbox-dispatch inner loop). Currently
  calls `spawnFn({targetName, workDir, isConductor, agent, ensemble,
  temporalAddress, temporalNamespace, sessionId, resume})` — the 5 fields
  are on the typed entry but the spawnFn input signature doesn't have
  them all. Extend the activity input type to receive them.
- **Activities**:
  - `src/activities/outbox.ts` `startRecruitedSession`  — not used by
    `case 'spawn':` today; design §8.2 has it staying recruit-only.
  - `spawnProcess` activity (the per-host one) — this is where
    `attachmentId`/`attachmentRunId`/`resumeAttachment`/`adapterId`
    need to land, so the spawned process carries them via env or
    CLI args and `BaseAttachment.startV2Lifecycle()` uses them as
    its `expectedAttachmentId` instead of claiming fresh.
  - Look at `src/spawn.ts` (`spawnInTerminal`, `spawnCopilotBridge`) for
    the env-var plumbing convention (uses `ENV.*` constants in
    `src/config.ts`).
- **Adapter side**: `src/adapters/base.ts` `startV2Lifecycle(workflowId)`
  currently always calls `claimAttachment` with no `expectedAttachmentId`
  — it claims fresh. Extend it to accept a pre-claimed token from env,
  and if present, use it as the `expectedAttachmentId` on a renewal
  claim.

### Expected scope

This is **bigger than any single PR-C commit**. Target ≤1200 LOC across
workflow + activities + adapters + tests. If it balloons past that,
split into "PR-D1 (encore + checkAndSetStatus retirement)" + "PR-D2
(spawn wiring + restart verb)" — check with conductor first.

---

## 4. Gotchas discovered during PR-A/B/C

Each trap is 2–4 lines. Every one of these cost me at least one cycle.

### G1. SIGINT semantics: graceful detach, NOT destroy
The MCP server's SIGINT/SIGTERM handler at `src/server.ts` shutdown used
to fire `updateMetadata({status:'terminated'})` which destroyed the
workflow. PR-C removed it — closing a terminal must detach only, leaving
the workflow in `detached` for future `encore`. If you add a new shutdown
path, never destroy on SIGINT. `stop` tool / CLI `stop` = destroy; SIGINT
= detach.

### G2. `fireTerminal('destroy')` vs `'agent-exited'` (C1)
`src/adapters/base.ts` classifies `WorkflowNotFound` errors. PR-C dual-QA
caught that the heartbeat + phase-watcher catches were firing
`'agent-exited'` (meaning: our process died) when they should fire
`'destroy'` (meaning: the session workflow COMPLETEd). If you add a new
error classifier, `agent-exited` is for local failures only.

### G3. `configureV2()` foot-gun guard (C3)
`BaseAttachment.configureV2(client, host)` is a lazy setter for the
Copilot bridge subprocess. PR-C dual-QA added a guard that throws if it's
called after `startV2Lifecycle()` issues a token. Don't remove the guard;
don't work around it. Configure before claim or refactor the class
hierarchy to hoist the claim.

### G4. `markDeliveredSignal` must be a typed constant, not a literal (C4)
The ts-morph drift detector in `test/wire-protocol.test.ts` scans for
references to signal/query/update constants to validate protocol
coverage. **String-literal calls like `handle.signal('markDelivered',
...)` are invisible to the scan.** Always import the constant from
`src/workflows/signals.ts`. Legacy path strings in `copilot/adapter.ts`
(~line 444) are intentionally isolated for PR-D migration — their drift
is known.

### G5. Legacy terminate shim routes to destroy, not drain-wait
`src/workflows/session.ts` `updateMetadataSignal` handler's
`status === 'terminated'` branch (~line 364) is a test-compat shim that
routes onto `destroyRequested = true` (§2.5 abandon-in-flight
semantics). It no longer waits 2 minutes for drain — that behavior
was retired in PR-C commit 4. Removal scheduled for v0.25.1 per **#132**.

### G6. Awaiting-phase needs TWO entry paths (#117)
`setPhase('awaiting')` is called from (a) `processingEndUpdate` handler
when in-flight drops to 0 AND outbox is idle, and (b) the main loop as
a refinement after outbox-dispatch drain. (a) is for the messages path,
(b) is for the spawn/cue/report path (entries that complete without
passing through `processing`). If you delete one, you'll silently
regress #117 because the other only covers half the entry paths.

### G7. Heartbeat-timeout is handled phase-agnostically at §9.5.a
`src/workflows/session.ts` ~line 1077: the lease-expiry main-loop check
handles `attached | awaiting | processing → detached` uniformly because
`setPhase('detached')` is unconditional in that branch. No per-phase
code path exists (or needs to exist). This was the punchline of PR-C
commit 6 "deferred heartbeat-timeout wiring" — there was nothing to wire;
the reap was already right.

### G8. `SpawnOutboxEntry` fields are dead until PR-D
PR-C commit 6 introduced the discriminated-union variant to remove the
double cast, but the 5 attachment-specific fields are stored on the
entry and never read by the dispatcher or activity. This is a known gap
— PR-D wires them. Don't "fix" it by deleting the fields or the
dispatcher case; the scaffolding is intentional.

### G9. `#120` was resolved by commit 4 (`34dc888`), not a separate fix
If you see a mention of #120 ("main-loop comment drift"), it's
informational — the comment got corrected as a side effect of the shim
redirect landing in PR-C commit 4. No code change was made; no code
change is needed. Closed as "fixed by 34dc888".

### G10. Windows worktree CRLF noise
Every `git add` on Windows will emit LF/CRLF warnings. Harmless.
Don't spend cycles trying to "fix" `.gitattributes`.

### G11. Validator false-positives on `setTimeout` in adapter + test files
The `posttooluse-validate` hook flags `setTimeout` / `setInterval` as
workflow-sandbox violations for **any** file under `src/` or `test/`.
Adapters and tests are Node.js processes, not workflow code. Ignore the
errors. Don't refactor to `sleep()` from `'workflow'` — that's
workflow-bundle-only.

### G12. Workflow bundle rebuild required after `src/workflows/` changes
`npm run build` pre-bundles workflow code into `workflow-bundle.js`. If
you touch anything in `src/workflows/`, you MUST rebuild or tests run
against stale bundled code. `pretest` handles this automatically when
`npm test` is run, but if you're running individual files via `npx
mocha`, rebuild manually.

### G13. Wire-protocol doc = same-commit update
The ts-morph drift detector catches names but not doc drift semantics.
If you add or remove a signal/query/update, update
[`docs/WIRE-PROTOCOL.md`](../WIRE-PROTOCOL.md) in the same commit. Per
`CLAUDE.md`: "renaming or removing any is a breaking change requiring a
major version bump."

### G14. Lease renewal overwrites `leaseMs` on `Attachment`
PR-C commit 6 added `leaseMs: number` to `Attachment`. The
`claimAttachmentUpdate` renewal path (~line 615 in session.ts) overwrites
`currentAttachment.leaseMs` with the caller's new value. If you change
the rule (e.g. pin-at-claim), you'll break the heartbeat extension
semantics #119a established. Verify with `test/session-phase-machine.test.ts`
"heartbeat renews expiresAt by the claim-time leaseMs" case.

---

## 5. Test harness pointers

### Key files

- **`test/session-phase-machine.test.ts`** — the canonical home for phase
  transition invariants (§2.2/§2.4). 23 cases post-PR-C. Add phase-related
  invariants here, not in new files (per architect-2 guidance in
  `test/workflows/README.md`).
- **`test/session-lease.test.ts`** — lease renewal + CAN-boundary seed.
  Note: the pre-seeded `Attachment` fixture requires `leaseMs` (added
  in PR-C commit 6 for #119a).
- **`test/wire-protocol.test.ts`** — ts-morph-based drift detector
  (PR-G, #125). Runs as part of `npm test`. If you rename a signal
  constant or change its `defineSignal` generic, this catches it.
- **`test/activities.test.ts`** — outbox activity mocks. The `mockHandle`
  helper at ~line 44 tracks `signals` AND `updates` arrays — for
  `destroy`-vs-`updateMetadata` assertions, use `updates[]`.
- **`test/workflows/can-boundary-extension.test.ts`** and
  **`test/workflows/pause-spawn-drain.test.ts`** — pending PR-G stubs,
  skipped until harness gains CAN deterministic triggering + mock spawn
  activities. Do NOT un-skip without first implementing the enabling
  infra.
- **`test/adapter-*-lifecycle-v2.test.ts`** — V2 lifecycle integration
  tests for the two shipped adapters. If you change `BaseAttachment` or
  `SdkAttachment`, these will catch behavior drift.

### Running subsets

```bash
# Full suite (includes pretest workflow rebuild):
npm test

# Only vitest (TUI + client):
npx vitest run tests/

# Focused mocha (you can pass a spec, but .mocharc.yml globs everything
# anyway — use mocha's --grep to filter by test title):
npx mocha --grep 'awaiting' dist-test/test/**/*.test.js
```

### Known quirks

- `npm test` output on Windows backgrounds mocha stdout until completion.
  Use `| tail -N` only if the run finishes cleanly; for live visibility
  drop the tail.
- Blocked-detection tests use `setTimeout` polling with real clocks
  (`createLocal()` TestWorkflowEnvironment — no time-skipping). Expect
  2–3s real time per assertion-polling iteration.
- The `expired pre-seeded attachment is reaped on boot` case in
  `session-phase-machine.test.ts` polls up to 2s for the main-loop
  reap. Not flaky in practice but timing-dependent.

---

## 6. Don't touch

### Wire-protocol names are frozen as of v0.25.0-beta.1
All signal/query/update names are documented in
[`docs/WIRE-PROTOCOL.md`](../WIRE-PROTOCOL.md). Renaming requires a major
version bump per `CLAUDE.md` Release Process. If you think you need to
rename something, cue the conductor and explain why.

### v0.25.1 shim cleanup (#132) is explicitly deferred
The quarantined `updateMetadata({status:'terminated'})` handler branch in
`src/workflows/session.ts` and the ~30 test fixtures using it as cleanup
are scheduled for v0.25.1. Do NOT migrate them opportunistically in PR-D
unless explicitly asked — the shim's presence is the rollback insurance
for V2=0 incidents.

### `hardTerminate` CLI flag is an intentional escape hatch
`src/cli/commands.ts` `--hard-terminate` passes
`updateMetadata({status:'terminated'})` directly. Post-PR-C it routes
through the shim to destroy. Kept as an escape hatch for stuck
workflows; removal might be considered in v0.25.1 alongside #132.

### `LEASE_MS` workflow constant — stays deleted
Do NOT reintroduce a workflow-side default lease constant. Per-attachment
`leaseMs` is the design (#119a). If you need a default, put it at the
caller boundary (e.g. `BaseAttachment` descriptor).

### Legacy copilot-adapter string-literal signals (~line 444)
`copilot/adapter.ts` still has `handle.signal('updateMetadata', ...)` in
one spot. tempo-qa flagged it in PR-C review as intentional legacy
isolation, deferred to PR-D with the new-verbs wiring. Migrate with the
rest of the adapter when you do the spawn-entry plumbing.

---

## 7. Open questions for the conductor

Before starting PR-D, surface these:

1. **`performEncore` migration scope** — inline in PR-D, or split as
   PR-D1 (encore) + PR-D2 (spawn wiring + restart verb)?
2. **`migrate` verb (§9.6)** — in PR-D scope or deferred? Design doc has
   the section but the sequencing memo doesn't explicitly list it.
3. **Spawn activity signature extension** — OK to add
   `attachmentId`/`runId`/`resume`/`adapterId` params to `spawnProcess`
   directly, or introduce a dedicated `restartSpawn` activity to keep
   the fresh-spawn path separate?
4. **`BaseAttachment.startV2Lifecycle` extension** — add an optional
   `expectedAttachmentId` param, or add a separate
   `resumeV2Lifecycle(token)` method? Either works; conductor should
   pick the API shape they prefer.
5. **v0.25.1 cleanup ordering** — does the shim removal (#132) land
   before or after v0.25.0 GA? If before, consider absorbing it into
   PR-D/E to avoid a separate patch release.
6. **PR-F scope** — unknown to me. Ask before designing.

---

## Quick-reference links

- Design doc: [`docs/design/session-lifecycle-rebuild-v2.md`](../design/session-lifecycle-rebuild-v2.md)
- Sequencing memo: [`docs/design/session-lifecycle-rebuild-v2-sequencing.md`](../design/session-lifecycle-rebuild-v2-sequencing.md)
- Wire protocol: [`docs/WIRE-PROTOCOL.md`](../WIRE-PROTOCOL.md)
- CHANGELOG entry: [`CHANGELOG.md`](../../CHANGELOG.md) `[0.25.0-beta.1]`
- PR-C itself: [#133](https://github.com/vinceblank/claude-tempo/pull/133) (squash-merged as `a5feca5`)
- Tracked issues: #117 ✓closed · #118 ✓closed · #119 ✓closed · #120 ✓closed · #132 (deferred)
- Key issues to know: #99 (false-stale, PR-A), #102 (zombie-resurrection, PR-A), #117 (awaiting phase, PR-C)

Good luck. The foundation is solid; every surprise is documented above.
