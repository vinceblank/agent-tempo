# Wire Protocol Reference

This document is the authoritative reference for all Temporal signal, query, update, and workflow names used by claude-tempo. These names form the wire protocol between sessions — they appear in Temporal history and are referenced across workflow versions.

## Stability Guarantee

> **These names are stable as of v0.10.** Renaming or removing any signal, query, update, or workflow name is a breaking change requiring a major version bump. Adding new names is non-breaking.

---

## Workflow Names

| Name | Description |
|------|-------------|
| `claudeSessionWorkflow` | The main workflow for a player session. One instance per active Claude Code session. Carries all message state, outbox entries, and conductor history across `continueAsNew` boundaries. |
| `claudeSchedulerWorkflow` | Durable scheduler workflow — one per ensemble. Manages named one-shot and recurring schedules, firing them by signalling the target session at the configured time. |
| `claudeMaestroWorkflow` | Per-ensemble management hub — one per ensemble. Workflow ID pattern: `claude-maestro-{ensemble}`. Aggregates a snapshot of all players, maintains a ring-buffer event log (max 200 entries), and queues commands for relay to the conductor. Survives restarts via `continueAsNew`. |
| `claudeGlobalMaestroWorkflow` | Global ensemble hub — single instance spanning ALL ensembles. Workflow ID: `claude-maestro-global`. Aggregates players by ensemble, maintains a cross-ensemble message ring buffer (max 500 entries), and exposes on-demand player/conductor history via updates. Survives restarts via `continueAsNew`. |

---

## Session Signals

Signals sent **to** a `claudeSessionWorkflow` instance.

| Signal Name | Payload | Description |
|-------------|---------|-------------|
| `receiveMessage` | `{ from: string; text: string; isMaestro?: boolean; isScheduled?: boolean; scheduleName?: string; responseRequested?: boolean }` | Delivers an inbound message from another player (or Maestro) into the session's inbox. The session's poller consumes pending messages and forwards them to Claude. `isScheduled: true` and `scheduleName` are set when the message was fired by the scheduler workflow — useful for dashboard integrations that want to distinguish scheduled messages from direct cues. `responseRequested: false` marks informational messages (broadcasts, schedule-fires, heartbeats, system notifications) that should not trigger blocked detection. Defaults to `true` when omitted, preserving existing behavior for direct cues. |
| `recordSentMessage` | `{ to: string; text: string }` | Records an outbound message in the session's sent-message history without triggering any delivery. Used for audit/history continuity. |
| `setPart` | `string` | Updates the player's current "part" — a short description of what the session is working on, visible to other players via `ensemble`. |
| `markDelivered` | `string[]` | Marks one or more messages (by ID) as delivered. Resets stale-detection timer; any delivery proves the session is alive. |
| `setName` | `string` | Updates the player's human-readable ID (`ClaudeTempoPlayerId` search attribute). Called by the `set_name` MCP tool. |
| `updateMetadata` | `{ hostname?, gitBranch?, gitRoot?, status?, terminatedBy?, enableStaleDetection?, playerType?, playerTypeDescription?, worktreePath?, sessionId? }` | Updates session metadata fields and syncs search attributes. Setting `status: 'terminated'` triggers graceful shutdown; `enableStaleDetection: true` re-arms stale detection after reconnect; `worktreePath` records the git worktree path when the session uses worktree isolation; `sessionId` stores the session UUID — used for Copilot SDK session resumption and Claude Code deterministic `--resume` on restart. |
| `releaseHeld` | *(none)* | Releases a held session: injects the stored initial message and unlocks the outbox. Sent by the conductor (or operator) after a session has been paused at startup via the hold/pause mechanism. **Idempotent** on sessions that aren't holding (no `heldMessage`, `outboxLocked` already `false`) — safe to blanket-signal across an ensemble. Used by the `release` MCP tool, `claude-tempo release` CLI, and (since #172) by `resume_ensemble { release: true }` / `claude-tempo resume --release` which fan it out to every running session. |
| `setPaused` | `boolean` | Pauses (`true`) or resumes (`false`) the session's outbox dispatch. While paused, queued outbox entries are not processed. |
| `heartbeat` | `{ attachmentId: string; at: string }` | **v0.25.** Liveness proof from the attached adapter — renews the lease's `expiresAt` to `workflow.now() + LEASE_MS`. Ignored (last-write-wins) if `attachmentId` doesn't match the current attachment. Adapters beat at 30 s (SDK) or 60 s (interactive). |
| `requestDetach` | `{ reason: DetachReason; deadlineMs: number }` | **v0.25.** Adapter-, conductor-, or operator-initiated graceful detach. Transitions phase → `'draining'`; the main loop reaps to `'detached'` when the outbox is drained OR after `drainingDeadline` (default 5 s). Idempotent on `'draining'`/`'detached'`. |
| `adapterExited` | `{ attachmentId: string; reason: DetachReason }` | **v0.25.** Adapter's final signal before process exit — collapses `'draining' → 'detached'` immediately if `attachmentId` matches. Ignored on `'detached'`/`'gone'`. |

---

## Session Queries

Queries on a `claudeSessionWorkflow` instance (synchronous, read-only).

| Query Name | Return Type | Description |
|------------|-------------|-------------|
| `getPart` | `string` | Returns the player's current part description. |
| `getMetadata` | `SessionMetadata` | Returns the full session metadata object (ensemble, playerId, hostname, status, git info, player type, etc.). |
| `pendingMessages` | `Message[]` | Returns only messages that have not yet been marked as delivered. Used by the MCP server poller. |
| `allMessages` | `Message[]` | Returns the complete inbox, including delivered messages, up to the current `continueAsNew` window. |
| `allSentMessages` | `SentMessage[]` | Returns the session's sent-message history (last 50 entries carried across `continueAsNew`). |
| `outboxLocked` | `boolean` | Returns `true` if the session's outbox is currently locked (held at startup, awaiting `releaseHeld`). Returns `false` once the session is running normally. |
| `paused` | `boolean` | Returns `true` if the session's outbox dispatch is currently paused via `setPaused`. |
| `inFlightMessages` | `string[]` | Returns the IDs of messages currently being processed by a blocking adapter (see `processingStart`/`processingEnd` updates). While this set is non-empty, stale detection is suppressed. Used by Copilot-bridge-style adapters that call a long-running LLM API and cannot mark the message delivered until it returns. |
| `isDestroyed` | `boolean` | Returns `true` if the session has been permanently destroyed via the `destroy` update. Adapters should check this before attempting reconnection — a destroyed session must not be resurrected. |
| `attachmentInfo` | `AttachmentInfo` | **v0.25.** Returns the current attachment state: `{ phase, currentAttachment?, preferredHost?, inFlightCount, processingSince? }`. `phase` is one of `'booting' \| 'attached' \| 'processing' \| 'awaiting' \| 'draining' \| 'detached' \| 'gone'`. Adapters poll this to detect lease revocation / detach directives; tools read it for TUI and verb implementations. |
| `orphanSummary` | `OrphanSummary` | **v0.25.** Returns metadata about a detached orphan — `{ detachedSince?, reason?, preferredHost?, lastAdapter? }`. The daemon uses this at reconcile-on-boot to decide whether to auto-restore per `restorePolicy`. |

---

## Session Updates

Workflow updates on a `claudeSessionWorkflow` instance (transactional, returns a value).

| Update Name | Input | Return | Description |
|-------------|-------|--------|-------------|
| `submitOutbox` | `OutboxEntryInput` | `string` (entry ID) | Appends an outbox entry (cue, report, stop, recruit, release, spawn) to the session's outbox queue and returns its generated UUID. The workflow's dispatch loop processes entries asynchronously via activities. This is the sole write path for all outbound operations. **Spawn entries** (`type: 'spawn'`) are enqueued via `enqueueSpawn` (PR-D) to launch an adapter that picks up a pre-claimed attachment — their 5 attachment-specific fields (`attachmentId`, `attachmentRunId`, `resumeAttachment`, `sessionId?`, `adapterId`) are forwarded to the per-host `spawnProcess` activity. |
| `processingStart` | `{ messageId: string; expectedAttachmentId?: string }` | `{ inFlightCount: number }` | Marks `messageId` as being actively processed by a blocking adapter (e.g. Copilot-bridge's `sendAndWait`). While any messageId is in-flight, stale detection is suppressed and the phase refines to `'processing'` — fixes #99. `messageId` is required for idempotency under at-least-once update retries. `expectedAttachmentId` is optional in v0.25 for shim compatibility; when provided, the update is rejected with `AttachmentMismatch` if it doesn't match the current attachment. Validator rejects destroyed sessions with `WorkflowGone`. A 15-minute `processingDeadline` in the main loop ejects wedged entries. |
| `processingEnd` | `{ messageId: string; expectedAttachmentId?: string }` | `{ inFlightCount: number }` | Marks `messageId` as done. Once the in-flight set empties, phase returns to `'attached'`. Callers should run this in a `try/finally` around the blocking call. `expectedAttachmentId` semantics match `processingStart`. |
| `destroy` | `{ reason?: string; terminatedBy?: string }` | *(void)* | **v0.25: terminal.** Sets phase = `'gone'`, revokes `currentAttachment`, records abandoned outbox entry IDs to workflow history (via `workflow.log.warn`), pushes a final system message, and exits the main loop → workflow COMPLETES. Per design §2.5, `destroy` does **not** wait to drain the outbox — delivery of entries pending at destroy time is best-effort and may be abandoned. **As of #164**, the handler is `async` and invokes `hardTerminateAttachment` on the session's per-host task queue *before* the state flip to prevent an orphaned `claude.exe` when destroy is called while attached; that kill is **best-effort** (failure is logged and the workflow still completes — unlike `forceDetach`, destroy must not wedge when the host worker is unreachable). Adapters (e.g. Copilot bridge's `recreateSession()`) must query `isDestroyed` before attempting reconnect; a destroyed workflow must not be resurrected as a zombie. Idempotent on already-`gone`. |
| `claimAttachment` | `{ host, adapterId, adapterClass, leaseMs, expectedAttachmentId? }` | `AttachmentToken` or `ApplicationFailure` | **v0.25.** Transactional claim or renewal of the attachment lease. Renewal when `expectedAttachmentId` matches an unexpired current attachment → extends `expiresAt`. Conflict when a different live attachment exists → `AttachmentConflict`. Fresh claim otherwise → new `Attachment` with `runId` pinned to the current workflow execution; phase → `'attached'`; in-flight set cleared. Rejects on `gone` with `WorkflowGone`. `leaseMs` validated in range 1000–600000. |
| `forceDetach` | `{ reason: DetachReason; expectedAttachmentId?; gracePeriodMs: number }` | `{ reaped: boolean; previousAttachmentId? }` | **v0.25.** Revoke the current attachment. Returns `{ reaped: true, previousAttachmentId }` when a live attachment was revoked; `{ reaped: false }` when already detached (idempotent). `expectedAttachmentId` guards against TOCTOU. `gracePeriodMs` is reserved for future use — PR-A always detaches immediately. |
| `enqueueSpawn` | `{ host, attachmentId, runId, resume, sessionId?, adapterId, agentDefinition?, agentDefinitionPath?, nativeResolvable? }` | `{ spawnEntryId: string }` | **v0.25.** Queue a spawn outbox entry carrying the claim token. Used by `restart` (PR-D) to route a fresh-adapter spawn to a per-host task queue after `claimAttachment`. The three `agent*` fields (added in #184, non-breaking additive) carry the resolved player-type so restart-triggered spawns pick `--agent <name>` or `--system-prompt <path>` the same way recruit does. |
| `setPreferredHost` | `{ host: string }` | *(void)* | **v0.25.** Record a preferred host for daemon reconcile-on-boot (PR-E). |

---

## Session Outbox Query

| Query Name | Return Type | Description |
|------------|-------------|-------------|
| `outbox` | `OutboxEntry[]` | Returns the full outbox array, including entries in all states (`pending`, `processing`, `delivered`, `failed`). |

---

## Conductor Signals

Conductor-specific signals, only registered when `input.metadata.isConductor` is `true`.

| Signal Name | Payload | Description |
|-------------|---------|-------------|
| `command` | `{ text: string; source: string; replyTo?: string }` | Delivers an external command (e.g. from Maestro or a human operator) to the conductor session. The command is appended to `commandHistory` and injected into the conductor's inbox as a message. |
| `playerReport` | `{ playerId: string; text: string; type: 'result' \| 'blocker' \| 'question' }` | Delivers a report from a player to the conductor. Appended to `reportHistory` and injected into the conductor's inbox. |
| `setQualityGate` | `{ task: string; criteria: string[]; createdBy: string }` | Defines or replaces a quality gate for the given task. Each criterion starts as `'pending'`. If a gate with the same `task` already exists, it is fully replaced. |
| `evaluateGateCriteria` | `{ task: string; evaluations: Array<{ index: number; status: 'passed' \| 'failed'; notes?: string }>; evaluatedBy: string }` | Marks one or more criteria on an existing quality gate as `'passed'` or `'failed'`. Out-of-bounds indices are silently ignored. Gate aggregate status is re-derived after each evaluation. |
| `setWorktree` | `WorktreeEntry` | Records a worktree assignment for a player. `WorktreeEntry` has fields: `player`, `path`, `branch`, `gitRoot`, `createdAt`, `createdBy`. Upserts by player name. |
| `removeWorktree` | `string` | Removes a worktree entry by player name. |
| `setStage` | `{ name: string; players: string[]; failurePolicy?: 'halt' \| 'continue'; createdBy: string }` | Creates or replaces a stage — a fan-out/fan-in tracking primitive. Each player starts as `'waiting'`; when they report, their status updates automatically. If `failurePolicy` is `'halt'` (default), a blocker from any player fails the stage. |
| `cancelStage` | `string` (stage name) | Cancels an active stage by name. Sets status to `'cancelled'`. No-op if the stage is already complete/failed/cancelled. |

---

## Conductor Query

| Query Name | Return Type | Description |
|------------|-------------|-------------|
| `history` | `HistoryEntry[]` | Returns the conductor's combined command + report history, sorted chronologically. Each entry has a `type` (`'command'` or `'report'`) and a `timestamp`. |
| `qualityGates` | `QualityGate[]` | Returns all quality gates. Each gate has a `task` key, `criteria` array, `createdBy`, `createdAt`, and a derived `status` (`'open'`, `'passed'`, or `'failed'`). |
| `worktrees` | `WorktreeEntry[]` | Returns all active worktree assignments. Each entry has `player`, `path`, `branch`, `gitRoot`, `createdAt`, and `createdBy`. |
| `stages` | `StageEntry[]` | Returns all stages. Each entry has `name`, `players` (with per-player status), `status` (`'active'`, `'complete'`, `'failed'`, `'cancelled'`), `failurePolicy`, `createdAt`, `createdBy`, and optional `completedAt`. |

---

## Scheduler Signals

Signals sent **to** a `claudeSchedulerWorkflow` instance.

| Signal Name | Payload | Description |
|-------------|---------|-------------|
| `addSchedule` | `ScheduleEntry` | Registers a new named schedule. If a schedule with the same name already exists it is replaced. `ScheduleEntry.type` is `'once'`, `'interval'`, or `'cron'`. Cron schedules include `cronExpression` and optional `timezone`. |
| `removeSchedule` | `string` (schedule name) | Cancels and removes a named schedule. No-op if the name is not found. |
| `updateScheduleTarget` | `[string, string]` (oldName, newName) | Rewrites schedule `target` and `createdBy` fields from `oldName` to `newName`. Fired by `set_name` when a player renames. No-op if no entries match. |
| `setSchedulerPaused` | `boolean` | Pauses (`true`) or resumes (`false`) schedule fire delivery. While paused, fires that fall due are skipped and not accumulated — resuming does not replay missed fires. |

---

## Scheduler Queries

| Query Name | Input | Return Type | Description |
|------------|-------|-------------|-------------|
| `getSchedules` | — | `ScheduleEntry[]` | Returns all currently registered schedules. |
| `getSchedule` | `string` (schedule name) | `ScheduleEntry \| null` | Returns a single schedule by name, or `null` if not found. |

---

## Per-Ensemble Maestro Signal

Signal sent **to** a `claudeMaestroWorkflow` instance.

| Signal Name | Payload | Description |
|-------------|---------|-------------|
| `maestroShutdown` | *(none)* | Gracefully shuts down the per-ensemble Maestro workflow. |
| `maestroSetPaused` | `boolean` | Sets the ensemble-wide pause state (`true` = paused, `false` = resumed). Acts as ground truth for pause state — sessions and the scheduler sync from this. |

---

## Per-Ensemble Maestro Queries

Queries on a `claudeMaestroWorkflow` instance (synchronous, read-only).

| Query Name | Input | Return Type | Description |
|------------|-------|-------------|-------------|
| `maestroPlayers` | — | `MaestroPlayerInfo[]` | Current snapshot of all players in the ensemble, refreshed periodically. |
| `maestroEvents` | — | `MaestroEvent[]` | Ring buffer of recent ensemble events (max 200). Events are generated by diffing consecutive player snapshots. |
| `maestroPendingCommands` | — | `MaestroPendingCommand[]` | Commands queued via `maestroSendCommand` that have not yet been relayed to the conductor. |
| `maestroEnsembleChat` | `EnsembleChatQuery` | `EnsembleChatResult` | Paginated aggregated chat feed from cached state. Merges maestro session + conductor traffic (deduplicated). Cache refreshed every ~10s alongside the player snapshot; cap at 500 entries. `EnsembleChatQuery`: `{ offset?: number; limit?: number }` (default 0, 50; max limit 200). `EnsembleChatResult` includes `messages`, `total`, `hasMore`, and `hasConductor`. Additive — non-breaking. |
| `maestroPaused` | — | `boolean` | Returns `true` if the ensemble is currently in a paused state as set by `maestroSetPaused`. |

---

## Per-Ensemble Maestro Update

Workflow update on a `claudeMaestroWorkflow` instance (transactional, returns a value).

| Update Name | Input | Return | Description |
|-------------|-------|--------|-------------|
| `maestroSendCommand` | `{ text: string; source: string; replyTo?: string }` | `string` (command ID) | Enqueues a command for relay to the conductor. Returns the generated command ID. The Maestro workflow relays it to the conductor via the `command` signal. |

---

## Global Maestro Signal

Signal sent **to** a `claudeGlobalMaestroWorkflow` instance (`claude-maestro-global`).

| Signal Name | Payload | Description |
|-------------|---------|-------------|
| `maestroNotifyMessage` | `MaestroRelayMessage` | Push-notify the global Maestro of a relayed message. Used for push-based message notifications. |

---

## Global Maestro Queries

Queries on a `claudeGlobalMaestroWorkflow` instance (synchronous, read-only).

| Query Name | Return Type | Description |
|------------|-------------|-------------|
| `maestroEnsembles` | `string[]` | All ensemble names currently known to the global Maestro. |
| `maestroPlayersByEnsemble` | `Record<string, MaestroPlayerInfo[]>` | All players grouped by ensemble. Each `MaestroPlayerInfo` includes an `ensemble` field. |
| `maestroRecentMessages` | `MaestroRelayMessage[]` | Ring buffer of recent messages relayed across all ensembles (max 500). |

---

## Global Maestro Updates

Workflow updates on a `claudeGlobalMaestroWorkflow` instance (transactional, returns a value).

| Update Name | Input | Return | Description |
|-------------|-------|--------|-------------|
| `maestroSendMessage` | `{ ensemble: string; to: string; text: string; source: string }` | `string` (message ID) | Send a message to a specific player in a specific ensemble via Maestro relay. Returns the generated message ID. |
| `maestroFetchPlayerMessages` | `{ ensemble: string; playerId: string }` | `Array<Message \| SentMessage>` | On-demand fetch of a player's merged received/sent message history from their session workflow. |
| `maestroFetchConductorHistory` | `{ ensemble: string }` | `{ success: boolean; history: HistoryEntry[]; error?: string }` | On-demand fetch of a conductor's command/report history. Returns soft failure (`success: false`) if no conductor is running. |
| `maestroGlobalSendCommand` | `{ ensemble: string; text: string; source: string; replyTo?: string }` | `string` (command ID) | Queue a command for relay to a specific ensemble's conductor. Ensemble-scoped variant of the per-ensemble `maestroSendCommand`. |

---

## Search Attributes

The following custom Temporal search attributes are written by `claudeSessionWorkflow` and used for session discovery.

| Attribute | Type | Description |
|-----------|------|-------------|
| `ClaudeTempoEnsemble` | `Keyword` | Ensemble namespace (from `CLAUDE_TEMPO_ENSEMBLE` env var). Scopes sessions to a named group. |
| `ClaudeTempoPlayerId` | `Keyword` | Human-readable player name (or hex ID before `set_name` is called). |
| `ClaudeTempoHostname` | `Keyword` | Hostname of the machine running the session. Used to route spawn activities to the correct per-host task queue. |
| `ClaudeTempoGitRoot` | `Keyword` | Absolute path to the git repository root on the session's host. |
| `ClaudeTempoPlayerType` | `Keyword` | Agent type name (e.g. `tempo-soloist`), set from the player's agent definition. |
| `ClaudeTempoIsConductor` | `Bool` | `true` for conductor workflows, absent or `false` for regular players. Set via `upsertSearchAttributes` in `claudeSessionWorkflow` at startup and after `continueAsNew`. Enables efficient conductor discovery without scanning all session workflows. |
| `ClaudeTempoAttachmentState` | `Keyword` | **v0.25.** Current attachment phase: `booting \| attached \| processing \| awaiting \| draining \| detached \| gone`. Enables external observers (TUI, monitoring, daemon reconcile-on-boot) to query session readiness without polling the `attachmentInfo` query. |
| `ClaudeTempoAttachedHost` | `Keyword` | **v0.25.** Hostname of the machine currently holding the attachment lease. Empty string when no attachment is active (`detached` / `gone` phases). Used by daemon reconcile-on-boot to identify orphaned sessions whose adapter process may have died on this host. |
| `ClaudeTempoAttachmentId` | `Keyword` | **v0.25.** UUID of the current attachment (from `claimAttachment`). Empty string when no attachment is active. Allows the daemon to correlate a specific adapter instance with the workflow that claimed it. |

---

## Type Reference

Types referenced above are defined in `src/types.ts` and re-exported from `src/workflows/signals.ts`, `src/workflows/scheduler-signals.ts`, and `src/workflows/maestro-signals.ts`. Consult those files for the full field shapes.

### `ScheduleEntry` (selected fields)

| Field | Type | Description |
|-------|------|-------------|
| `type` | `'once' \| 'interval' \| 'cron'` | Schedule kind. |
| `cronExpression` | `string?` | Cron expression (e.g. `"0 9 * * 1-5"`). Only present when `type: 'cron'`. |
| `timezone` | `string?` | IANA timezone for cron evaluation (e.g. `"America/New_York"`). Defaults to `"UTC"` when `type: 'cron'` and omitted. |

### `QualityGate` (selected fields)

| Field | Type | Description |
|-------|------|-------------|
| `task` | `string` | Unique key identifying the task this gate covers. |
| `criteria` | `QualityGateCriterion[]` | Ordered list of criteria. Each has `text`, `status` (`'pending' \| 'passed' \| 'failed'`), and optional `evaluatedBy`, `evaluatedAt`, `notes`. |
| `createdBy` | `string` | Player ID of the conductor that created the gate. |
| `createdAt` | `string` | ISO timestamp of gate creation. |
| `status` | `'open' \| 'passed' \| 'failed'` | Derived: all criteria passed → `'passed'`; any failed → `'failed'`; otherwise `'open'`. |

### `WorktreeEntry`

| Field | Type | Description |
|-------|------|-------------|
| `player` | `string` | Player name assigned to this worktree. Used as the upsert key. |
| `path` | `string` | Absolute path to the worktree directory. |
| `branch` | `string` | Git branch checked out in the worktree. |
| `gitRoot` | `string` | Absolute path to the original git root (used by `git worktree remove`). |
| `createdAt` | `string` | ISO timestamp of worktree creation. |
| `createdBy` | `string` | Player ID of the conductor that created the worktree. |

### `StageEntry`

| Field | Type | Description |
|-------|------|-------------|
| `name` | `string` | Unique name identifying this stage. |
| `players` | `StagePlayerStatus[]` | Tracked players. Each has `playerId`, `status` (`'waiting'` \| `'reported'` \| `'blocked'`), and optional `reportType`, `reportText`, `reportedAt`. |
| `status` | `'active' \| 'complete' \| 'failed' \| 'cancelled'` | Aggregate status. `complete` when all players report results; `failed` when a blocker is received and `failurePolicy` is `'halt'`. |
| `failurePolicy` | `'halt' \| 'continue'` | What happens when a player reports a blocker. `halt` fails the stage immediately; `continue` marks the player as blocked but keeps the stage active. |
| `createdAt` | `string` | ISO timestamp of stage creation. |
| `createdBy` | `string` | Player ID of the conductor that created the stage. |
| `completedAt` | `string?` | ISO timestamp of completion, failure, or cancellation. |

### `RecruitOutboxEntry` (selected fields)

| Field | Type | Description |
|-------|------|-------------|
| `allowedTools` | `string[]?` | Tool restrictions from the agent type's `allowedTools` frontmatter. When present, passed to the Claude Code session via `--allowedTools`. Omitted when no restriction applies. |

### `MaestroPlayerInfo`

| Field | Type | Description |
|-------|------|-------------|
| `playerId` | `string` | Human-readable player name. |
| `ensemble` | `string` | Ensemble this player belongs to. Used by the global Maestro for cross-ensemble aggregation. |
| `part` | `string` | Player's current part description. |
| `hostname` | `string` | Machine hostname. |
| `workDir` | `string` | Working directory path. |
| `gitRoot` | `string?` | Git repository root, if detected. |
| `gitBranch` | `string?` | Current git branch, if detected. |
| `isConductor` | `boolean` | Whether this player is the conductor. |
| `agentType` | `string` | Agent backend (`claude` or `copilot`). |
| `playerType` | `string?` | Named agent type (e.g. `tempo-soloist`), if set. |
| `status` | `string?` | Session lifecycle status (`pending`, `active`, `stale`, `blocked`, `terminated`). |

### `EnsembleChatMessage`

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Generated UUID for this chat entry. |
| `from` | `string` | Sending player ID (e.g. `'maestro'`, `'conductor'`, or a player name). |
| `to` | `string` | Recipient player ID. |
| `text` | `string` | Message content, truncated to 500 chars. Full text available via `maestroFetchPlayerMessages`. |
| `timestamp` | `string` | ISO timestamp of the original message. |
| `role` | `'maestro-out' \| 'maestro-in' \| 'conductor-out' \| 'conductor-in'` | Message perspective: `maestro-out` = maestro sent to a player; `maestro-in` = player sent to maestro; `conductor-out` = conductor sent to a non-maestro player; `conductor-in` = non-maestro player sent to conductor. Conductor↔maestro messages are deduplicated and excluded. |

### `EnsembleChatQuery`

| Field | Type | Description |
|-------|------|-------------|
| `offset` | `number?` | Messages to skip from the tail (default 0). |
| `limit` | `number?` | Max messages to return (default 50, max 200). |

### `EnsembleChatResult`

| Field | Type | Description |
|-------|------|-------------|
| `messages` | `EnsembleChatMessage[]` | The requested page of messages, newest at the end. |
| `total` | `number` | Total message count in the cache (up to 500). |
| `hasMore` | `boolean` | True if messages exist beyond `offset + limit`. |
| `hasConductor` | `boolean` | Whether a conductor was found during the last refresh cycle. |

### `MaestroRelayMessage`

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Generated UUID for this relay message. |
| `ensemble` | `string` | Ensemble this message belongs to. |
| `from` | `string` | Sending player ID. |
| `to` | `string` | Recipient player ID. |
| `text` | `string` | Message content. |
| `timestamp` | `string` | ISO timestamp of relay. |
| `direction` | `'inbound' \| 'outbound'` | Whether the message was inbound to or outbound from the tracked player. |

### `MaestroEvent`

| Field | Type | Description |
|-------|------|-------------|
| `type` | `'player_joined' \| 'player_left' \| 'status_changed' \| 'part_changed'` | Event kind. |
| `playerId` | `string` | Player this event refers to. |
| `timestamp` | `string` | ISO timestamp of the event. |
| `oldValue` | `string?` | Previous value (present for `status_changed` and `part_changed`). |
| `newValue` | `string?` | New value (present for `status_changed` and `part_changed`). |

### `MaestroPendingCommand`

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Generated UUID for this command. |
| `text` | `string` | Command text to relay to the conductor. |
| `source` | `string` | Originating source identifier (e.g. `"dashboard"`, `"cli"`). |
| `replyTo` | `string?` | Optional reply address for responses. |
| `createdAt` | `string` | ISO timestamp when the command was queued. |
| `status` | `'pending' \| 'delivered' \| 'failed'` | Relay status. |
| `error` | `string?` | Error message if `status` is `'failed'`. |

### `DetachReason`

String union used in `requestDetach`, `adapterExited`, and `forceDetach` to record why an attachment ended.

| Value | Description |
|-------|-------------|
| `'user-stop'` | User-initiated graceful stop (`claude-tempo stop`). |
| `'restart'` | Adapter is being replaced by a new attachment (e.g. `restart` operation). |
| `'heartbeat-timeout'` | Adapter missed 3+ consecutive heartbeats; workflow forced detach. |
| `'superseded'` | Another adapter claimed the attachment (multi-host migration). |
| `'agent-exited'` | Adapter's underlying agent subprocess died (e.g. Ctrl+C on terminal). |
| `'spawn-failed'` | Spawn activity for a new attachment failed; workflow self-heals to `detached`. |
| `'destroy'` | Session permanently destroyed via the `destroy` update. |
| `'force'` | Main loop fired `drainingDeadline` — adapter sent `requestDetach` but never sent `adapterExited` within the grace period. Implementation extension; may merge with `'heartbeat-timeout'` in a future cleanup. |
