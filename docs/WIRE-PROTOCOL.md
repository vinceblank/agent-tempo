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
| `updateMetadata` | `{ hostname?, gitBranch?, gitRoot?, status?, terminatedBy?, enableStaleDetection?, playerType?, playerTypeDescription?, worktreePath?, claudeSessionId? }` | Updates session metadata fields and syncs search attributes. Setting `status: 'terminated'` triggers graceful shutdown; `enableStaleDetection: true` re-arms stale detection after reconnect; `worktreePath` records the git worktree path when the session uses worktree isolation; `claudeSessionId` stores the Claude Code session UUID for deterministic `--resume` on encore. |

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

---

## Session Updates

Workflow updates on a `claudeSessionWorkflow` instance (transactional, returns a value).

| Update Name | Input | Return | Description |
|-------------|-------|--------|-------------|
| `submitOutbox` | `OutboxEntryInput` | `string` (entry ID) | Appends an outbox entry (cue, report, stop, recruit, or encore) to the session's outbox queue and returns its generated UUID. The workflow's dispatch loop processes entries asynchronously via activities. This is the sole write path for all outbound operations. **Encore entries** (`type: 'encore'`) re-engage a player in a new session context; fields: `targetPlayerId: string`, `targetHostname?: string`, `contextMessageCount?: number`. |
| `checkAndSetStatus` | `{ expectedStatus: string; newStatus: string }` | `boolean` | Atomically transitions the session's status from `expectedStatus` to `newStatus`. Returns `true` on success, `false` if the current status did not match `expectedStatus`. Used internally to guard state transitions (e.g., prevent double-encore, validate active/stale preconditions). |

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

---

## Per-Ensemble Maestro Queries

Queries on a `claudeMaestroWorkflow` instance (synchronous, read-only).

| Query Name | Input | Return Type | Description |
|------------|-------|-------------|-------------|
| `maestroPlayers` | — | `MaestroPlayerInfo[]` | Current snapshot of all players in the ensemble, refreshed periodically. |
| `maestroEvents` | — | `MaestroEvent[]` | Ring buffer of recent ensemble events (max 200). Events are generated by diffing consecutive player snapshots. |
| `maestroPendingCommands` | — | `MaestroPendingCommand[]` | Commands queued via `maestroSendCommand` that have not yet been relayed to the conductor. |
| `maestroEnsembleChat` | `EnsembleChatQuery` | `EnsembleChatResult` | Paginated aggregated chat feed from cached state. Merges maestro session + conductor traffic (deduplicated). Cache refreshed every ~10s alongside the player snapshot; cap at 500 entries. `EnsembleChatQuery`: `{ offset?: number; limit?: number }` (default 0, 50; max limit 200). `EnsembleChatResult` includes `messages`, `total`, `hasMore`, and `hasConductor`. Additive — non-breaking. |

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
| `maestroNotifyMessage` | `MaestroRelayMessage` | Push-notify the global Maestro of a relayed message. Used for Phase 2 push-based dashboard updates. |

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
| `ClaudeTempoStatus` | `Keyword` | Session lifecycle state: `pending` → `active` → `stale` \| `blocked` \| `terminated`. `blocked` means the session is alive (delivering messages) but has produced no outbound activity for 5+ minutes — it may be stuck or spinning. Auto-recovers to `active` on next outbound. |
| `ClaudeTempoGitRoot` | `Keyword` | Absolute path to the git repository root on the session's host. |
| `ClaudeTempoPlayerType` | `Keyword` | Agent type name (e.g. `tempo-soloist`), set from the player's agent definition. |

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
