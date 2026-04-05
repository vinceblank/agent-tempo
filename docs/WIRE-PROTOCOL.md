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

---

## Session Signals

Signals sent **to** a `claudeSessionWorkflow` instance.

| Signal Name | Payload | Description |
|-------------|---------|-------------|
| `receiveMessage` | `{ from: string; text: string; isMaestro?: boolean }` | Delivers an inbound message from another player (or Maestro) into the session's inbox. The session's poller consumes pending messages and forwards them to Claude. |
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

---

## Conductor Query

| Query Name | Return Type | Description |
|------------|-------------|-------------|
| `history` | `HistoryEntry[]` | Returns the conductor's combined command + report history, sorted chronologically. Each entry has a `type` (`'command'` or `'report'`) and a `timestamp`. |
| `qualityGates` | `QualityGate[]` | Returns all quality gates. Each gate has a `task` key, `criteria` array, `createdBy`, `createdAt`, and a derived `status` (`'open'`, `'passed'`, or `'failed'`). |
| `worktrees` | `WorktreeEntry[]` | Returns all active worktree assignments. Each entry has `player`, `path`, `branch`, `gitRoot`, `createdAt`, and `createdBy`. |

---

## Scheduler Signals

Signals sent **to** a `claudeSchedulerWorkflow` instance.

| Signal Name | Payload | Description |
|-------------|---------|-------------|
| `addSchedule` | `ScheduleEntry` | Registers a new named schedule. If a schedule with the same name already exists it is replaced. `ScheduleEntry.type` is `'once'`, `'interval'`, or `'cron'`. Cron schedules include `cronExpression` and optional `timezone`. |
| `removeSchedule` | `string` (schedule name) | Cancels and removes a named schedule. No-op if the name is not found. |

---

## Scheduler Queries

| Query Name | Input | Return Type | Description |
|------------|-------|-------------|-------------|
| `getSchedules` | — | `ScheduleEntry[]` | Returns all currently registered schedules. |
| `getSchedule` | `string` (schedule name) | `ScheduleEntry \| null` | Returns a single schedule by name, or `null` if not found. |

---

## Search Attributes

The following custom Temporal search attributes are written by `claudeSessionWorkflow` and used for session discovery.

| Attribute | Type | Description |
|-----------|------|-------------|
| `ClaudeTempoEnsemble` | `Keyword` | Ensemble namespace (from `CLAUDE_TEMPO_ENSEMBLE` env var). Scopes sessions to a named group. |
| `ClaudeTempoPlayerId` | `Keyword` | Human-readable player name (or hex ID before `set_name` is called). |
| `ClaudeTempoHostname` | `Keyword` | Hostname of the machine running the session. Used to route spawn activities to the correct per-host task queue. |
| `ClaudeTempoStatus` | `Keyword` | Session lifecycle state: `pending` → `active` → `stale` \| `terminated`. |
| `ClaudeTempoGitRoot` | `Keyword` | Absolute path to the git repository root on the session's host. |
| `ClaudeTempoPlayerType` | `Keyword` | Agent type name (e.g. `tempo-soloist`), set from the player's agent definition. |

---

## Type Reference

Types referenced above are defined in `src/types.ts` and re-exported from `src/workflows/signals.ts` and `src/workflows/scheduler-signals.ts`. Consult those files for the full field shapes.

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

### `RecruitOutboxEntry` (selected fields)

| Field | Type | Description |
|-------|------|-------------|
| `allowedTools` | `string[]?` | Tool restrictions from the agent type's `allowedTools` frontmatter. When present, passed to the Claude Code session via `--allowedTools`. Omitted when no restriction applies. |
