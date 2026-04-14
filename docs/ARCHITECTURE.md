# Architecture — Session Model and Ensemble Coordination

> **Scope:** Describes the target state after the v0.25 rebuild (PR-A through PR-F merged).
> **Design doc-of-record:** `docs/design/session-lifecycle-rebuild-v2.md` — full phase machine, transition invariants, and restart algorithm.
> **Wire protocol:** `docs/WIRE-PROTOCOL.md` — exact signal/query/update names and stability guarantees.
> **Quick definitions:** [`docs/concepts.md`](concepts.md) — full glossary.

---

## Core insight

A session is three independent layers, each with its own lifetime. Upper layers outlive lower ones. The workflow is the authoritative durable state; the adapter is a lease-bounded binding; the process is the ephemeral inference engine. Ensemble-level coordination lives on a separate orthogonal axis — Maestros and the Scheduler observe player state but are structurally independent of the three-layer player stack.

---

## Part 1 — The three-layer player stack

```
┌────────────────────────────────────────────────────┐
│  Layer 1 — Workflow (Temporal)                     │
│  claudeSessionWorkflow                             │
│  ID: claude-session-{playerId}                     │
│  Owns: message backlog, phase machine, gates,      │
│        stages, search attributes, outbox           │
│  Lifetime: recruit → destroy (outlives all)        │
└─────────────────────┬──────────────────────────────┘
                      │
                      │  Updates (adapter → workflow):
                      │    claimAttachment, forceDetach
                      │    processingStart, processingEnd
                      │    destroy, enqueueSpawn, setPreferredHost
                      │
                      │  Signals (adapter → workflow):
                      │    heartbeat, requestDetach, adapterExited
                      │
                      │  Queries (adapter → workflow):
                      │    attachmentInfo, orphanSummary
                      │
┌─────────────────────▼──────────────────────────────┐
│  Layer 2 — Adapter (Attachment)                    │
│  BaseAttachment subclass                           │
│    InteractiveAttachment  — Claude Code CLI        │
│    CopilotSdkAttachment   — Copilot SDK            │
│  Owns: lease, heartbeat loop, runId pin,           │
│        phase watcher, adapterId                    │
│  Lifetime: claim → detach/gone                     │
│  (one instance per run; workflow may have many     │
│   adapters over its lifetime via restart)          │
└─────────────────────┬──────────────────────────────┘
                      │
                      │  MCP notifications (push) or
                      │  SDK invocation (blocking)
                      │
┌─────────────────────▼──────────────────────────────┐
│  Layer 3 — AI Model (Process)                      │
│  Claude Code CLI / Copilot SDK process             │
│  (future: Claude API native adapter, #131)         │
│  Owns: inference, tool calls, session context      │
│  Lifetime: spawn → exit (most ephemeral)           │
└────────────────────────────────────────────────────┘
```

### Phase machine

The workflow tracks the adapter's state via a 7-phase machine, exposed as the `ClaudeTempoAttachmentState` search attribute and via the `attachmentInfo` query:

```
booting → attached → processing
                   ↘ awaiting
          draining → detached
any non-terminal → gone  (via destroy)
```

`awaiting` is the idle refinement of `attached` (lease held, no in-flight work). `draining` is the graceful-reap path (`requestDetach` received, outbox flushing). `detached` means the workflow is alive but holds no adapter lease — the orphan state that PR-E's `reconcileOnBoot` repairs.

### Verb-to-layer mapping

| Verb | Layer 1 | Layer 2 | Layer 3 |
|---|---|---|---|
| `recruit` | Created (workflow started, phase `booting`) | Created (claims lease → `attached`) | Created (process spawned) |
| `detach` | Phase `attached → draining → detached`; workflow persists | Graceful teardown; fires `adapterExited` | Exits normally |
| `restart` | Unchanged (runId continuity preserved) | Old instance revoked (`forceDetach`); new instance claims | Old exits; new spawns |
| `migrate` | `setPreferredHost` updated; otherwise unchanged | New instance claims on target host's task queue | New process spawns on target host |
| `destroy` | Terminates (workflow completes; terminal) | `onTerminal` fires; teardown | Killed if still alive |

`restart` and `migrate` affect only layers 2 and 3. Layer 1 carries the full message history, phase state, and search attributes across the restart gap — that is the purpose of the durable workflow.

### Event matrix

| Event | Workflow state | Adapter state | Process state | Result |
|---|---|---|---|---|
| Process crash | Unchanged | Detects exit → fires `adapterExited` | Gone | Phase → `detached`; workflow persists |
| `destroy` verb | Terminates (complete) | `onTerminal` fires; teardown | Killed if alive | All three layers end |
| `detach` verb | `draining → detached` | Graceful teardown; `adapterExited` sent | Exits normally | Workflow persists; adapter + process released |
| `restart` (any phase) | Unchanged; `forceDetach` clears old lease | Old revoked; new claims fresh lease | Old exits; new spawns | Full continuity; fresh adapter + process |
| `migrate` (cross-host) | `preferredHost` updated | New claims on `claude-tempo-{host}` task queue | New spawns on target host | Same as restart; spawn routed to remote |
| Host / machine crash | Unchanged; lease held by absent adapter | Heartbeat stops; lease TTL expires | Gone | Phase → `detached` after lease timeout; daemon reconcile repairs |
| Heartbeat timeout | Phase → `detached` | Revoked (lease expired) | Dead or orphaned | Session queryable via `ClaudeTempoAttachmentState=detached`; `restart` or auto-restore |

**Process crash vs. host crash.** When only the process dies, the adapter fires `adapterExited` immediately — phase transitions to `detached` within seconds. When the host crashes, no signal is sent; the workflow waits out the heartbeat lease TTL (typically 90s) before transitioning.

---

## Part 2 — Ensemble and global coordination

The three-layer player stack describes a single session. Ensemble-level coordination is handled by a separate set of workflows that sit above the player layer and observe across it.

### Full workflow landscape

```
┌────────────────────────────────────────────────────────────┐
│  Global level (1 total)                                    │
│  claudeGlobalMaestroWorkflow                               │
│  ID: claude-maestro-global                                 │
│  Observes: all ensembles via search attribute lookups      │
└──────────────────────┬─────────────────────────────────────┘
                       │ aggregates (search attrs + queries)
┌──────────────────────▼─────────────────────────────────────┐
│  Ensemble level (2 workflows per ensemble)                 │
│                                                            │
│  claudeMaestroWorkflow                                     │
│  ID: claude-maestro-{ensemble}                             │
│  Observes: all players in ensemble                         │
│  Owns: pause/resume, ensemble chat cache, command relay    │
│                                                            │
│  claudeSchedulerWorkflow                                   │
│  ID: claude-scheduler-{ensemble}                           │
│  Owns: timed + recurring message delivery                  │
└──────────────────────┬─────────────────────────────────────┘
                       │ aggregates (search attrs + queries)
┌──────────────────────▼─────────────────────────────────────┐
│  Player level (N per ensemble)                             │
│  claudeSessionWorkflow  ×N                                 │
│  ID: claude-session-{playerId}                             │
│  = Layer 1 of the three-layer player stack                 │
└────────────────────────────────────────────────────────────┘
```

Arrows point upward (Maestros aggregate from below); there are no downward control signals except for `pause_ensemble` / `resume_ensemble` (Maestro → session outbox lock) and scheduler fires (Scheduler → session outbox).

### Workflow table

| Workflow | Scope | ID | Role |
|---|---|---|---|
| `claudeSessionWorkflow` | per player | `claude-session-{playerId}` | Durable player state (= Layer 1 of the three-layer stack) |
| `claudeMaestroWorkflow` | per ensemble | `claude-maestro-{ensemble}` | Observer, chat aggregator, command relay, pause/resume owner |
| `claudeSchedulerWorkflow` | per ensemble | `claude-scheduler-{ensemble}` | Durable timed and recurring message delivery |
| `claudeGlobalMaestroWorkflow` | singleton | `claude-maestro-global` | Cross-ensemble aggregation, on-demand player/conductor history |

### Key properties of Maestros and Scheduler

**No adapter, no process.** Maestros and the Scheduler are pure Temporal workflows running on the daemon's worker. They have no AI agent, no stdio, no heartbeat lease. The three-layer model does not apply to them — they are standalone "layer 1" equivalents without layers 2 or 3.

**Observers, not owners.** Maestros read player state via search attribute queries and `attachmentInfo` / `orphanSummary` workflow queries. They do not control player lifecycle — that is the conductor's job via verbs. The one exception: the per-ensemble Maestro owns pause/resume, syncing the pause flag to all session outboxes (`maestroSetPaused` signal) and to the Scheduler (`setSchedulerPaused` signal).

**The API surface for external UIs.** `TempoClient` (`src/client/`) talks to Maestros as the primary data source. `getPlayers`, `getMessages`, `getConductorHistory`, `getEnsembleChat` all read from Maestro caches (ring buffer + periodic refresh via `fetchEnsembleChat` activity), not from individual session queries. External UIs read one pre-aggregated cache instead of fanning out across N workflows.

**`src/tui/client.ts` is a thin re-export shim** that re-exports `createTempoClient` from `src/client/` for backward compatibility with the TUI. New consumers should import from `src/client/` directly, not from the shim.

**Simpler lifecycles.** Ring buffer + `continueAsNew` periodically. No claim/heartbeat/detach/destroy. No V2 lifecycle concerns. Maestros and the Scheduler are structurally unchanged by the v0.25 revamp.

### Two orthogonal axes

The architecture has two independent axes:

- **Vertical axis (per player):** workflow → adapter → process. Upper outlives lower. This is what v0.25 restructured — the attachment lease model, the phase machine, and the adapter registry all live here.
- **Horizontal axis (ensemble + global):** Maestros and the Scheduler aggregate across players. They observe the vertical axis but do not participate in it.

The v0.25 revamp is surgically scoped to the vertical axis. Maestros and the Scheduler are unchanged.

### Verb-to-workflow routing

Most verbs touch only `claudeSessionWorkflow` (the player stack). The exceptions:

| Verb / tool | Target workflow |
|---|---|
| `recruit`, `restart`, `migrate`, `detach`, `destroy` | `claudeSessionWorkflow` only |
| `pause_ensemble`, `resume_ensemble` | `claudeMaestroWorkflow` (`maestroSetPaused`) |
| `schedule`, `unschedule`, `schedules` | `claudeSchedulerWorkflow` |
| `sendCommand` (TUI bare text) | `claudeMaestroWorkflow` (`maestroSendCommand` update) |

Maestros observe player state changes via periodic search attribute refresh, not via explicit notification from verbs.

---

## Part 3 — Why this enables PR-E and PR-F

### PR-E — Daemon reconcile-on-boot

PR-E's `reconcileOnBoot` pass is a direct consequence of the three-layer model. On daemon restart, layer 1 (the workflow) is still alive — it survived because Temporal is the durable store, not the host. The daemon queries `ClaudeTempoAttachmentState=detached` to find workflows with no adapter lease, reads each workflow's `orphanSummary` query for `preferredHost` and message context, and rebuilds a fresh layer 2 + 3 pair by routing `spawnProcess` → `claimAttachment`. From the workflow's perspective, this is identical to a `restart` — the phase machine transitions `detached → booting → attached` and the session resumes. The `restorePolicy` config (`auto` | `prompt` | `never`) gates whether this happens automatically or requires operator confirmation.

### PR-F — Cross-host routing

Layer 1 is topology-agnostic. A `claudeSessionWorkflow` has no awareness of which host its adapter runs on — it tracks only the `preferredHost` field on its state and the `ClaudeTempoAttachedHost` search attribute set by the adapter on claim. Layer 2 is where host affinity lives: the `enqueueSpawn` update carries the target host name, and the `spawnProcess` activity is dispatched to the `claude-tempo-{host}` task queue, which only the daemon on that host processes. `migrate` (`restart --host=<target>`) sets `preferredHost`, issues `forceDetach` on the current adapter, and routes the new spawn to the target queue. The `--yes-steal=<hostname>` flag requires the caller to name the current host before taking over a live session, preventing accidental cross-host conflicts.

---

## Cross-references

| Topic | Reference |
|---|---|
| Phase machine invariants and transition rules | `docs/design/session-lifecycle-rebuild-v2.md` §2.2, §2.4 |
| Restart algorithm | `docs/design/session-lifecycle-rebuild-v2.md` §8.2 |
| Orphan restore policy and decision tree | `docs/design/session-lifecycle-rebuild-v2.md` §10.2 |
| Exact signal/query/update names and types | `docs/WIRE-PROTOCOL.md` |
| Key concept definitions (player, ensemble, adapter, etc.) | [`docs/concepts.md`](concepts.md) |
| Adapter authoring guide | `src/adapters/README.md` |
