# PR-E engineer brief — v0.25 session lifecycle rebuild

> Handoff from the PR-D engineer. Written at the squash-merge of PR #136
> on `feat/pr-d-encore-spawn-wiring`. Target reader: a competent TypeScript
> engineer with no prior `claude-tempo` exposure beyond
> [`CLAUDE.md`](../../CLAUDE.md).

## 1. What's on main

**PR-A/B/C/D foundations are live at `origin/main`** (tip: post-PR-D
squash-merge):

- **All seven V2 wire primitives** shipped in PR-A — `claimAttachment`,
  `forceDetach`, `processingStart`, `processingEnd`, `enqueueSpawn`,
  `setPreferredHost`, `destroy` updates; `heartbeat`, `requestDetach`,
  `adapterExited` signals; `attachmentInfo`, `orphanSummary`,
  `inFlightMessages`, `isDestroyed` queries. Documented in
  [`docs/WIRE-PROTOCOL.md`](../WIRE-PROTOCOL.md).
- **Adapter registry** (`src/adapters/index.ts`, `src/adapters/base.ts`) —
  `AdapterRegistry` keyed by `adapterId`. Shipped: `InteractiveAttachment`
  (Claude Code CLI, 60s heartbeat), `CopilotSdkAttachment` (Copilot bridge,
  30s heartbeat). Full V2 lifecycle wired: claim, heartbeat loop, lease
  expiry reap, `adapterExited` teardown, `WorkflowGone` classifier.
- **7-phase state machine** — `booting`, `attached`, `processing`,
  `awaiting`, `draining`, `detached`, `gone`. Surfaced as
  `ClaudeTempoAttachmentState` search attribute and via `attachmentInfo`
  query.
- **PR-D verb surface** — `restart`, `detach`, `destroy`, `migrate`,
  `attachment-info` MCP tools live. `encore` MCP tool and CLI command
  deleted. `stop` MCP tool is a hint shim (real stop logic resides in CLI
  ensemble-level `claude-tempo stop`). SpawnOutboxEntry 5 attachment fields
  (`attachmentId`, `attachmentRunId`, `resumeAttachment`, `sessionId?`,
  `adapterId`) fully wired through workflow dispatcher → `spawnProcess`
  activity → `BaseAttachment.startV2Lifecycle`.
- **TempoClient** (`src/client/`) — `restart`, `detach`, `destroy`,
  `migrate`, `attachmentInfo` methods added in PR-D.
- **Feature flag** — `CLAUDE_TEMPO_LIFECYCLE_V2` default **ON**
  (`src/config.ts` `lifecycleV2Enabled()`). Rollback via
  `CLAUDE_TEMPO_LIFECYCLE_V2=0`.
- **Quarantined legacy shim** at `src/workflows/session.ts` ~line 364
  (look for `TODO(v0.25.1): remove this shim branch — tracked in #132`).
  The `updateMetadata({ status: 'terminated' })` handler routes onto §2.5
  destroy semantics. Removal deferred to v0.25.1.

Test count on main post-PR-D: check `npm test` output on first run —
expect approximately the same passing count as post-PR-C (670 mocha +
21 pending) plus PR-D's new verb-tool unit tests.

---

## 2. Remaining ladder scope

### PR-E — daemon reconcile-on-boot + restore policy (NEXT)

Full spec in §3 below. Short summary:

- `src/daemon.ts` gains `reconcileOnBoot()` and `cleanupLoop()`
- Config schema extended (`restorePolicy`, `autoRestoreMaxAgeHours`,
  `autoRestoreEnsembles`, `cleanupPolicy`) — `src/config.ts` reads them
- CLI `restore` command added to `src/cli/commands.ts`
- OS integration: `daemon install` / `daemon uninstall` with platform
  service files (`packaging/` subtree)
- Depends on PR-D's `restart` verb — **now merged, unblocked**

### PR-F — multi-host coordination capstone

Cross-host `restart` routing to `claude-tempo-{host}` task queues,
`--yes-steal=<hostname>` safety flag, `setPreferredHost` wiring in daemon
reconcile, multi-host integration tests via docker-compose harness.
Depends on PR-D **and** PR-E. Scope is pinned in
[`docs/design/session-lifecycle-rebuild-v2-sequencing.md`](../design/session-lifecycle-rebuild-v2-sequencing.md)
§2 (PR-F row). **Do not start PR-F until PR-E is merged.**

### PR-G — test suite + wire-protocol CI check

Tests, conformance suite, wire-protocol CI diff checker.
Can run in parallel with PR-E and PR-F. Partially landed already
(stubs in PR-G earlier). No action from you unless conductor assigns it.

---

## 3. PR-E specifics

### Overview

PR-E makes the daemon aware of session lifecycle. Before PR-E the daemon
just runs Temporal workers — it has no knowledge of what sessions exist or
whether they've been orphaned. After PR-E:

1. On boot, the daemon scans for workflows stuck in `detached` (adapter
   gone, workflow alive) and optionally restores them.
2. A background `cleanupLoop` compacts ancient detached and destroyed
   workflows to keep namespace clean.
3. A new CLI `restore` command gives operators manual access to the
   reconcile logic.
4. OS-level service integration (`daemon install`/`uninstall`) makes the
   daemon persistent across reboots.

Design reference: `docs/design/session-lifecycle-rebuild-v2.md` §10 (full
spec) and §13.4 (cleanup loop). Sequencing spec:
`docs/design/session-lifecycle-rebuild-v2-sequencing.md` §2 PR-E row.

---

### Site 1: `reconcileOnBoot()` in `src/daemon.ts`

Design §10.1 is explicit. The algorithm:

```typescript
async function reconcileOnBoot(config: Config) {
  const candidates = await client.workflow.list({
    query: `
      WorkflowType = "claudeSessionWorkflow"
      AND ExecutionStatus = "Running"
      AND (
        (ClaudeTempoAttachedHost = "${hostname}"
          AND ClaudeTempoAttachmentState IN ("attached","processing","awaiting","draining"))
        OR (ClaudeTempoAttachmentState = "detached"
          AND ClaudeTempoHostname = "${hostname}")
      )
    `,
  });

  const orphans: OrphanCandidate[] = [];
  for await (const wf of candidates) {
    const info = await getHandle(wf.workflowId).query('attachmentInfo');
    // Skip if adapter is alive (PID file match — daemon may have just
    // restarted under a live adapter).
    if (info.currentAttachment &&
        isAdapterProcessAlive(info.currentAttachment.hostname, wf.workflowId))
      continue;
    orphans.push({ workflowId: wf.workflowId, info });
  }
  return orphans;
}
```

The function returns a list of `OrphanCandidate` objects. What happens
next depends on `restorePolicy` (Site 2 below). The candidates query uses
two sub-conditions:

- **Active-host sessions** — adapter claiming this host but attachment may
  have gone stale (covers `attached`/`processing`/`awaiting`/`draining`
  without a live adapter process).
- **Detached sessions** — `ClaudeTempoAttachmentState = "detached"` where
  `ClaudeTempoHostname` (the session's registered home host) matches local.

**`isAdapterProcessAlive` implementation**: design §10.1 says "PID file
match". The exact mechanism is not specified beyond that. Ask the conductor
for the expected implementation before coding it — the PID file convention
may already exist in `src/cli/daemon.ts` (look for `daemon.pid` handling).
Use a similar convention for session adapter PIDs, or stub it as
`() => false` (always assume dead) for the initial implementation.

**`orphanSummary` query**: for each orphan candidate, also call
`handle.query('orphanSummary')` to get `{ detachedSince?, reason?,
preferredHost?, lastAdapter? }`. This metadata feeds the `"prompt"` mode
interactive display and the `"auto"` age-window check.

---

### Site 2: Config schema additions (`~/.claude-tempo/config.json`)

Design §10.2 specifies:

```jsonc
{
  "restorePolicy": "prompt",         // "auto" | "prompt" | "never"
  "autoRestoreMaxAgeHours": 24,      // only checked for "auto"
  "autoRestoreEnsembles": ["my-*"],  // glob allowlist; empty = all
  "cleanupPolicy": {                 // see Site 3
    "detachedMaxAgeDays": 7,
    "destroyedMaxAgeDays": 30
  }
}
```

In `src/config.ts`:
- Add a `DaemonConfig` interface with these fields and safe defaults
  (`restorePolicy: "prompt"`, `autoRestoreMaxAgeHours: 24`,
  `autoRestoreEnsembles: []` meaning "all")
- Add a `loadDaemonConfig()` function that reads
  `~/.claude-tempo/config.json`, validates against the schema, and returns
  typed config with defaults applied
- Zod is already a project dependency — use it for validation

**Restore policy decision tree** (§10.2):

| Policy | Behaviour on orphan |
|--------|---------------------|
| `"auto"` | Call `restart` if orphan's `detachedSince` is within `autoRestoreMaxAgeHours` AND ensemble matches `autoRestoreEnsembles` glob list. Log every restore. |
| `"prompt"` | Record orphan list; do NOT auto-restore. CLI `restore` command handles interactive confirmation. |
| `"never"` | Silently skip all orphans. No restore, no logging. |

The policy is the **effective off-switch** — there is no feature flag.
`"never"` disables all automatic restoration.

---

### Site 3: `cleanupLoop()` in `src/daemon.ts`

Design §13.4 (cleanup loop, regression row 1):

- **Detached > 7 days** — request termination (or `destroy`) of workflows
  stuck in `detached` longer than `cleanupPolicy.detachedMaxAgeDays`.
- **Destroyed > 30 days** — purge completed/`gone` workflows older than
  `cleanupPolicy.destroyedMaxAgeDays` from Temporal namespace (if the
  Temporal namespace supports retention policies, defer to those; otherwise
  use `terminateWorkflow`/`WorkflowExecutionAlreadyStartedError` guard).

The loop runs on a timer — a reasonable default is every 6 hours. The
period should be configurable (add `cleanupIntervalHours` to `DaemonConfig`
if needed, or hardcode for the initial PR). Log every action.

**Unit test requirement** (from acceptance gate): test the retention math —
given a set of orphan candidates with mock `detachedSince` timestamps,
assert the cleanup loop correctly identifies which cross the threshold and
which don't. No real Temporal connection needed; mock the `workflow.list`
client.

---

### Site 4: CLI `restore` command

Design §10.3 specifies the full surface. Add to `src/cli/commands.ts`:

```
claude-tempo restore                   # interactive picker of all orphans
claude-tempo restore <name>            # restore specific orphan by playerId
claude-tempo restore --all             # restore all, respects allowlist
claude-tempo restore --from-host=<h>   # orphans whose preferredHost is <h>
claude-tempo restore --dry-run         # list candidates, no action
```

Implementation: thin wrapper over `TempoClient.restart()` (which is
already wired in PR-D). The `restore` command:

1. Calls `reconcileOnBoot()` (or an equivalent query function — factor the
   query logic out of `reconcileOnBoot` so `restore` and the daemon boot
   path share it) to get orphan candidates.
2. In `--dry-run` mode, prints the table and exits.
3. In interactive mode (no args), presents a picker (use the existing
   `src/cli/output.ts` pattern or a simple numbered-list prompt).
4. For each confirmed/selected orphan, calls `TempoClient.restart()` with
   the workflow's `preferredHost` (read from `orphanSummary`) or the local
   host if none is set.

Note: `restorePolicy: "prompt"` is what makes the `restore` CLI command
the primary restore path. Under `"auto"` the daemon handles it; under
`"never"` the CLI is the only way to restore.

---

### Site 5: OS integration — `daemon install` / `daemon uninstall`

Design §10.5 specifies three platforms:

| Platform | Integration | Platform file |
|----------|-------------|---------------|
| Linux | `systemd --user` unit | `packaging/systemd/claude-tempo.service` |
| macOS | `launchd` agent plist | `packaging/launchd/com.claude.tempo.plist` |
| Windows | Task Scheduler | `packaging/windows/install-task.ps1` |

Add to `src/cli/commands.ts`:

```
claude-tempo daemon install          # install as OS service
claude-tempo daemon uninstall        # remove OS service
claude-tempo daemon status --service # show service registration status
```

The install command:
- Detects current platform (`process.platform`)
- Copies / symlinks the appropriate platform file to the correct location
- Enables/starts the service via the platform's CLI (`systemctl --user
  enable`, `launchctl load`, `schtasks /create`)
- Prints confirmation + path

**Scope note:** The acceptance gate marks OS-integration smoke tests as
"if the team has macOS + Linux + Windows dev boxes". This is **best-effort
for the initial PR** — the command must exist and work on at least one
platform. Gate CI on a mocked platform dispatch unit test, not a real
`systemctl` call.

---

### File list

```
src/daemon.ts          — reconcileOnBoot(), cleanupLoop(), DaemonConfig wiring
src/config.ts          — loadDaemonConfig(), DaemonConfig interface, Zod schema
src/cli/commands.ts    — restore command, daemon install/uninstall/status --service
packaging/
  systemd/
    claude-tempo.service
  launchd/
    com.claude.tempo.plist
  windows/
    install-task.ps1
test/rebuild-reboot.test.ts    — reconcile-on-boot integration test
test/cleanup-loop.test.ts      — retention math unit tests
test/restore-command.test.ts   — CLI restore command unit tests
```

**Blast radius** (from sequencing memo): ~8 files changed (3 modified,
5 new). Migration PR: No.

---

### Expected LOC

~600 LOC across daemon + config + CLI. OS integration adds ~100 lines of
platform-specific shell/PS1. Tests add ~300 lines. Total delta: ~1000 LOC
added, ~50 removed.

---

## 4. Gotchas

### P1. `isAdapterProcessAlive` — PID file convention

The exact PID-tracking convention for session adapter processes is not
established. Before implementing, check `src/cli/daemon.ts` for the
`daemon.pid` file pattern, then check `src/spawn.ts` for whether spawned
sessions leave a PID file. If no PID file convention exists, stub as
`() => false` (always assume dead) for the initial PR — overly aggressive
restore is safe because `claimAttachment` is atomic and the daemon backs
off on `AttachmentConflict` (§10.6).

### P2. `AttachmentConflict` on concurrent restore

Design §10.6: "the daemon checks `attachmentInfo` before claiming and backs
off silently on `AttachmentConflict`." This means `claimAttachment` may
fail if a user manually restores the same session the daemon is auto-
restoring. The daemon must catch the conflict error and log + skip rather
than propagate. Wrap the `TempoClient.restart()` call in a try/catch that
handles `AttachmentConflict` gracefully.

### P3. `restorePolicy` has no feature flag

Unlike the V2 lifecycle flag, restore policy is config-driven. There is no
`CLAUDE_TEMPO_RESTORE_POLICY` env var override (not specified in design).
If you need a test escape hatch, use `"never"` policy in test fixtures —
don't add a new env var without confirming with the conductor.

### P4. `cleanupLoop` must not destroy live workflows

The cleanup query should filter on `ExecutionStatus = "Completed"` (for
destroyed/`gone` workflows) or `ClaudeTempoAttachmentState = "detached"`
(for orphaned-but-running). Never query for `"Running"` workflows and
destroy them based on age alone — use only `detachedSince` from
`orphanSummary`.

### P5. Config file creation race

`~/.claude-tempo/config.json` may not exist on first run. `loadDaemonConfig`
must handle missing file gracefully (return all defaults). It must also
handle partial config (user sets only `restorePolicy` — remaining fields
default). Zod `.partial()` + `.default()` handles this well.

### P6. OS integration — do NOT require elevated privileges

`daemon install` must install a **user-level** service only (systemd
`--user`, launchd user agent, Task Scheduler current-user task). Do not
`sudo`. If the user's environment requires system-level install, that's
out of scope and should print a guidance message.

### P7. `cleanupPolicy` defaults

The sequencing memo mentions `cleanupPolicy` in the config schema but
design §10 only specifies `detachedMaxAgeDays: 7` and
`destroyedMaxAgeDays: 30`. Use those as the hardcoded defaults. If the
conductor wants the intervals configurable, ask before adding config fields.

### P8. Inherited from PR-D: workflow bundle rebuild required

`npm run build` pre-bundles `src/workflows/`. If you touch anything in
`src/workflows/`, rebuild. PR-E probably won't touch workflow code
directly — but if you add a config query via a new workflow query, build
first.

### P9. Inherited from PR-D: wire-protocol doc = same-commit update

PR-E does not add new signals/queries/updates (all wire primitives landed
in PR-A). No WIRE-PROTOCOL.md update required **unless** you discover a
new query or update you need. If so, update `docs/WIRE-PROTOCOL.md` in the
same commit.

### P10. Windows path for config file

`~/.claude-tempo/` translates to `%USERPROFILE%\.claude-tempo\` on
Windows. Use `os.homedir()` from Node's `path` module, not a hardcoded
`~`. Check `src/cli/daemon.ts` — it already uses `os.homedir()` for the
`daemon.pid` path. Follow the same pattern.

---

## 5. Test harness pointers

### Key files for PR-E

- **`test/rebuild-reboot.test.ts`** — acceptance-gate test. Start workflow,
  kill daemon + adapter, restart daemon, assert `reconcileOnBoot` finds
  the orphan, assert `restorePolicy: "auto"` calls `TempoClient.restart`.
  This is the main integration test. Wire it against a mocked
  `TempoClient.restart` (capture the call) rather than a real Temporal
  connection.
- **`test/cleanup-loop.test.ts`** — unit test for retention math. No
  Temporal connection. Mock `workflow.list` returning fixtures with varying
  `detachedSince` timestamps; assert correct candidates cross the
  threshold.
- **`test/restore-command.test.ts`** — CLI unit test. Mock
  `reconcileOnBoot` to return a fixed orphan list; assert correct
  `TempoClient.restart` calls and `--dry-run` output.

### Inherited pointers

- **`test/activities.test.ts`** — outbox activity mocks. `mockHandle`
  at ~line 44 tracks `signals` and `updates` arrays.
- **`test/session-phase-machine.test.ts`** — phase invariants. Don't add
  new daemon-related phase tests here; keep to daemon-specific files.
- **`npm test`** — always run the full suite; `pretest` rebuilds the
  workflow bundle.

### Running subsets

```bash
# Full suite:
npm test

# Focused mocha (grep by title):
npx mocha --grep 'reconcileOnBoot' dist-test/test/**/*.test.js

# Cleanup-loop math only:
npx mocha --grep 'cleanupLoop' dist-test/test/**/*.test.js
```

---

## 6. Don't touch

### Wire-protocol names are frozen as of v0.25.0-beta.1

PR-E does not add new wire primitives. If you think you need one, cue the
conductor. All names in `docs/WIRE-PROTOCOL.md` are stable — renaming
requires a major version bump.

### v0.25.1 shim cleanup (#132) is deferred

The quarantined `updateMetadata({status:'terminated'})` handler in
`src/workflows/session.ts` and the ~30 test fixtures using it are
scheduled for v0.25.1. Do NOT touch them in PR-E.

### `stop` MCP tool is intentionally a hint shim

`src/tools/stop.ts` currently returns a deprecation message pointing to
`detach`/`destroy`/`restart`. Do not restore real behavior. Deletion is
scheduled for PR-H (v0.25.1 cleanup) alongside the shim and flag removal.

### `encore` references in comments

PR-D comment-cleanup (`9f3eb24`) removed stale `encore` references. If you
encounter one the script missed, update it to `restart` in passing — but
don't chase them; leave any you're not already touching.

### `hardTerminate` CLI flag

`src/cli/commands.ts` `--hard-terminate` routes through the legacy shim.
Out of scope for PR-E. Removal is PR-H.

---

## 7. Open questions for the conductor

Before coding, surface these:

1. **`isAdapterProcessAlive` spec** — PID file convention for session
   adapter processes. Does one exist already? If not, should the initial
   PR stub it as `() => false` (always restore) or implement a real check?
2. **`cleanupPolicy` configurable fields** — is `cleanupIntervalHours`
   needed, or hardcode the 6-hour loop period?
3. **`reconcileOnBoot` factor** — should the orphan-query logic be a
   shared function used by both the boot path and the CLI `restore`
   command, or is code duplication acceptable for the initial PR?
4. **`daemon install` minimum platform** — if the dev environment is
   Windows-only, should the Linux/macOS platform files ship as untested
   best-effort, or defer the non-Windows files to a follow-up?
5. **`autoRestoreEnsembles` glob library** — should the glob matching use
   `micromatch` (already in many Node projects) or a simpler manual prefix
   match? No glob library is currently in `package.json`.
6. **PR-F dependency** — PR-F (cross-host capstone) depends on PR-E's
   `reconcileOnBoot`. Confirm whether PR-F needs to wait for PR-E to merge
   to `main` or whether it can be developed in parallel on a stacked branch.

---

## Quick-reference links

- Design doc (full spec): [`docs/design/session-lifecycle-rebuild-v2.md`](../design/session-lifecycle-rebuild-v2.md) §10, §13.4
- Sequencing memo: [`docs/design/session-lifecycle-rebuild-v2-sequencing.md`](../design/session-lifecycle-rebuild-v2-sequencing.md) §2 PR-E row
- Wire protocol: [`docs/WIRE-PROTOCOL.md`](../WIRE-PROTOCOL.md)
- CHANGELOG: [`CHANGELOG.md`](../../CHANGELOG.md) `[0.25.0-beta.1]`
- PR-D: #136 (squash-merged — all verb tools + encore retirement + SpawnOutboxEntry wiring)
- Tracked issues: #132 (v0.25.1 shim cleanup, deferred) · #129 (CLAUDE.md lazy-load, post-PR-F) · #130 (subagent guidance, post-PR-F)
- Architecture reference: [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md) — three-layer session model + ensemble coordination

Good luck. PR-D left the verb surface clean; PR-E is the first PR with
meaningful infrastructure work outside the workflow/adapter core.
