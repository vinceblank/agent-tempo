# PR-F engineer brief — v0.25 session lifecycle rebuild

> Handoff from the PR-E engineer. Written after the squash-merge of PR-E
> on `main`. Target reader: a competent TypeScript engineer with no prior
> `claude-tempo` exposure beyond [`CLAUDE.md`](../../CLAUDE.md).

## 1. What's on main

**PR-A/B/C/D/E foundations are live at `origin/main`:**

- **All seven V2 wire primitives** shipped in PR-A — `claimAttachment`,
  `forceDetach`, `processingStart`, `processingEnd`, `enqueueSpawn`,
  `setPreferredHost`, `destroy` updates; `heartbeat`, `requestDetach`,
  `adapterExited` signals; `attachmentInfo`, `orphanSummary`,
  `inFlightMessages`, `isDestroyed` queries. See
  [`docs/WIRE-PROTOCOL.md`](../WIRE-PROTOCOL.md).
- **Adapter registry** — `AdapterRegistry` + `BaseAttachment` with full
  V2 lifecycle (claim, heartbeat loop, `adapterExited` teardown,
  `WorkflowGone` classifier). Shipped: `InteractiveAttachment` (Claude
  Code CLI, 60 s heartbeat), `CopilotSdkAttachment` (Copilot bridge,
  30 s heartbeat).
- **7-phase state machine** — `booting`, `attached`, `processing`,
  `awaiting`, `draining`, `detached`, `gone`. Exposed as
  `ClaudeTempoAttachmentState` search attribute and via `attachmentInfo`
  query.
- **PR-D verb surface** — `restart`, `detach`, `destroy`, `migrate`,
  `attachment-info` MCP tools. `encore` deleted. `stop` is a hint shim.
  SpawnOutboxEntry 5 attachment fields fully wired.
- **PR-E daemon surface** — `reconcileOnBoot()`, `cleanupLoop()`, and
  `queryOrphanedSessions()` (shared, lives in `src/reconcile/orphans.ts`).
  CLI `restore` command (interactive, `--all`, `--from-host=<h>`,
  `--dry-run`). OS service integration: `daemon install` / `daemon
  uninstall` for Linux systemd, macOS launchd, Windows Task Scheduler.
  `DaemonConfig` schema in `src/config.ts` (`restorePolicy`, `autoRestoreMaxAgeHours`,
  `autoRestoreEnsembles`, `cleanupPolicy`). `PackagingPlatform`
  descriptors under `packaging/`.
- **TempoClient** (`src/client/`) — `restart`, `detach`, `destroy`,
  `migrate`, `attachmentInfo` methods all wired post-PR-D.
- **Feature flag** — `CLAUDE_TEMPO_LIFECYCLE_V2` default **ON**.
  Rollback via `CLAUDE_TEMPO_LIFECYCLE_V2=0`.
- **Quarantined legacy shim** at `src/workflows/session.ts` ~line 364
  (`TODO(v0.25.1): remove this shim branch — tracked in #132`). Do not
  touch.

---

## 2. Remaining ladder scope

### PR-F — multi-host coordination capstone (NEXT — this brief)

Full spec in §3 below. Short summary: cross-host `restart` routing,
`--yes-steal=<hostname>` safety flag, `setPreferredHost` wiring through
daemon and CLI, TUI cross-host indicator surface, multi-host integration
test harness via docker-compose.

**This is the capstone.** All prior PRs fed into this one. Depends on
PR-D **and** PR-E both merged.

### PR-G — test suite + wire-protocol CI check

Tests, conformance suite, wire-protocol CI diff checker. Partially
landed (stubs from PR-G earlier). Can land before or after PR-F. No
action from you unless conductor assigns it.

---

## 3. PR-F specifics

### Overview

PR-F makes `restart` route to the right machine. Before PR-F, `restart`
always uses the local host's task queue — a session on host B can only
be restarted from host B. After PR-F:

1. `restart` accepts an optional `host` parameter; the spawn activity is
   dispatched to `claude-tempo-{host}` task queue instead of local.
2. A `--yes-steal=<hostname>` flag is required when the force-restart
   targets a session currently attached to a different host — prevents
   accidental remote stealing.
3. `session.ts` wires the `setPreferredHost` update handler (trivial —
   already a V2 wire primitive from PR-A; just needs a handler).
4. `daemon.ts` `reconcileOnBoot` filters cross-host: sessions with
   `preferredHost` pointing to a different host are skipped locally and
   handed off rather than auto-restored.
5. TUI exposes `ClaudeTempoAttachedHost` in the player view surface so
   operators can see which machine each session is running on.
6. An integration test harness (docker-compose, two daemon containers,
   shared Temporal dev server) validates cross-host paths end-to-end.

Design reference: `docs/design/session-lifecycle-rebuild-v2.md` §16
(especially §16.5 for the `--yes-steal` decision) and §8.2 (restart
algorithm). Sequencing spec:
`docs/design/session-lifecycle-rebuild-v2-sequencing.md` §2 PR-F row.

---

### Site 1: `src/tools/restart.ts` — `host` param routing

The existing `restart` tool routes through `enqueueSpawn` on the
session's outbox, which dispatches `spawnProcess` on the **local** task
queue. PR-F adds a `host` parameter that changes the dispatch target.

The `restart` verb algorithm (§8.2):
1. Graceful `requestDetach` (or `forceDetach` if `force: true`)
2. Fresh `claimAttachment` on the target host (using the target's
   adapter ID or a new one)
3. Optional context replay via `receiveMessage`
4. `enqueueSpawn` on the session's **own** outbox

The key change is in step 4: `enqueueSpawn` carries a `taskQueue`
field. When `host` is supplied, set `taskQueue` to
`claude-tempo-{host}` instead of the local `claude-tempo-{localHostname}`
default. The activity `spawnProcess` is already registered on per-host
task queues (that was established in the cross-machine design from before
v0.25).

```typescript
// In the SpawnOutboxEntry created by restart:
const taskQueue = host
  ? `claude-tempo-${host}`
  : `claude-tempo-${localHostname}`;
```

The `host` param flows: MCP tool input → `RestartOutboxEntry` → workflow
dispatcher → `SpawnOutboxEntry.taskQueue`.

**`--yes-steal` enforcement (§16.5 Option B):**

When `force: true` AND a different host currently holds the attachment
(read from `attachmentInfo` query → `currentAttachment.hostname ≠
localHostname`), require `confirmStealFromHost` to match that hostname.
If the caller supplies `force: true` without `confirmStealFromHost`, or
with a non-matching value, return an error:

```
Error: session "alice" is attached to host "build-server". To force-
restart from there, pass confirmStealFromHost: "build-server".
```

This check lives in the `restart` tool handler **before** the outbox
enqueue — it is a client-side guard, not enforced by the workflow.

---

### Site 2: `src/workflows/session.ts` — `setPreferredHost` handler

`setPreferredHost` is already a V2 wire update (PR-A). All PR-F needs is
a handler in `session.ts`:

```typescript
wf.setHandler(setPreferredHostUpdate, (newHost: string) => {
  state.preferredHost = newHost;
  // Also sync to search attribute so daemon reconcileOnBoot can filter
  await wf.upsertSearchAttributes({
    ClaudeTempoPreferredHost: [newHost],   // if this SA exists
    // or store in-memory only and expose via query
  });
});
```

Check whether `ClaudeTempoPreferredHost` is a registered search attribute
(look in `src/cli/commands.ts` `server` command's `--search-attribute`
list and in the CI `.github/workflows/ci.yml` attribute registration).
If it is not registered, store `preferredHost` in-memory only (already
on the session state object from PR-A) and expose it via the existing
`orphanSummary` query — no new search attribute needed.

**Ask the conductor** (§7.Q1) before adding a new search attribute.

---

### Site 3: `src/daemon.ts` — `reconcileOnBoot` cross-host filter

PR-E implemented `reconcileOnBoot` to scan for orphaned sessions on the
local host. PR-F extends it with preferred-host awareness:

```typescript
// After collecting orphan candidates:
for (const orphan of orphans) {
  const summary = await getHandle(orphan.workflowId).query('orphanSummary');
  if (summary.preferredHost && summary.preferredHost !== localHostname) {
    // Session prefers a different host — skip local restore.
    // Log and (optionally) signal the remote host to pick it up.
    log.info('skipping restore: preferredHost is %s (we are %s)',
      summary.preferredHost, localHostname);
    continue;
  }
  // Normal restore path from PR-E...
}
```

The "signal the remote host" path is **out of scope for PR-F initial
implementation** — just log and skip. Cross-host broadcast of orphan
notifications is a v0.26+ consideration. Confirm with conductor (§7.Q2).

---

### Site 4: `src/cli/commands.ts` — `migrate` command wiring

The `migrate` MCP tool shipped in PR-D (`src/tools/migrate.ts`). PR-F
wires the CLI command counterpart with the cross-host confirmation UX:

```
claude-tempo migrate <player> --to <hostname>
claude-tempo migrate <player> --to <hostname> --yes-steal=<current-host>
```

Implementation:
1. Look up the session via `TempoClient.getPlayers()` or
   `attachmentInfo` query to find `currentAttachment.hostname`.
2. If `currentAttachment.hostname ≠ localHostname`, require
   `--yes-steal=<current-host>` flag. Reject with descriptive error if
   absent or mismatched.
3. Call `TempoClient.migrate(playerName, { to: targetHostname,
   confirmStealFromHost: yesSteal })`.
4. Print confirmation: `"alice" is moving to build-server…` and wait for
   the spawn activity to dispatch (poll `attachmentInfo` for
   `ClaudeTempoAttachedHost = targetHostname` or just fire-and-forget
   with a note to `claude-tempo status` to verify).

---

### Site 5: TUI cross-host indicator

`ClaudeTempoAttachedHost` is an existing search attribute. PR-F surfaces
it in two TUI components so operators can see which machine a session is
running on:

**`src/tui/components/ChatView.tsx`** — add a subtitle line under the
player name (or inline with the `@machine` prefix) showing the attached
host. Something like:

```
alice  (tempo-soloist)
  Working on the REST endpoints
  📍 build-server  /repos/app  feat/api
```

**`src/tui/components/PlayerDetailView.tsx`** — add a `Host` field in
the player metadata section next to `Ensemble` and `Status`. Show
the value of `ClaudeTempoAttachedHost` from the player's search
attributes. If the value matches `localHostname`, display `local`; if
different, display the hostname in a distinct color (amber/yellow via
`THEME`).

The data is already available through the TempoClient's player list
(which reads search attributes). No new Temporal queries needed.

**Ask the conductor** (§7.Q3) about the exact display format before
styling — the theme must stay consistent with `src/tui/utils/theme.ts`.

---

### Site 6: Integration test harness (`test/fixtures/multi-host/`)

The sequencing memo acceptance gate requires:
- `test/multi-host-cross-host-restart.test.ts` — 2-daemon scenario

The harness uses docker-compose to spin up two daemon containers against
a shared Temporal dev server:

```
test/fixtures/multi-host/
  docker-compose.yml      # two daemon services + temporal dev server
  daemon-a/
    Dockerfile            # builds claude-tempo daemon with HOSTNAME=host-a
  daemon-b/
    Dockerfile            # same, HOSTNAME=host-b
  README.md               # how to run the harness locally
```

The test:
1. Starts the harness (`docker-compose up -d`)
2. Connects a TempoClient to the shared Temporal address
3. Spawns a session on `host-a` via `recruit({ host: 'host-a' })`
4. Verifies session appears in ensemble with `ClaudeTempoAttachedHost = "host-a"`
5. Calls `restart({ host: 'host-b', confirmStealFromHost: 'host-a' })`
6. Polls until `ClaudeTempoAttachedHost = "host-b"`
7. Verifies message continuity (history length preserved)

Also test rejection paths:
- `restart` with `host: 'host-b'` but no `confirmStealFromHost` → error
- `restart` with `confirmStealFromHost: 'wrong-host'` → error

**Ask the conductor** (§7.Q4) whether the docker-compose harness should
use the published `claude-tempo` image or build from the local source.

---

### File list

```
src/tools/restart.ts              — host param routing + --yes-steal enforcement
src/workflows/session.ts          — setPreferredHost update handler
src/daemon.ts                     — reconcileOnBoot cross-host filter
src/cli/commands.ts               — migrate CLI command with --yes-steal UX
src/tui/components/ChatView.tsx   — attached-host indicator in player view
src/tui/components/PlayerDetailView.tsx  — host field in player metadata
test/multi-host-cross-host-restart.test.ts   (new)
test/fixtures/multi-host/
  docker-compose.yml              (new)
  daemon-a/Dockerfile             (new)
  daemon-b/Dockerfile             (new)
  README.md                       (new)
```

**Blast radius** (from sequencing memo): ~6 files modified + ~5 new
files (test harness subtree). Migration PR: No.

---

### Expected LOC

~200 LOC across `restart.ts`, `session.ts`, `daemon.ts`, `cli/commands.ts`.
TUI adds ~80 lines across `ChatView.tsx` and `PlayerDetailView.tsx`.
Test harness: ~220 lines (test file) + docker-compose + Dockerfiles.
Total delta: ~500 LOC added, ~20 removed.

---

## 4. Gotchas

### P1. `--yes-steal` check is client-side, not workflow-enforced

The `confirmStealFromHost` guard is implemented in the MCP tool and CLI
handler — not in the Temporal workflow. The workflow trusts the caller.
This means a direct Temporal API caller (or a malformed client) can
bypass it. This is intentional per §16.5 design: the workflow can't
know the caller's intent; the UX guard is sufficient for the interactive
surface.

### P2. Per-host task queue must be running on the target host

`enqueueSpawn` routing to `claude-tempo-{host}` task queue will stall
indefinitely if no daemon is running on that host (Temporal queues tasks
until a worker picks them up). The `restart --host` command should warn
the user:

```
Warning: verify that a claude-tempo daemon is running on "build-server"
before proceeding (tasks will queue until it starts).
```

Do not block or poll — just emit the warning.

### P3. `setPreferredHost` update handler — check if search attribute exists

If `ClaudeTempoPreferredHost` is NOT a registered search attribute (check
the `server` command and `ci.yml`), do NOT add it in PR-F without
conductor approval. Store `preferredHost` in-memory only (it's already on
`SessionState` from PR-A). Surfacing it requires registering the SA in
every dev/CI/prod Temporal namespace, which is a coordination change.

### P4. Workflow bundle rebuild required

`src/workflows/session.ts` is workflow code. Any change here requires
`npm run build` to regenerate `workflow-bundle.js`. Run `npm run build`
before committing session.ts changes.

### P5. TUI Yoga node budget

The TUI has a hard budget of ~20 Yoga nodes to avoid input lag (see
CLAUDE.md TUI Performance section). Adding host display to ChatView and
PlayerDetailView must not add new `<Box>` nodes — use nested `<Text>`
with `\n` formatting or inject into existing layout strings. Pre-format
the host label as a string and append it to existing text content.

### P6. `AttachmentConflict` on cross-host claim race

If two daemons race to claim the same orphan from different hosts (e.g.,
both boot at the same time), `claimAttachment` serializes via Temporal
update ordering. The loser gets `AttachmentConflict`. Both daemons must
handle this gracefully — log and skip, same as PR-E's P2 gotcha.

### P7. docker-compose harness — use host networking or explicit ports

Temporal dev server runs on port 7233 by default. Two daemon containers
need to reach it. Use `network_mode: "host"` on Linux or explicit port
mapping on macOS/Windows. The harness `README.md` should document both
modes.

### P8. Inherited from PR-E: wire-protocol names are frozen

PR-F does not add new wire primitives. If you discover you need one (e.g.
a new query to expose `preferredHost`), cue the conductor before touching
`docs/WIRE-PROTOCOL.md` and `src/workflows/signals.ts`.

### P9. `migrate` CLI vs MCP — different UX, same underlying call

The `migrate` MCP tool (PR-D) does not have interactive confirmation —
MCP tools are programmatic. The CLI `migrate` command (PR-F) adds the
interactive UX (`--yes-steal` required for cross-host, confirmation
prompt). Both ultimately call the same TempoClient method. Keep the two
surfaces in sync — if you change the underlying API, update both.

### P10. Search attribute `ClaudeTempoAttachedHost` is already registered

`ClaudeTempoAttachedHost` is in the existing search attribute list (check
`src/cli/commands.ts` `server` command). The TUI can read it from the
player's search attributes without any new registration. Verify this
before assuming it's missing.

---

## 5. Test harness pointers

### Key files for PR-F

- **`test/multi-host-cross-host-restart.test.ts`** — acceptance-gate
  integration test. Requires the docker-compose harness running. Should
  be tagged (or use a `.skip.ts` pattern) for CI so it doesn't run in
  the standard unit test suite. The full multi-host test is a manual or
  separate CI job only.
- **`test/restart-host-routing.test.ts`** (unit, no docker-compose) —
  test the `host` param routing logic in `restart.ts` with a mocked
  TempoClient: assert that `SpawnOutboxEntry.taskQueue` is set correctly
  when `host` is provided, and that the `--yes-steal` check fires when
  expected.
- **`test/yes-steal-guard.test.ts`** (unit) — test the `--yes-steal`
  enforcement: mock `attachmentInfo` returning a specific hostname; assert
  the error message and rejection path when `confirmStealFromHost` is
  absent or mismatched.

### Inherited pointers

- **`test/activities.test.ts`** — `mockHandle` at ~line 44 tracks
  `signals` and `updates` arrays.
- **`test/session-phase-machine.test.ts`** — phase invariants; don't add
  cross-host tests here.
- **`npm test`** — full suite; `pretest` rebuilds the workflow bundle.

### Running subsets

```bash
# Full suite (unit only — docker-compose tests skipped):
npm test

# Host-routing unit tests:
npx mocha --grep 'restart host routing' dist-test/test/**/*.test.js

# yes-steal guard unit tests:
npx mocha --grep 'yes-steal' dist-test/test/**/*.test.js

# Full multi-host integration (requires docker-compose up):
docker-compose -f test/fixtures/multi-host/docker-compose.yml up -d
npx mocha dist-test/test/multi-host-cross-host-restart.test.js
docker-compose -f test/fixtures/multi-host/docker-compose.yml down
```

---

## 6. Don't touch

### Wire-protocol names are frozen as of v0.25.0-beta.1

PR-F does not add new wire primitives. All names in
`docs/WIRE-PROTOCOL.md` are stable — renaming requires a major version
bump. If you think you need a new signal or query for cross-host, cue
the conductor before writing code.

### v0.25.1 shim cleanup (#132) is deferred

The quarantined `updateMetadata({status:'terminated'})` handler in
`src/workflows/session.ts` and the `hardTerminate` CLI flag are
scheduled for v0.25.1 (PR-H). Do not touch them in PR-F.

### `stop` MCP tool is intentionally a hint shim

`src/tools/stop.ts` returns a deprecation message. Do not restore real
behavior. Deletion is PR-H.

### `reconcileOnBoot` cross-host signal path is out of scope

Proactive notification from daemon A to daemon B that a session is
available for restore is a v0.26 feature. PR-F's scope is local
filtering (skip sessions preferred to other hosts). Do not implement
cross-daemon messaging in this PR.

### OS service files in `packaging/` are PR-E scope

PR-E owns the `packaging/` subtree. Do not modify `packaging/` in PR-F
unless there is a clear multi-host service file need. File a follow-up
issue instead.

---

## 7. Open questions for the conductor

Before coding, surface these:

1. **`setPreferredHost` search attribute** — is `ClaudeTempoPreferredHost`
   a registered search attribute, or should `preferredHost` remain
   in-memory only? If in-memory only, is it surfaced sufficiently via the
   existing `orphanSummary` query, or does PR-F need a new query?

2. **`reconcileOnBoot` cross-host skip** — when a session has
   `preferredHost = "build-server"` and we are `host-a`, we skip the
   local restore. Should we also attempt to notify `build-server` (e.g.
   by placing a signal on a well-known coordination workflow)? Or is
   log-and-skip the complete PR-F behavior?

3. **TUI display format for host indicator** — which of these formats is
   preferred for ChatView?
   - Append `@build-server` suffix to player name
   - New line under player name (`📍 build-server`)
   - Part of the status line alongside git branch

4. **docker-compose harness build source** — should the two daemon
   containers build from local source (`COPY . /app && npm run build`) or
   pull a published image (`FROM claude-tempo:latest`)? Local build is
   correct for CI; published image is simpler for manual runs.

5. **`migrate` CLI prompt style** — when `--yes-steal` is required and
   not supplied, should the CLI prompt interactively (`Confirm steal from
   "build-server"? [y/N]`) or reject with an error (`missing flag:
   --yes-steal=build-server`)? The MCP tool already rejects; the question
   is whether the CLI is more forgiving.

---

## 8. Conductor answers to §7 open questions

All five questions from §7 are resolved. Do not ask again — these are
locked decisions.

**1. `setPreferredHost` — keep in-memory only. Do NOT register a new search attribute.**

No `ClaudeTempoPreferredHost` SA. SA registration is a coordination
change (every dev namespace, CI matrix, `server` command, README setup
snippet). The daemon already queries orphans one-by-one via `orphanSummary`
(PR-E pattern), so filtering by `preferredHost` is cheap. Add
`preferredHost?: string` to the `orphanSummary` query return shape if not
already present — query shape additions are backward compatible (not a
wire-protocol break).

`setPreferredHost` handler: update `state.preferredHost` in-memory only.
No `upsertSearchAttributes` call.

**2. `reconcileOnBoot` cross-host skip — log-and-skip only.**

Proactive cross-daemon notification is a v0.26 feature per design §16.
PR-F's remit is local filtering, not cross-host coordination. After
landing PR-F, file a v0.26 tracking issue titled "cross-host orphan
handoff signal" with a pointer back to this brief §3 Site 3. Log line
must include both hostnames for observability:

```
skipping restore for {workflowId}: preferredHost={X}, localHost={Y}
```

**3. TUI display format — Option 3: inline with the status line (alongside repo/branch).**

Zero new Yoga nodes. Pre-format as a string in one `<Text>` node.

- **Local session** — omit host entirely (reduces noise).
- **Remote session** — prepend `{hostname} · ` to the existing
  `{repo} · {branch}` line, styled with `THEME.accent` (amber).

```
build-server · /repos/app · feat/api   ← remote
/repos/app · feat/api                   ← local (no host prefix)
```

Applies to both `ChatView.tsx` and `PlayerDetailView.tsx`. In
`PlayerDetailView`, if a labeled metadata section already exists, add a
`Host: <hostname>` line with the same conditional (omit if local) — still
zero new Yoga nodes if injected into an existing pre-formatted text block.

Option 1 (`@build-server` suffix on player name) rejected: clutters the
primary name label. Option 2 (`📍` new line) rejected: adds a line and
potentially a Yoga node; violates P5 gotcha.

**4. docker-compose harness — build from local source.**

```dockerfile
COPY . /app
RUN npm ci && npm run build
```

Rationale: the integration test validates this PR's code. Pulling a
published image would test v0.24. Local build is the only correct choice
for CI and for manual branch validation. BuildKit cache mounts
(`RUN --mount=type=cache,target=/root/.npm npm ci`) are optional polish —
skip if they add complexity.

The harness `README.md` should document both CI-integrated and manual run
modes, but both use `COPY . /app` — no published-image path.

**5. `migrate` CLI — hard error, no interactive prompt.**

`--yes-steal` is a deliberate-consent guard (§16.5 Option B). Interactive
prompts let users mash `y` without thinking and break scripting/CI.

Error format (copy-paste friendly — includes the exact re-run command):

```
Error: session "alice" is attached to host "build-server".
To confirm moving it, re-run with --yes-steal:

  claude-tempo migrate alice --to host-a --yes-steal=build-server

This safety flag prevents accidental cross-host session takeover.
```

Same format when `--yes-steal` is provided but mismatched: show the
correct hostname in the re-run command. Matches MCP tool behavior (PR-D).
No interactive prompts anywhere in the migrate surface.

---

## Quick-reference links

- Design doc (full spec): [`docs/design/session-lifecycle-rebuild-v2.md`](../design/session-lifecycle-rebuild-v2.md) §8.2, §16 (especially §16.5)
- Sequencing memo: [`docs/design/session-lifecycle-rebuild-v2-sequencing.md`](../design/session-lifecycle-rebuild-v2-sequencing.md) §2 PR-F row, §3 LOC estimates
- Wire protocol: [`docs/WIRE-PROTOCOL.md`](../WIRE-PROTOCOL.md)
- CHANGELOG: [`CHANGELOG.md`](../../CHANGELOG.md) `[0.25.0-beta.1]`
- PR-D: #136 (encore retirement, verb surface, SpawnOutboxEntry wiring)
- PR-E: merged (daemon reconcile-on-boot, restore CLI, OS integration)
- Architecture reference: [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md) — three-layer session model + ensemble coordination
- Tracked issues: #132 (v0.25.1 shim cleanup, deferred) · #129 (CLAUDE.md lazy-load, post-PR-F) · #130 (subagent guidance, post-PR-F)

This is the final feature PR. PR-H (shim + flag cleanup) is post-GA
housekeeping. Ship this and the v0.25 lifecycle rebuild is done.
