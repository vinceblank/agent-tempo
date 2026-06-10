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

**`recruit` vs Claude Code `Agent` tool** — Two surfaces for spawning sub-agents; choosing
wrong locks you out of mid-flight updates.

| | `recruit` (tempo player) | `Agent` tool (sub-agent) |
|---|---|---|
| Identity | Stable `playerId`, registered with ensemble | Ephemeral; valid only inside the spawner's process |
| Visibility | Appears in `ensemble`; visible across all conductor turns | Invisible to `ensemble`; only the spawner knows it exists |
| Messaging | Addressable via `cue` at any point | Not addressable via `cue`; `SendMessage` is LLM-only |
| Lifecycle | Temporal workflow; survives daemon bounce and session restart | Process-local; dies when the spawner's turn ends |
| Spawn cost | ~3–5s session boot | Lightweight; no Temporal workflow |

**Rule of thumb**: use `recruit` whenever you might want to update the agent's brief mid-flight,
merge results across multiple turns, or restart it with preserved context. Use `Agent` for
self-contained one-shot work (research spikes, quick lookups, parallel greps) whose result you
will read once and discard within the same turn.

> **Why `cue` won't reach Agent-tool agents**: Tempo's MCP server runs as a separate process
> from Claude Code and has no access to Claude Code's internal task registry. `cue` signals
> Temporal workflows; Agent-tool sub-agents are not Temporal workflows. See the `cue` tool's
> error message for the full explanation if you accidentally try this.

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

**Cross-host orphan visibility** (#151) — When a host goes offline with running player workflows
still attached to it, those sessions become **dormant orphans** from the perspective of every
*other* host: the workflows are alive in Temporal but no adapter on the local daemon owns them.
The remote daemon's `reconcileOnBoot` reattaches them automatically when it returns, so most
operators never need to think about cross-host orphans at all.

Three discovery surfaces let you see them when you do need to:

- **`agent-tempo restore <ensemble>`** (default) — reattaches dormant orphans on the **local**
  host. Cross-host orphans (those whose `preferredHost` points elsewhere) are skipped silently
  with `reason: 'preferredHost'` — the remote daemon is the authoritative restorer and the local
  host shouldn't barge in. Almost always the right behavior.

- **`agent-tempo restore --all-hosts`** (#151) — cluster-view, read-only listing. Surfaces every
  orphan in the namespace grouped by `preferredHost`, annotated with a liveness label joined
  against `listHosts()`:
  - `[live]` — preferred host's daemon is polling now (`HOST_FRESHNESS_THRESHOLD_MS`, 60s).
    Recovery is imminent on its next reconcile tick.
  - `[stale]` — preferred host registered a profile but no poller seen recently. Probably down.
  - `[missing]` — preferred host has no registered profile at all (never came back, or maestro
    restarted and the profile expired). Almost certainly safe to deliberately steal.
  Each cross-host group includes the TUI `/migrate <player> <local> --force` command the
  operator would run to steal the session to the local host. The verb **never** enqueues a
  restart itself — it's a discovery tool, not a recovery action.

- **TUI `/migrate <player> <host> --force`** — the deliberate-action recovery edge. Reattaches
  the session on the local host, stealing it from whichever host currently owns the attachment.
  Replaces the operator-judgment role that a timer-based reclaim cannot fulfill — a clock cannot
  distinguish "host decommissioned" from "host offline for the weekend," and PR-F §3 Site 3
  forbids unprompted cross-host takeover. The §16.5-Option-B `--yes-steal=<currentHost>`
  deliberate-action gate is now enforced on both surfaces (MCP `restart`/`migrate` tools and the
  TUI `/migrate` handler, #580) — `--force` against a target whose current attachment lives on
  another host hard-rejects until the operator types the holder's hostname exactly. The same
  finger habit that mashes `y` at any prompt cannot satisfy a name-the-target check.

The cluster-view path is opt-in to keep `agent-tempo restore <ensemble>` scriptable and
backward-compatible — scripts that previously expected the per-host narrow output continue to
work unchanged.

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
  environment. Tool surface limited to agent-tempo MCP tools (cue, report, recall, …) — file-edit
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
log lines emitted by `src/adapters/base.ts` (grep `[agent-tempo:adapter]`):
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

### Cross-host orphans (#579)

A **cross-host orphan** is a session workflow whose attachment phase is
live (`detached` / `draining` / `attached` / `processing` / `awaiting`)
but whose home-host daemon isn't running an adapter — typically because
the host went down, the daemon crashed without an orderly destroy, or
the host's process tree was killed mid-workflow. The workflow stays
alive in Temporal; only the adapter is gone.

Three surfaces expose orphans, in increasing scope:

- `agent-tempo restore` — recovers orphans **on the current host** only.
  Backed by `restoreOrphansOnce` in `mode: 'local'`.
- `agent-tempo restore --all-hosts` — read-only cluster-view listing
  (#151). Same query, just doesn't auto-restore — emits each row as a
  `crossHost` skip the operator can act on with `/migrate`.
- **Dashboard `/orphans` view** (#579) — the cluster-view rendered as a
  table with `migrateCommand` strings the operator pastes into a TUI
  session on the recovery host. View-only in v1.

All three share `queryOrphanedSessions` (`src/reconcile/orphans.ts`) as
the visibility query and the same `buildCrossHostDetail` formatter for
the preferred-host fallback chain. The dashboard wire surface is
`GET /v1/orphans[?ensemble=<name>]`; see
[`docs/ops/cross-host-orphans.md`](ops/cross-host-orphans.md) for the
operator runbook.

---

## Cross-ensemble primitives

**Broadcast** — Fan-out variant of `cue` — sends a message to all active players in the
ensemble in a single call. Optionally filtered by player type. Skips the sender, pending
sessions, and (by default) stale sessions.

**Recall** — Queries a session's own message history from the Temporal workflow. Shows received
messages by default; pass `includeSent: true` to also see sent messages. Supports `limit`,
`since`, and `from` filters.

**Coat-check** (#318, ADR 0008) — Ensemble-shared, ticket-keyed stash for content that's too
large to inline in a `cue` body (the wire cap is 100 KB). The motivating case: a researcher
finishes a 3K-word report and needs to hand it to an engineer; pasting it into a cue blows
the cap, and conductor-routed delivery is fragile under restarts. With coat-check the
researcher calls `coat_check_put` to stash the artifact on per-ensemble Maestro state, gets
back a ticket id, and includes it on a normal `cue` via the `attachmentTicket` field. The
engineer sees the ticket on their `recall` row and calls `coat_check_get` to pull the body.

Four MCP tools: `coat_check_put` / `coat_check_get` / `coat_check_list` / `coat_check_evict`.
Three guarantees worth remembering:

- **Bounded storage**: max 20 entries × 32 KiB content per ensemble (640 KiB aggregate). The
  21st put rejects with `CoatCheckSlotsFull` listing the oldest 3 ticket ids — caller waits
  for TTL or calls `coat_check_evict` (owner-or-conductor). **No LRU eviction** — silent peer
  eviction is the wrong default in a cross-host shared store; refuse-and-error makes
  saturation an observable signal instead.
- **TTL inline-sweep**: every entry has a server-clamped TTL (default 7 days, range [1h, 30d]).
  Sweep runs at the head of every coat-check handler, so an expired entry is invisible to
  `get` / `list` / `evict` even if the per-ensemble Maestro hasn't had a refresh tick since
  the expiry.
- **Fetch audit**: every successful `coat_check_get` bumps `lastFetchedAt` / `lastFetchedBy` /
  `fetchCount` on the entry. `coat_check_list` does NOT bump these — only redemptions count.
  The putter can later inspect "did anyone redeem my ticket?" via the list. Pass
  `unfetchedOnly: true` to filter for never-redeemed entries (owner cleanup workflow).

Audit identity (`putBy`, `fetchedBy`, `evictedBy`) is set by the MCP tool layer via
`getPlayerId()` — there is no `playerId` arg on any of the four tool schemas, so callers
cannot spoof. Same structural-permission pattern as `save_state` / `fetch_state` from #334.

The dashboard surface for coat-check (visualizing entries, fetch counts, expirations) is a
separate follow-up; the `coat_check_list` query is the integration point.

**Per-host task queues** — Each host running the agent-tempo daemon also runs a
`agent-tempo-{hostname}` activity worker for local-only operations (e.g., `spawnProcess`).
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
  tool or `agent-tempo release` CLI) unlocks outboxes and delivers the actual task messages. Use
  case: pre-warm a full team before kicking off a long job.

**Pause / Resume** — Ensemble-wide mid-session flow control. `pause_ensemble` locks all session
outboxes and signals the scheduler to skip fires; `resume_ensemble` reverses both. `stop` outbox
entries bypass the pause lock and are always dispatched. Pass `release: true` to `resume_ensemble`
(or `--release` on `agent-tempo resume`) to also release any held sessions in the same call —
idempotent on non-held sessions. Pause state is owned by the per-ensemble Maestro
(`maestroSetPaused` signal) and synced to sessions and the scheduler.

**Outbox lock** — A workflow-level flag on each session that gates outbox dispatch independently
of pause. Used by the hold mechanism (`outboxLocked` query, `releaseHeld` signal) and the pause
mechanism (`setPaused` signal, `paused` query). The two flags are independent — a session can be
held (locked) but not paused, or paused but not locked.

---

## Command-center and player supervision

**Command-center planner** (#700 P2) — An inbox-less interactive Pi session (the operator's planning seat) that routes questions through the maestro Q&A mailbox instead of Temporal inbox signals. The planner is not a registered player — it has no Temporal inbox, which is why Q&A routes through the maestro. The planner sends a `cue` tagged `[Q <questionId>]` to a player; the player calls `respond` (passes `questionId` + answer `text`) to park the answer on the maestro via `maestroPostAnswer`; the planner reads it back via `maestroGetAnswer` and is woken by the `answer` SSE event when the answer lands (see [SSE-PROTOCOL.md §6](SSE-PROTOCOL.md)). Cap: 20-slot mailbox, TTL 1h per answer. `/handoff` cues hand active work to a conductor — a registered player with a Temporal inbox that executes the plan.

**Player supervision** — none. The former Pi permission layers (the MD-G operator gate with its `guardrailPolicy` postures and the MD-C `toolAccess` axis) were **removed** (2026-06): a recruited headless Pi player executes any tool — **including shell** — without operator approval, exactly like the other adapters (`claude-code-headless`, `opencode`). Observability remains via the mission-control board (coarse SSE + fine `/inner` tail); control remains via `cue` / `pause` / `restart` / `destroy` / `reset`. See [docs/design/pi-streamline-gate-removal-cc.md](design/pi-streamline-gate-removal-cc.md) for the rationale and removal record.

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
surfaced in the TUI home view and `agent-tempo status`:

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
