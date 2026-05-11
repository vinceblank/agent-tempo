# Key Concepts — Full Glossary

> **Quick reference**: Core terms (Player, Conductor, Ensemble, Cue, Part, Outbox, Wire protocol,
> Daemon, Player types) are defined inline in `CLAUDE.md`. This file has the full definitions for
> all concepts, with mechanics detail.

---

## Session identity

**set_name** — Players start with a random hex ID assigned at workflow creation. `set_name`
updates the `ClaudeTempoPlayerId` search attribute to a human-readable name. The name is how
other players address you via `cue`.

**Attachment phase** (v0.26) — Each session workflow tracks a lifecycle phase via the
`ClaudeTempoAttachmentState` search attribute. The phase is driven by the adapter lifecycle
(see `src/adapters/`), not by a polling heuristic:

- `booting` — Workflow exists, no adapter has claimed it yet (the state after `recruit`
  creates the workflow but before the spawned process calls `claimAttachment`)
- `attached` — An adapter holds a valid attachment and is idle-ready
- `processing` — Attached AND at least one inbound message is in-flight in the adapter
  (set via `processingStart` update; cleared via `processingEnd`)
- `awaiting` — Attached, idle, outbox empty (presentation refinement of `attached`)
- `draining` — Attachment requested detach; flushing outbox and awaiting `adapterExited`
- `detached` — Workflow RUNNING, no attachment; outbox dispatch paused (`stop`/`destroy` bypass)
- `gone` — Terminal; workflow COMPLETES after `destroy`

Phase transitions are deterministic and recorded as workflow history events. External
observers (the TUI, the CLI `ensemble` tool, the Maestro dashboard, the daemon
`reconcileOnBoot` path) read the current phase from `ClaudeTempoAttachmentState` or the
`attachmentInfo` query — both are authoritative.

> **Historical note** — Before v0.26, sessions carried a `ClaudeTempoStatus` search attribute
> with values `pending | active | stale | blocked | terminated`, driven by a 3-min stale and
> 5-min blocked heuristic. That shim was removed in v0.26 (#174–#178 epic). See
> [`docs/ops/v0.26-migration.md`](ops/v0.26-migration.md) for the upgrade path.

---

## Session lifecycle verbs

**Recruit** — Spawning a new Claude Code session as a player. The workflow is pre-created with
the initial message before the process spawns, ensuring reliable message delivery even if the
process starts slowly.

**Restart** — Revives a session by running the §8.2 algorithm: graceful `requestDetach` (or
`forceDetach` with `force: true`), fresh `claimAttachment` on the target host, optional context
replay via `receiveMessage`, then `enqueueSpawn` on the target's own outbox. Works on any
non-`gone` attachment phase (attached, awaiting, processing, draining, detached).

**Detach** / **Destroy** — The two ways to end a session's current run:
- `detach` gracefully reaps the adapter; the workflow survives in `detached` phase and can be
  `restart`ed later with full history intact. Note: `detached` can be transient — adapters that
  opt into reconnect (`shouldReconnect()`) will attempt to re-claim the session internally before
  surfacing a permanent detach. If the 15-minute reconnect budget expires without success, the
  adapter emits `DetachReason: 'reconnect-exhausted'` and shuts down.
- `destroy` terminally ends the workflow (phase → `gone`), abandoning any in-flight outbox
  entries. Irreversible.

**Migrate** — Sugar for `restart --host=<h>`. Identical semantics to restart; separate verb for
UX clarity when moving sessions across physical hosts.

---

## Adapter and attachment phases

**Adapter** — The runtime binding between a player's Temporal workflow and its agent process.
Three shipped adapters:
- `InteractiveAttachment` (`src/adapters/claude-code/`) — Claude Code CLI adapter. Push-based
  MCP notification delivery, 60s heartbeat lease.
- `CopilotSdkAttachment` (`src/adapters/copilot/`) — Copilot bridge adapter. Blocking
  `sendAndWait` delivery, 30s heartbeat lease.
- `DirectApiAttachment` (`src/adapters/claude-api/`) — headless Anthropic Messages API adapter
  (#131 Phase C). No TTY, no Claude Code CLI; runs in any cloud / CI / scheduled-work
  environment. Tool surface limited to claude-tempo MCP tools (cue, report, recall, …) — file-edit
  / shell / web tools deferred to Phase 2. Requires `ANTHROPIC_API_KEY` + the
  `@anthropic-ai/sdk` optional dependency. Recruit via `recruit({ agent: 'claude-api', model? })`.

Adapters are registered with the `AdapterRegistry` (`src/adapters/index.ts`) and resolved at
spawn time via `SessionMetadata.adapterId`. The base class (`src/adapters/base.ts`) owns the
full V2 attachment lifecycle: `claimAttachment` + runId pinning, heartbeat loop, `attachmentInfo`
phase watcher, `WorkflowGone` classifier, graceful `adapterExited` on teardown.

**Attachment phases** — The session workflow tracks the adapter's state via a 7-phase machine:

```
booting → attached → processing
                   ↘ awaiting
          draining → detached
any non-terminal → gone  (via destroy)
```

Phase is exposed as the `ClaudeTempoAttachmentState` search attribute and via the `attachmentInfo`
query. `awaiting` is the idle refinement of `attached` (lease held, no in-flight work).
Transitions are driven by V2 wire primitives: `claimAttachment` update (claim/renew), `heartbeat`
signal (extends lease), `processingStart`/`processingEnd` updates (in-flight set),
`requestDetach` signal, `adapterExited` signal (collapses draining → detached), `forceDetach`
update, `destroy` update.

**Heartbeat invariant** (#249): After a successful `claimAttachment`, the adapter's heartbeat
loop MUST fire at the configured `heartbeatMs` cadence for the life of the lease. Silent
orphaning of the loop (unhandled error, missed reschedule) is now detectable via structured
log lines emitted by `src/adapters/base.ts` (grep `[claude-tempo:adapter]`):
- `first heartbeat scheduled in Xms` — after claim
- `heartbeat#1 delivered` — first successful tick; reset on reconnect/CAN-rebind
- `heartbeats-delivered=N / phase-ticks=N` — liveness breadcrumb every 10 ticks
- `guard tripped: {stopped, reconnecting, hasHandle, hasToken, terminalFired}` — emitted on
  any tick early-return that would previously have silently orphaned the timer
- `WARNING: heartbeat staleness` — phase-watcher fires when `lastHeartbeatAt` falls more
  than 2× `heartbeatMs` behind `now`, before the workflow's lease-reap triggers

Absence of `heartbeats-delivered=` in a multi-hour session log is a strong indicator of
tick-orphan recurrence. The CAN-boundary lease extension also uses `currentAttachment.leaseMs`
(= 3× `heartbeatMs`, negotiated at claim time) instead of a hardcoded 30s — ensuring a CAN
between heartbeats does not prematurely reap a healthy attachment.

---

## Cross-ensemble primitives

**Broadcast** — Fan-out variant of `cue` — sends a message to all active players in the
ensemble in a single call. Optionally filtered by player type. Skips the sender, pending
sessions, and (by default) stale sessions.

**Recall** — Queries a session's own message history from the Temporal workflow. Shows received
messages by default; pass `includeSent: true` to also see sent messages. Supports `limit`,
`since`, and `from` filters.

**Per-host task queues** — Each host running the claude-tempo daemon also runs a
`claude-tempo-{hostname}` activity worker for local-only operations (e.g., `spawnProcess`).
This enables cross-machine recruiting — the `recruit`, `restart`, and `migrate` tools accept
an optional `host` parameter to route the spawn to a remote machine's task queue. The target
host must have an active daemon running.

---

## Scheduling

**Schedule** — A one-shot or recurring message delivery configured via the `schedule` tool.
Backed by a durable `claudeSchedulerWorkflow` — survives restarts. Supports:
- `delay` — fire once after a duration (e.g. `"5m"`)
- `at` — fire once at a fixed ISO time
- `every` — fire repeatedly on an interval
- `cron` — fire on a cron expression with optional IANA `timezone`

Cron schedules use `croner` for expression parsing and next-fire computation. Managed via
`schedule`, `unschedule`, and `schedules` tools.

---

## Ensemble configuration

**Lineup** — A YAML file defining an ensemble configuration: which players to recruit, their
types, working directories, and optional startup messages. Load via `load_lineup` to bootstrap
a full ensemble in one step; resolves by name using a three-tier lookup (saved lineups →
shipped examples → file path). Save via `save_lineup` to snapshot a running ensemble's state
for later reuse.

---

## Conductor-only features

**Quality Gate** — A named checklist of criteria a conductor tracks to verify a task is
complete. Created via `quality_gate`, evaluated via `evaluate_gate`, listed via `gates`. Each
criterion has a `pending` → `passed` | `failed` status; the gate's aggregate status is derived
automatically (`all passed → passed`, `any failed → failed`, else `open`). Gates are stored in
the conductor workflow and survive `continueAsNew`.

**Worktree** — A git worktree provisioned by the conductor for a player, giving them an
isolated checkout on a separate branch. Managed via the `worktree` tool: `create` provisions
the worktree and notifies the player, `remove` cleans up after the task, `list` shows all
active worktrees. Worktree assignments are stored in the conductor workflow (`WorktreeEntry`
records: player, path, branch, gitRoot, createdAt, createdBy). See
[orchestration.md — When to use worktrees](orchestration.md#when-to-use-worktrees) for
heuristics on when worktrees pay off vs. are overkill.

**Stage** — A fan-out/fan-in tracking primitive. Created via `stage`, listed via `stages`,
cancelled via `cancel_stage`. Each stage tracks a set of players; when a tracked player sends a
`report`, their stage status updates automatically (`waiting` → `reported` or `blocked`). When
all players have reported, the conductor is notified. If `failurePolicy` is `'halt'` (default),
a blocker from any player fails the entire stage. Stages survive `continueAsNew`.

---

## Flow control

**Hold / Release** — Controlled ensemble startup. Two modes:

- **Deferred-startup hold** (`load_lineup(initialStartup: true)`, used by `up --lineup` and
  `conduct --lineup`): lineup instructions + a banner/directive are baked into the conductor's
  `SessionInput.messages[]` at workflow creation. The directive text instructs the conductor to
  wait silently for the user's first message, then call `resume_ensemble { release: true }`
  (which unpauses the ensemble AND releases held players in one call), then decompose. The entire
  ensemble is paused via `pause_ensemble` (scheduler + per-session outboxes + Maestro) until
  the conductor does so. Pass `--no-hold` to opt out and deliver instructions immediately.

- **Explicit hold** (`load_lineup(hold: true)`, conductor-invoked mid-work): spawns players with
  locked outboxes and a standby message instead of their real task. When ready, `release` (MCP
  tool or `claude-tempo release` CLI) unlocks outboxes and delivers the actual task messages. Use
  case: pre-warm a full team before kicking off a long job.

**Pause / Resume** — Ensemble-wide mid-session flow control. `pause_ensemble` locks all session
outboxes and signals the scheduler to skip fires; `resume_ensemble` reverses both. `stop` outbox
entries bypass the pause lock and are always dispatched. Pass `release: true` to `resume_ensemble`
(or `--release` on `claude-tempo resume`) to also release any held sessions in the same call —
idempotent on non-held sessions. Pause state is owned by the per-ensemble Maestro
(`maestroSetPaused` signal) and synced to sessions and the scheduler.

**Outbox lock** — A workflow-level flag on each session that gates outbox dispatch independently
of pause. Used by the hold mechanism (`outboxLocked` query, `releaseHeld` signal) and the pause
mechanism (`setPaused` signal, `paused` query). The two flags are independent — a session can be
held (locked) but not paused, or paused but not locked.

---

## Infrastructure

**Maestro** — Two Temporal workflow variants that aggregate ensemble state:
- **Per-ensemble** `claudeMaestroWorkflow` (ID: `claude-maestro-{ensemble}`) — monitors one
  ensemble. Maintains a player snapshot, ring-buffer event log (max 200 entries), and aggregated
  ensemble chat cache (max 500 entries, refreshed every ~10s via `fetchEnsembleChat`). Queues
  commands for relay to the conductor via `maestroSendCommand`. Owns pause/resume.
- **Global** `claudeGlobalMaestroWorkflow` (ID: `claude-maestro-global`) — spans all ensembles.
  Aggregates players by ensemble, maintains a cross-ensemble message ring buffer (max 500
  entries), and exposes on-demand player/conductor history via `maestroFetchPlayerMessages` and
  `maestroFetchConductorHistory` updates.

Both are implemented in `src/workflows/maestro.ts` with activities in `src/activities/maestro.ts`.

**TempoClient** — The API layer for querying ensemble state (`src/client/`). The interface and
types live in `interface.ts`; the factory implementation lives in `index.ts`. Provides
`discoverEnsembles`, `getPlayers`, `getMessages`, `getConductorHistory`, `sendMessage`,
`sendCommand`, `getEnsembleChat`, `getGates`, `getStages`, `getWorktrees`, and `terminatePlayer`.
Uses Global Maestro as the primary source with graceful fallback to per-ensemble Maestro and
direct workflow list queries.

**Ensemble state** — Every ensemble is classified into one of three states by TempoClient and
surfaced in the TUI home view and `claude-tempo status`:

- **online** — the maestro hub is unpaused (or, if no hub exists yet, at least one player has a
  live adapter attached).
- **paused** — the hub is paused AND at least one player has a live adapter. The ensemble can
  resume in place via `/play` without losing sessions.
- **offline** — the hub is paused AND zero players have live adapters. Sessions may still exist
  as `detached` workflows; use `/restore` to reattach them.

The maestro session itself is excluded from adapter counts. Source:
`src/client/index.ts` (classification block, `liveAdapterCount` + `maestroPaused` query).

---

## Related

- [ARCHITECTURE.md](ARCHITECTURE.md) — three-layer workflow/adapter/process model
- [tools.md](tools.md) — MCP tool reference with usage details
- [WIRE-PROTOCOL.md](WIRE-PROTOCOL.md) — stable signal/query/update names
- [scheduling.md](scheduling.md) — scheduling in depth
- [orchestration.md](orchestration.md) — quality gates, stages, and worktrees
