# Wire Protocol Reference

This document is the authoritative reference for all Temporal signal, query, update, and workflow names used by agent-tempo. These names form the wire protocol between sessions — they appear in Temporal history and are referenced across workflow versions.

## Stability Guarantee

> **These names are stable as of v1.0.** Renaming or removing any signal, query, update, or workflow name is a breaking change requiring a major version bump. Adding new names is non-breaking.
>
> **Adding a new `## Section` to this file** also requires a matching entry in the `SECTION_TO_KIND` map in `test/wire-protocol.test.ts` — the drift detector throws on unknown section headers.

> **T1.1 cue doorbell (PRs #776/#783/#803, Refs #747)**: This feature adds **zero** Temporal signals, queries, or updates to this protocol. The doorbell is a content-free latency hint delivered over the daemon HTTP plane only — ring-on-cue-delivery, in-process, ephemeral, at-most-once. Nothing in this document changes. The absence is documented explicitly per the design mandate (`docs/design/t11-cue-doorbell.md` §1: "No payload. No persistence, no replay. No new acks, no new workflow state."). See `docs/INNER-LOOP-PROTOCOL.md` §Doorbell for the HTTP route reference.

---

## Workflow Names

| Name | Description |
|------|-------------|
| `agentSessionWorkflow` | The main workflow for a player session. One instance per active Claude Code session. Carries all message state, outbox entries, and conductor history across `continueAsNew` boundaries. |
| `agentSchedulerWorkflow` | Durable scheduler workflow — one per ensemble. Manages named one-shot and recurring schedules, firing them by signalling the target session at the configured time. |
| `agentMaestroWorkflow` | Per-ensemble management hub — one per ensemble. Workflow ID pattern: `agent-maestro-{ensemble}`. Aggregates a snapshot of all players, maintains a ring-buffer event log (max 200 entries), and queues commands for relay to the conductor. Survives restarts via `continueAsNew`. |
| `agentGlobalMaestroWorkflow` | Global ensemble hub — single instance spanning ALL ensembles. Workflow ID: `agent-maestro-global`. Aggregates players by ensemble, maintains a cross-ensemble message ring buffer (max 500 entries), and exposes on-demand player/conductor history via updates. Survives restarts via `continueAsNew`. |

---

## Session Signals

Signals sent **to** a `agentSessionWorkflow` instance.

| Signal Name | Payload | Description |
|-------------|---------|-------------|
| `receiveMessage` | `{ from: string; text: string; isMaestro?: boolean; isScheduled?: boolean; scheduleName?: string; responseRequested?: boolean; broadcastId?: string; attachmentTicket?: string; deliveryId?: string }` | Delivers an inbound message from another player (or Maestro) into the session's inbox. The session's poller consumes pending messages and forwards them to Claude. `isScheduled: true` and `scheduleName` are set when the message was fired by the scheduler workflow — useful for dashboard integrations that want to distinguish scheduled messages from direct cues. `responseRequested: false` marks informational messages (broadcasts, schedule-fires, heartbeats, system notifications) that should not trigger blocked detection. Defaults to `true` when omitted, preserving existing behavior for direct cues. `broadcastId` (#357) is the shared id across every fan-out target of one `broadcast` invocation — additive optional field used by the TUI to fold N identical deliveries into one chat row. `attachmentTicket` (#318) is a coat-check ticket id referencing content stashed via `coat_check_put` on per-ensemble Maestro state — the recipient pulls the body via `coat_check_get`. Additive optional, backward-compatible with pre-#318 cues. `deliveryId` (#910) is the originating outbox entry's stable `id`, threaded source→receiver for **at-least-once delivery dedup**: the receiver keeps a bounded FIFO of seen ids (cap 512) and drops a redelivery (a continue-as-new / crash mid-dispatch, or an activity retry after a server-side signal apply). Additive optional — omitted by un-threaded/legacy callers → no dedup. **Bound:** a redelivery delayed beyond the FIFO cap (max in-flight + CAN window) evicts its id and can slip a duplicate through. |
| `recordSentMessage` | `{ to: string; text: string }` | Records an outbound message in the session's sent-message history without triggering any delivery. Used for audit/history continuity. |
| `setPart` | `string` | Updates the player's current "part" — a short description of what the session is working on, visible to other players via `ensemble`. |
| `markDelivered` | `string[]` | Marks one or more messages (by ID) as delivered. Resets stale-detection timer; any delivery proves the session is alive. |
| `setName` | `string` | Updates the player's human-readable ID (`AgentTempoPlayerId` search attribute). Called by the `set_name` MCP tool. |
| `updateMetadata` | `{ hostname?, gitBranch?, gitRoot?, terminatedBy?, enableStaleDetection?, playerType?, playerTypeDescription?, worktreePath?, sessionId? }` | Updates session metadata fields and syncs search attributes. `enableStaleDetection: true` re-arms stale detection after reconnect; `worktreePath` records the git worktree path when the session uses worktree isolation; `sessionId` stores the session UUID — used for Copilot SDK session resumption, Claude Code deterministic `--resume` on restart, and (since #449 Phase C) re-attachment to the persisted OpenCode session id across `opencode serve` restart. Note: the former `status: 'terminated'` shim was retired in PR-H (#132); use the `destroy` update for ordered session teardown. |
| `releaseHeld` | *(none)* | Releases a held session: injects the stored initial message and unlocks the outbox. Sent by the conductor (or operator) after a session has been paused at startup via the hold/pause mechanism. **Idempotent** on sessions that aren't holding (no `heldMessage`, `outboxLocked` already `false`) — safe to blanket-signal across an ensemble. Used by the `release` MCP tool, `agent-tempo release` CLI, and (since #172) by `resume_ensemble { release: true }` / `agent-tempo resume --release` which fan it out to every running session. |
| `setPaused` | `boolean` | Pauses (`true`) or resumes (`false`) the session's outbox dispatch. While paused, queued outbox entries are not processed. |
| `heartbeat` | `{ attachmentId: string; at: string; currentTool?: string \| null; contextTokens?: number; contextPercent?: number }` | **v0.25.** Liveness proof from the attached adapter — renews the lease's `expiresAt` to `workflow.now() + LEASE_MS`. Ignored (last-write-wins) if `attachmentId` doesn't match the current attachment. Adapters beat at 30 s (SDK) or 60 s (interactive). **3c (additive, optional, non-breaking):** the heartbeat doubles as the Tier-1 coarse-activity piggyback — `currentTool` (`null` = idle), `contextTokens`, and `contextPercent` refresh the workflow's `getCoarseActivity` state field-wise. Senders that don't report coarse omit them. |
| `requestDetach` | `{ reason: DetachReason; deadlineMs: number }` | **v0.25.** Adapter-, conductor-, or operator-initiated graceful detach. Transitions phase → `'draining'`; the main loop reaps to `'detached'` when the outbox is drained OR after `drainingDeadline` (default 5 s). Idempotent on `'draining'`/`'detached'`. |
| `adapterExited` | `{ attachmentId: string; reason: DetachReason }` | **v0.25.** Adapter's final signal before process exit — collapses `'draining' → 'detached'` immediately if `attachmentId` matches. Ignored on `'detached'`/`'gone'`. |
| `testForceContinueAsNew` | *(none)* | **Test-only (#226).** Forces the session workflow's main loop to take the `continueAsNew` branch on its next iteration, independent of `workflowInfo().continueAsNewSuggested`. Exists solely so adapter-reconnect tests can exercise the CAN-boundary rebind path without emitting ~10k filler events to hit the server's native CAN threshold. Production senders do not exist; no tool or CLI emits this signal. One-shot — the workflow clears its internal flag when it acts on the signal. |
| `setPendingReset` | `{ resetId: string; fresh: boolean; reason?: string; requestedBy?: string }` | **D14.** Sets a pending context-reset flag the Pi extension reads via the combined `pendingIntake` query (`.pendingReset`). Single-slot, latest-wins; the workflow stamps `requestedAt` deterministically (`workflow.now()`). Sent by the `deliverReset` outbox activity (enqueued by the `reset` tool). The flag is carried across `continueAsNew` until acked. |
| `ackReset` | `string` (resetId) | **D14.** Clears the pending reset AFTER the Pi extension performs the clean-wipe (`newSession`) — but ONLY if the id matches the current pending reset, so a newer reset landing during the wipe is not silently dropped. |

---

## Session Queries

Queries on a `agentSessionWorkflow` instance (synchronous, read-only).

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
| `orphanSummary` | `OrphanSummary` | **v0.25.** Returns metadata about a detached orphan — `{ ensemble, playerId, detachedSince?, reason?, preferredHost?, lastAdapter? }`. The daemon uses this at reconcile-on-boot to decide whether to auto-restore per `restorePolicy`. The `ensemble` and `playerId` fields carry the workflow's canonical metadata identity (v0.26-beta.3: added per #143/#145 so consumers read these directly instead of regex-parsing the workflow id, which loses dashes from player names like `tempo-eng`). |
| `getRunId` | `string` | **#399 W2.** Returns the workflow's `workflowInfo().runId`. Dashboard truncates to `XXXX·XXXX` (first 4 + last 4 + middle dot) client-side; this query stays a thin pass-through. |
| `getMessagingState` | `{ received: number; sent: number; outbox: string }` | **#399 W2.** Returns inbound + outbound + outbox-summary counters. `received` increments per inbound `receiveMessage` cue; `sent` increments per `submitOutbox` (every entry the session pushes). `outbox` is a server-side reduce: `"empty"` / `"N pending"` / `"N pending (oldest 2m)"` once the oldest pending entry exceeds the 30s stale threshold. All counters are monotonic across `continueAsNew`. |
| `getActivityState` | `{ activityCount: number; lastActivityAt: string }` | **#399 W2.** Returns activity-counter + ISO timestamp of the most recent "work" event (cue / outbox push / schedule fire / report / recruit / restart / destroy / migrate — heartbeats and lifecycle plumbing don't bump). Critical-path for the per-ensemble maestro's tempo bucket projection (W1 fan-queries this from each session). Monotonic across `continueAsNew`. |
| `getLeaseState` | `{ expiresAt: number \| null; leaseMs: number \| null }` | **#399 W2.** Returns the current attachment's expiry (epoch ms) + lease window (ms), or `{ expiresAt: null, leaseMs: null }` when no active lease (phase ∈ `booting` / `detached` / `gone`). The dashboard formats `"expires in 54s"` / `"expired"` client-side. |
| `getCoarseActivity` | `{ currentTool: string \| null; contextTokens?: number; contextPercent?: number }` | **3c Tier-1.** Returns the player's coarse activity — the tool it's currently executing (`null` = idle/between tools) plus context-token usage from Pi's `getContextUsage` (pull-only; absent right after compaction). Refreshed by the `heartbeat` piggyback; read by the snapshot fan-out (`getPlayerWireMeta`) → projected onto `PlayerSummaryV1` → the aggregate poll/diff emits the `player.activity` SSE event. Volatile/live state — NOT carried across `continueAsNew` (reports `{ currentTool: null }` after a fresh run until the next heartbeat). |
| `playerState` | `PlayerStateEntry \| null` | **#334.** Returns the named player-saveable-state slot (`{ content, savedAt, savedBy }`), or `null` when the slot is empty. Input: `{ key?: string }` — defaults to `'main'`. Peer-readable: any player in the ensemble may query any other player's slots (audit identity recorded on each entry's `savedBy`). Continues to serve queries against completed workflows (last-known state from history) — useful for post-mortem inspection after `destroy`. Carried across `continueAsNew`. |
| `playerStateKeys` | `string[]` | **#334.** Returns the names of every populated player-saveable-state slot, sorted alphabetically. Empty array when no slots are saved. Operator/debugging surface only — reachable via `temporal workflow query <id> playerStateKeys`. ADR 0011 §Alternatives explicitly rejected exposing slot enumeration through the MCP tool surface (would force a polymorphic return on `fetch_state`); a dedicated `list_state` MCP tool can graduate in v2 if telemetry shows demand. |
| `pendingIntake` | `{ messages: Message[]; pendingReset: PendingReset \| null }` | **T0.3 of #747 (#750).** Combined intake for the Pi cue pump, served in ONE billable query per pump tick (was 2): `messages` is identical to `pendingMessages` (undelivered only) plus the single-slot pending reset. Acks unchanged: `markDelivered` / `ackReset` (same race-safe id-match semantics). **2.0 (#788):** the standalone `pendingReset` query was removed — the reset now rides this query's `pendingReset` field; the pre-#750 two-query fallback is gone (the A2 cutover guarantees every 2.0 workflow serves this handler). `pendingMessages` stays — the primary intake for every non-Pi adapter. |

---

## Session Updates

Workflow updates on a `agentSessionWorkflow` instance (transactional, returns a value).

| Update Name | Input | Return | Description |
|-------------|-------|--------|-------------|
| `submitOutbox` | `OutboxEntryInput` | `string` (entry ID) | Appends an outbox entry (cue, report, stop, recruit, release, spawn) to the session's outbox queue and returns its generated UUID. The workflow's dispatch loop processes entries asynchronously via activities. This is the sole write path for all outbound operations. **Spawn entries** (`type: 'spawn'`) are enqueued via `enqueueSpawn` (PR-D) to launch an adapter that picks up a pre-claimed attachment — their 5 attachment-specific fields (`attachmentId`, `attachmentRunId`, `resumeAttachment`, `sessionId?`, `adapterId`) are forwarded to the per-host `spawnProcess` activity. |
| `processingStart` | `{ messageId: string; expectedAttachmentId?: string }` | `{ inFlightCount: number }` | Marks `messageId` as being actively processed by a blocking adapter (e.g. Copilot-bridge's `sendAndWait`). While any messageId is in-flight, stale detection is suppressed and the phase refines to `'processing'` — fixes #99. `messageId` is required for idempotency under at-least-once update retries. `expectedAttachmentId` is optional in v0.25 for shim compatibility; when provided, the update is rejected with `AttachmentMismatch` if it doesn't match the current attachment. Validator rejects destroyed sessions with `WorkflowGone`. A 15-minute `processingDeadline` in the main loop ejects wedged entries. |
| `processingEnd` | `{ messageId: string; expectedAttachmentId?: string }` | `{ inFlightCount: number }` | Marks `messageId` as done. Once the in-flight set empties, phase returns to `'attached'`. Callers should run this in a `try/finally` around the blocking call. `expectedAttachmentId` semantics match `processingStart`. |
| `destroy` | `{ reason?: string; terminatedBy?: string }` | *(void)* | **v0.25: terminal.** Sets phase = `'gone'`, revokes `currentAttachment`, records abandoned outbox entry IDs to workflow history (via `workflow.log.warn`), pushes a final system message, and exits the main loop → workflow COMPLETES. Per design §2.5, `destroy` does **not** wait to drain the outbox — delivery of entries pending at destroy time is best-effort and may be abandoned. **As of #164**, the handler is `async` and invokes `hardTerminateAttachment` on the session's per-host task queue *before* the state flip to prevent an orphaned `claude.exe` when destroy is called while attached; that kill is **best-effort** (failure is logged and the workflow still completes — unlike `forceDetach`, destroy must not wedge when the host worker is unreachable). Adapters (e.g. Copilot bridge's `recreateSession()`) must query `isDestroyed` before attempting reconnect; a destroyed workflow must not be resurrected as a zombie. Idempotent on already-`gone`. |
| `claimAttachment` | `{ host, adapterId, adapterClass, leaseMs, protocolVersion, expectedAttachmentId?, sessionId? }` | `AttachmentToken` or `ApplicationFailure` | **v0.25.** Transactional claim or renewal of the attachment lease. Renewal when `expectedAttachmentId` matches an unexpired current attachment → extends `expiresAt`. Conflict when a different live attachment exists → `AttachmentConflict`. Fresh claim otherwise → new `Attachment` with `runId` pinned to the current workflow execution; phase → `'attached'`; in-flight set cleared. Rejects on `gone` with `WorkflowGone`. `leaseMs` validated in range 1000–600000. **`protocolVersion` (REQUIRED, #786 / 2.0):** the adapter's `PROTOCOL_VERSION`. The 2.0 workflow rejects any value `!== PROTOCOL_VERSION` (incl. `undefined` = a v1 adapter) in the update VALIDATOR — pre-admission, no history event — with a `ProtocolMismatch` `ApplicationFailure` naming the host + upgrade fix. Cross-host cutover safety: a stale 1.x adapter cannot claim a 2.0 workflow. **`sessionId` (OPTIONAL, #897):** the claiming adapter's own spawn `sessionId` (`AGENT_TEMPO_SESSION_ID`). The validator rejects with `SessionIdMismatch` ONLY when both it AND the workflow's current `metadata.sessionId` are present and differ — a stale orphan adapter whose run was superseded. Absent on either side → allowed (legacy adapters; fresh claims before `metadata.sessionId` is set). |
| `forceDetach` | `{ reason: DetachReason; expectedAttachmentId?; gracePeriodMs: number }` | `{ reaped: boolean; previousAttachmentId? }` | **v0.25.** Revoke the current attachment. Returns `{ reaped: true, previousAttachmentId }` when a live attachment was revoked; `{ reaped: false }` when already detached (idempotent). `expectedAttachmentId` guards against TOCTOU. `gracePeriodMs` is reserved for future use — PR-A always detaches immediately. |
| `enqueueSpawn` | `{ host, attachmentId, runId, resume, sessionId?, adapterId, agentDefinition?, agentDefinitionPath?, nativeResolvable?, model? }` | `{ spawnEntryId: string }` | **v0.25.** Queue a spawn outbox entry carrying the claim token. Used by `restart` (PR-D) to route a fresh-adapter spawn to a per-host task queue after `claimAttachment`. The three `agent*` fields (added in #184, non-breaking additive) carry the resolved player-type so restart-triggered spawns pick `--agent <name>` or `--system-prompt <path>` the same way recruit does. `model?` (added in #131 Phase C, non-breaking additive) carries the claude-api model id across restart/encore/migrate so the restarted subprocess runs the same model the original recruit chose. |
| `setPreferredHost` | `{ host: string }` | *(void)* | **v0.25.** Record a preferred host for daemon reconcile-on-boot (PR-E). |
| `savePlayerState` | `{ key: string; content: string; savedBy: string }` | `{ saved: true; savedAt: string }` | **#334.** Write a curated artifact into one of the calling player's saveable-state slots. Validator (pre-handler) rejects invalid key (`PlayerStateInvalidKey`), oversized content > 32 KiB (`PlayerStateContentTooLarge`), or a new key when 4 slots are full (`PlayerStateSlotsFull` — error message lists existing slot names so the LLM can pick which to clear). On success writes `{ content, savedAt: workflow.now().toISOString(), savedBy }` to `playerState[key]`. Carried across `continueAsNew`. Owner-only by structure (the `save_state` MCP tool always wires the calling player's own session-workflow handle — no `playerId` arg). See `PlayerStateEntry` below. |
| `clearPlayerState` | `{ key: string }` | `{ cleared: boolean }` | **#334.** Remove a saved-state slot. Returns `{ cleared: true }` when the slot existed, `{ cleared: false }` when it was already empty (idempotent). Validator rejects invalid keys with `PlayerStateInvalidKey`. Owner-only by structure (no `playerId` arg). |

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
| `playerReport` | `{ playerId: string; text: string; type: 'result' \| 'blocker' \| 'question'; deliveryId?: string }` | Delivers a report from a player to the conductor. Appended to `reportHistory` and injected into the conductor's inbox. `deliveryId` (#910) is the originating outbox entry id, threaded for **at-least-once delivery dedup** on the conductor receiver (same bounded-FIFO mechanism as `receiveMessage`). Additive optional — omitted by legacy callers → no dedup. |
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

Signals sent **to** a `agentSchedulerWorkflow` instance.

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

Signal sent **to** a `agentMaestroWorkflow` instance.

| Signal Name | Payload | Description |
|-------------|---------|-------------|
| `maestroShutdown` | *(none)* | Gracefully shuts down the per-ensemble Maestro workflow. |
| `maestroSetPaused` | `boolean` | Sets the ensemble-wide pause state (`true` = paused, `false` = resumed). Acts as ground truth for pause state — sessions and the scheduler sync from this. |
| `setEnsembleDescription` | `string` | **#399 W1 (Q5.1).** Updates the ensemble's mission-flavor description string surfaced on the dashboard EnsembleCard. Soft cap 100 chars (clamped server-side); MCP tool boundary rejects oversized inputs. Empty string clears the description. Carried across CAN. |

---

## Per-Ensemble Maestro Queries

Queries on a `agentMaestroWorkflow` instance (synchronous, read-only).

| Query Name | Input | Return Type | Description |
|------------|-------|-------------|-------------|
| `maestroPlayers` | — | `MaestroPlayerInfo[]` | Current snapshot of all players in the ensemble, refreshed periodically. |
| `maestroEvents` | — | `MaestroEvent[]` | Ring buffer of recent ensemble events (max 200). Events are generated by diffing consecutive player snapshots. |
| `maestroPendingCommands` | — | `MaestroPendingCommand[]` | Commands queued via `maestroSendCommand` that have not yet been relayed to the conductor. |
| `maestroEnsembleChat` | `EnsembleChatQuery` | `EnsembleChatResult` | Paginated aggregated chat feed from cached state. Merges maestro session + conductor traffic (deduplicated). Cache refreshed every ~10s alongside the player snapshot; cap at 500 entries. `EnsembleChatQuery`: `{ offset?: number; limit?: number }` (default 0, 50; max limit 200). `EnsembleChatResult` includes `messages`, `total`, `hasMore`, and `hasConductor`. Additive — non-breaking. |
| `maestroPaused` | — | `boolean` | Returns `true` if the ensemble is currently in a paused state as set by `maestroSetPaused`. |
| `getEnsembleDescription` | — | `string` | **#399 W1 (Q5.1).** Current ensemble description (mission-flavor text). Empty string when none set. Updated via the `setEnsembleDescription` signal; carried across CAN. |
| `getEnsembleStartTime` | — | `string` (ISO8601) | **#399 W1 (Q5.3a).** ISO timestamp of the maestro's *first-ever* start (`workflowInfo().startTime` on the original execution; preserved across CAN via `MaestroInput.startTimeIso`). Dashboard derives ensemble uptime client-side. |
| `getCurrentBpm` | — | `number` | **#399 W1 (Q5.6 Flavor B).** Current ensemble BPM — sum of activity in the most recent ~60 seconds (the in-progress 30 s bucket plus the two prior finished buckets). Returns `0` when no buckets have accumulated. |
| `getTempoSeries` | — | `number[]` | **#399 W1 (Q5.6 Flavor B).** Up to 60 finished 30-second activity buckets (oldest-first). Each entry is the count of player-activity deltas observed during that window. Used by the dashboard's `TempoStrip` sparkline. The in-progress bucket is *not* included; it surfaces only via `getCurrentBpm`. |
| `coatCheckList` | `{ putBy?: string; prefix?: string; unfetchedOnly?: boolean }` | `CoatCheckEntryHeader[]` | **#318 (ADR 0008).** List coat-check entry headers (content body omitted) for this ensemble, sorted newest-first. Read-only — does NOT bump fetch-audit counters on the entries it surveys; only `coatCheckGet` does. Optional filters: `putBy` (audit lens for "what did <player> stash?"), `prefix` (summary-prefix narrow), `unfetchedOnly` (only entries with `fetchCount === 0` — owner cleanup workflow). Expired entries are filtered from the view but their physical sweep happens at the next mutating handler. |
| `maestroGetAnswer` | `questionId: string` | `AnswerEntry \| null` | **#700 P2.** Read a parked Q&A answer by the planner-supplied `questionId`. Returns the entry or `null` (missing / TTL-expired — no error class). Query + TTL (idempotent, reconnect-safe): a reconnecting planner can re-read until TTL. Expired entries are filtered from the view; physical sweep runs in the 5s tick / next post. |

---

## Per-Ensemble Maestro Updates

Workflow updates on a `agentMaestroWorkflow` instance (transactional, returns a value).

| Update Name | Input | Return | Description |
|-------------|-------|--------|-------------|
| `maestroSendCommand` | `{ text: string; source: string; replyTo?: string }` | `string` (command ID) | Enqueues a command for relay to the conductor. Returns the generated command ID. The Maestro workflow relays it to the conductor via the `command` signal. |
| `coatCheckPut` | `{ summary: string; content: string; contentType?: string; ttlMs?: number; putBy: string }` | `{ ticket: string; expiresAt: string; slotsUsed: number; slotsTotal: number }` | **#318 (ADR 0008).** Admit a new coat-check entry on per-ensemble Maestro state. Content cap 32 KiB; summary cap 500 chars; ttl range [1h, 30d] (default 7d). Saturation (20-slot cap) → `CoatCheckSlotsFull` ApplicationFailure with the oldest 3 ticket ids in the message. Oversize → `CoatCheckEntryTooLarge`. `putBy` is the audit identity, set by the MCP tool layer via `getPlayerId()` — there is no `playerId` arg on the tool schema. Carried across CAN only when the entry map is non-empty. |
| `coatCheckGet` | `{ ticket: string; fetchedBy: string }` | `CoatCheckEntry \| null` | **#318 (ADR 0008).** Redeem a coat-check ticket. Returns the full entry (including content body) on hit, or `null` for missing / expired / evicted tickets — no error-class proliferation. Successful hits bump `lastFetchedAt`, `lastFetchedBy`, `fetchCount` on the entry so the putter can later see whether anyone has redeemed. Implemented as an Update (not a Query) because the fetch-audit counters mutate state. `fetchedBy` is the audit identity, set by the tool layer. |
| `coatCheckEvict` | `{ ticket: string; evictedBy: string }` | `{ evicted: boolean }` | **#318 (ADR 0008).** Evict a coat-check entry before its TTL expires. Owner-or-conductor permission gate (`evictedBy === entry.putBy` OR `evictedBy === <ensemble conductor playerId>`); mismatches throw `CoatCheckEvictPermissionDenied`. `evicted: false` when the ticket was missing / expired / already evicted (no throw). `evictedBy` is the audit identity, set by the tool layer. |
| `maestroPostAnswer` | `{ questionId: string; from: string; text: string }` | `{ stored: true }` | **#700 P2.** Park a correlated Q&A answer (player → maestro) for the inbox-less planner, keyed by the planner-supplied `questionId`. Overwriting an existing `questionId` (a retry) reuses its slot. `from` is the audit identity set by the `respond` tool via `getPlayerId()` (no spoofable arg, like coat-check's `putBy`). Caps: text ≤ `MESSAGE_MAX`; 20-slot mailbox (post-sweep) → `MaestroAnswersFull`; invalid input → `MaestroAnswerInvalid*`. TTL 1h (`MAESTRO_ANSWER_TTL_MS`). Carried across CAN only when the map is non-empty. |

---

## Global Maestro Signals

Signals sent **to** a `agentGlobalMaestroWorkflow` instance (`agent-maestro-global`).

| Signal Name | Payload | Description |
|-------------|---------|-------------|
| `maestroNotifyMessage` | `MaestroRelayMessage` | Push-notify the global Maestro of a relayed message. Used for push-based message notifications. |
| `hostProfile` | `Record<string, unknown>` | **#274.** Daemon advertises its capability profile at boot: `hostname` (required), plus optional `version`, `defaultAgent`, `availableAgentTypes`, `availablePlayerTypes`, `claudeBin` (basename only), `platform`, `capabilities`, `httpDegraded` (#768). Open schema — additive fields beyond the documented set are stored opaquely so older maestros survive newer daemons. Handler validates only `hostname` (PLAYER_NAME_REGEX, ≤64 chars). Full typed shape: see `HostProfile` below. |

---

## Global Maestro Queries

Queries on a `agentGlobalMaestroWorkflow` instance (synchronous, read-only).

| Query Name | Return Type | Description |
|------------|-------------|-------------|
| `maestroEnsembles` | `string[]` | All ensemble names currently known to the global Maestro. |
| `maestroPlayersByEnsemble` | `Record<string, MaestroPlayerInfo[]>` | All players grouped by ensemble. Each `MaestroPlayerInfo` includes an `ensemble` field. |
| `maestroRecentMessages` | `MaestroRelayMessage[]` | Ring buffer of recent messages relayed across all ensembles (max 500). |
| `hostProfilesWithExistence` | `{ exists: boolean; profiles: Record<string, HostProfile> }` | **#280.** Single-RPC combined existence + profiles query: map of `hostname → HostProfile` advertised by daemons via the `hostProfile` signal, carried through CAN with the rest of maestro state, joined with Temporal poller liveness by `src/utils/hosts.ts` to produce the consumer-facing `HostInfo[]`. Reaching the handler proves the workflow is running, so `exists` is always `true` on success; transport failure (workflow not found, terminated, unreachable) is caught at the call site and treated as "missing". The explicit `exists` flag preserves room for a future "running but degraded" variant. **2.0 (#788):** the legacy two-call `hostProfiles` query was removed — this is the only host-profiles query. |

---

## Global Maestro Updates

Workflow updates on a `agentGlobalMaestroWorkflow` instance (transactional, returns a value).

| Update Name | Input | Return | Description |
|-------------|-------|--------|-------------|
| `maestroSendMessage` | `{ ensemble: string; to: string; text: string; source: string }` | `string` (message ID) | Send a message to a specific player in a specific ensemble via Maestro relay. Returns the generated message ID. |
| `maestroFetchPlayerMessages` | `{ ensemble: string; playerId: string }` | `Array<Message \| SentMessage>` | On-demand fetch of a player's merged received/sent message history from their session workflow. |
| `maestroFetchConductorHistory` | `{ ensemble: string }` | `{ success: boolean; history: HistoryEntry[]; error?: string }` | On-demand fetch of a conductor's command/report history. Returns soft failure (`success: false`) if no conductor is running. |
| `maestroGlobalSendCommand` | `{ ensemble: string; text: string; source: string; replyTo?: string }` | `string` (command ID) | Queue a command for relay to a specific ensemble's conductor. Ensemble-scoped variant of the per-ensemble `maestroSendCommand`. |

---

## Search Attributes

The following custom Temporal search attributes are written by `agentSessionWorkflow` and used for session discovery.

> **v0.26-beta breaking change** — `AgentTempoStatus` has been removed. Lifecycle truth
> now lives on `AgentTempoAttachmentState` (search attribute) and the `attachmentInfo`
> query. Operators on long-lived Temporal clusters must manually drop the legacy
> attribute — Temporal does not auto-unregister search attributes.
> See [`docs/ops/v0.26-migration.md`](ops/v0.26-migration.md) for the upgrade steps.

> **v1.8 SA diet (#747)** — runs started on v1.8+ stop writing
> `AgentTempoGitRoot`, `AgentTempoPlayerType`, `AgentTempoIsConductor` (migrated to the
> **workflow memo**, same field names, plus the new memo-only `AgentTempoPart`) and
> `AgentTempoAttachmentId` (dropped — zero readers). Fresh namespaces register only the
> 5 filter attributes below. Operators' hand-written visibility queries on the
> deprecated attributes silently match nothing for post-v1.8 runs — read the memo from
> list results (or use TempoClient ≥ v1.8) instead. Existing namespaces keep the legacy
> registrations harmlessly; see [`docs/ops/sa-diet-migration.md`](ops/sa-diet-migration.md).

| Attribute | Type | Description |
|-----------|------|-------------|
| `AgentTempoEnsemble` | `Keyword` | Ensemble namespace (from `AGENT_TEMPO_ENSEMBLE` env var). Scopes sessions to a named group. |
| `AgentTempoPlayerId` | `Keyword` | Human-readable player name (or hex ID before `set_name` is called). |
| `AgentTempoHostname` | `Keyword` | Hostname of the machine running the session. Used to route spawn activities to the correct per-host task queue. |
| `AgentTempoGitRoot` | `Keyword` | **Deprecated (v1.8 SA diet)** — not written by v1.8+ runs; read from the workflow memo instead. Absolute path to the git repository root on the session's host. |
| `AgentTempoPlayerType` | `Keyword` | **Deprecated (v1.8 SA diet)** — not written by v1.8+ runs; read from the workflow memo instead. Agent type name (e.g. `tempo-soloist`), set from the player's agent definition. |
| `AgentTempoIsConductor` | `Bool` | **Deprecated (v1.8 SA diet)** — not written by v1.8+ runs; read from the workflow memo instead. `true` for conductor workflows. (Historical note: no code ever filtered on this attribute — discovery lists by ensemble and post-filters, with a workflowId-suffix fallback.) |
| `AgentTempoAttachmentState` | `Keyword` | **v0.25.** Current attachment phase: `booting \| attached \| processing \| awaiting \| draining \| detached \| gone`. Enables external observers (TUI, monitoring, daemon reconcile-on-boot) to query session readiness without polling the `attachmentInfo` query. |
| `AgentTempoAttachedHost` | `Keyword` | **v0.25.** Hostname of the machine currently holding the attachment lease. Empty string when no attachment is active (`detached` / `gone` phases). Used by daemon reconcile-on-boot to identify orphaned sessions whose adapter process may have died on this host. |
| `AgentTempoAttachmentId` | `Keyword` | **Deprecated (v1.8 SA diet)** — not written by v1.8+ runs, no replacement (zero readers existed; adapters correlate via the `claimAttachment` token). Was: UUID of the current attachment. |

### Workflow memo (v1.8+)

Low-churn read-only metadata rides the **workflow memo** (returned in the same
`client.workflow.list()` results; no search-attribute cap cost). Seeded via
`client.workflow.start({ memo })` and kept current by the workflow
(`upsertMemo`, gated behind `patched('v1.8-sa-diet')`). Memo keys are part of
the wire surface — renaming or removing one is a breaking change:

| Memo key | Type | Description |
|----------|------|-------------|
| `AgentTempoGitRoot` | `string` | Replaces the deprecated search attribute. |
| `AgentTempoPlayerType` | `string` | Replaces the deprecated search attribute. |
| `AgentTempoIsConductor` | `boolean` | Replaces the deprecated search attribute. |
| `AgentTempoPart` | `string` | **New in v1.8.** The player's current part (work description), mirrored from the `setPart` signal so observers can read it from list results without a per-player `getPart` query (T0.1, #748). |
| `AgentTempoWorkDir` | `string` | **New in v1.8 (T0.1, #748 — `v1.8-memo-observation-fields`).** Session working directory; set at start, immutable in practice. Lets the cloud-profile maestro scan build the full player row from list results. |
| `AgentTempoAgentType` | `string` | **New in v1.8 (T0.1, #748).** Adapter family (`claude`, `pi`, `copilot`, …); set at start. |
| `AgentTempoGitBranch` | `string` | **New in v1.8 (T0.1, #748).** Current git branch; refreshed by the (rare) `updateMetadata` signal — may lag a local branch switch until the next metadata update (observation-grade, by design). |
| `AgentTempoProtocol` | `number` | **New in 2.0 (#786 — the cutover stamp).** Set to `PROTOCOL_VERSION` (`2`). Upserted **early + unconditionally on every run** of all four workflows (session, per-ensemble maestro, global maestro, scheduler) — NOT gated behind `patched()`, and re-upserted across `continueAsNew` — so visibility always shows the stamp. The daemon boot guard reads it straight off `client.workflow.list()` results and **refuses to boot** if any Running agent-tempo workflow lacks it (`!== PROTOCOL_VERSION`, incl. `undefined` = a pre-cutover 1.x run a 2.0 worker cannot safely replay). Memo, not a search attribute: avoids a 6th Keyword (the SA diet keeps us at 5/10) and needs no operator registration. |
| `AgentTempoCloseReason` | `string` | **New in 2.0 (#704).** Typed terminal close-reason stamped on a session workflow's memo just before it COMPLETEs: `'destroyed'` (the `destroy` path) or `'boot-timeout'` (the booting attach-timeout watchdog). Survives completion and is read via `describe().memo` by the bootstrap **orphan-guard** (`server.ts`), which self-exits a late-launching orphan process whose run was cancelled — discriminated (since #897) by the running-run × close-reason × `AgentTempoSessionId`-match TRIPLE. Only written on those two terminal paths (absent for live runs and clean adapter-exit completions). Memo, not a search attribute: needs no operator registration and is read only at bootstrap. |
| `AgentTempoSessionId` | `string` | **New in 2.0 (#897).** The session's spawn `sessionId`, co-stamped on the close memo alongside `AgentTempoCloseReason` (the `destroy` + `boot-timeout` paths). The bootstrap **orphan-guard** (`server.ts`) compares it against the booting process's own `AGENT_TEMPO_SESSION_ID` to self-exit a late orphan by EXACT identity — replacing the #704 wall-clock TTL. A legit re-recruit carries a fresh sessionId → never matches; the true orphan carries its closed run's sessionId → exits precisely. Absent for runs closed before #897 and for spawns that don't forward the env (guard conservatively does not self-exit then). Memo, not a search attribute: read only at bootstrap, no operator registration. |

Readers go through the dual-read helpers in `src/utils/search-attributes.ts`
(memo preferred, legacy SA fallback for pre-v1.8 runs); the fallback may be
removed at the next major.

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
| `players[].reconciled` | `boolean?` | #777: `true` when the player's status was applied by stage-creation reconciliation — their report arrived BEFORE the stage existed (buffered-signal drain order or plain arrival order) and was counted at creation; `reportedAt` keeps the report's original receipt time. Additive optional field — pre-#777 readers ignore it transparently (broadcastId precedent). |
| `status` | `'active' \| 'complete' \| 'failed' \| 'cancelled'` | Aggregate status. `complete` when all players report results; `failed` when a blocker is received and `failurePolicy` is `'halt'`. |
| `failurePolicy` | `'halt' \| 'continue'` | What happens when a player reports a blocker. `halt` fails the stage immediately; `continue` marks the player as blocked but keeps the stage active. |
| `createdAt` | `string` | ISO timestamp of stage creation. |
| `createdBy` | `string` | Player ID of the conductor that created the stage. |
| `completedAt` | `string?` | ISO timestamp of completion, failure, or cancellation. |

### `HostProfile` (#274)

Advertised by daemons via the `hostProfile` signal. **Open schema** — consumers MUST NOT rely on specific keys beyond `hostname` without a per-field guard.

| Field | Type | Description |
|-------|------|-------------|
| `hostname` | `string` | **Required.** Validated against `PLAYER_NAME_REGEX` (≤64 chars). |
| `version` | `string?` | Daemon package version string (e.g. `"0.26.0-beta.7"`). |
| `defaultAgent` | `'claude' \| 'copilot'` *(optional)* | Default agent type used for recruits omitting `--agent`. |
| `availableAgentTypes` | `string[]?` | Agent type **names** only (no file paths — privacy scrub). |
| `availablePlayerTypes` | `string[]?` | Player type names the daemon can resolve via project/user/shipped tiers. |
| `claudeBin` | `string?` | Basename only (e.g. `"claude"`). **Never** absolute — privacy scrub. |
| `platform` | `NodeJS.Platform?` | Reported from `process.platform`. |
| `capabilities` | `string[]?` | Free-form capability flags (future extension). |
| `httpDegraded` | `boolean?` | **#768.** `true` while the daemon serves no HTTP because its port bind failed (Temporal workers stay up; the bind retries with capped backoff). Re-advertised on transitions only: `true` entering the degraded state, `false` on bind recovery. Absent on healthy boots and pre-#768 daemons — consumers MUST treat absent as "not known degraded", not "healthy". |
| `daemonStartedAt` | `number?` | Daemon process start time (epoch ms, captured at module load). Resets on every daemon restart; semantics are **daemon-process uptime**, not host-first-seen. Issue #399 Q5.3b. |
| `adapterVersions` | `Record<string, string>?` | Adapter name → upstream tool version (e.g. `{ "claude-code": "1.2.4", "copilot": "0.5.2" }`). Probed once at daemon boot in parallel with the global-maestro ensure; adapters whose probe fails or output can't be parsed are omitted. Issue #399 Q5.4. |
| `[extraField]` | `unknown` | Additive open-schema escape hatch for forward compatibility. |

Privacy contract: daemons MUST scrub absolute paths, env values, and user directories before signaling. See `src/daemon.ts` `scrubHostProfile` + `test/daemon-boot.test.ts` scrub invariant. (`daemonStartedAt` and `adapterVersions` carry no path / env data; they pass through the scrub unchanged.)

### `PlayerStateEntry` (#334)

Single slot of player-saveable state. Returned by `playerState` query, written by `savePlayerState` update.

| Field | Type | Description |
|-------|------|-------------|
| `content` | `string` | Opaque artifact (markdown encouraged via tool docstring nudge, not enforced). Max 32 KiB UTF-8 per slot — validator rejects with `PlayerStateContentTooLarge`. |
| `savedAt` | `string` | ISO 8601 timestamp from `workflow.now()` at write time. |
| `savedBy` | `string` | Player id that wrote the slot — audit identity for peer reads. |

Limits (enforced by `savePlayerState` validator and the `save_state` Zod schema):

- Max key length: 32 chars; key regex: `/^[a-zA-Z0-9_-]+$/` (alphanumeric, underscore, hyphen).
- Max content size: 32 KiB UTF-8 per slot.
- Max populated slots per player: 4. Saving a 5th distinct key rejects with `PlayerStateSlotsFull` and lists existing slot names — caller must `clear_state` to free a slot. **No LRU eviction** — explicit clear required (Anthropic harness-design blog: explicit eviction reinforces authorial discipline).
- Default slot key when omitted: `'main'`.

### `CoatCheckEntry` (#318)

Single coat-check entry as stored on per-ensemble Maestro state. Returned by `coatCheckGet` (or `null` for missing/expired/evicted tickets).

| Field | Type | Description |
|-------|------|-------------|
| `summary` | `string` | Short preamble (≤500 chars). Surfaced in `coatCheckList`. |
| `content` | `string` | Opaque body (≤32 KiB UTF-8). Returned only by `coatCheckGet`, never on the listing projection. |
| `contentType` | `string?` | Optional free-form MIME-shaped hint (≤64 chars), e.g. `"text/markdown"`. |
| `putBy` | `string` | Player id of the stasher — audit identity. Cannot be spoofed: set by the MCP tool layer via `getPlayerId()`, no caller-supplied arg. |
| `putAt` | `string` | ISO 8601 timestamp from `workflowNow()` at put time. |
| `expiresAt` | `string` | ISO 8601 timestamp when TTL inline-sweep will evict the entry. |
| `size` | `number` | UTF-8 byte length of `content`, computed once at put time for cheap listing. |
| `lastFetchedAt` | `string?` | ISO timestamp of the most recent successful `coatCheckGet`. Undefined until first fetch. |
| `lastFetchedBy` | `string?` | Player id of the most recent fetcher. Undefined until first fetch. |
| `fetchCount` | `number` | Total number of successful redemptions. `0` until first fetch. Lists do NOT increment it. |

### `CoatCheckEntryHeader` (#318)

Listing projection — same as `CoatCheckEntry` minus the `content` body, plus a top-level `ticket: string` field. Used by `coatCheckList` so dashboards can survey without pulling every body.

Limits (enforced by `coatCheckPut` validator and the `coat_check_put` Zod schema):

- Max `content` size: 32 KiB UTF-8 per entry (`CoatCheckEntryTooLarge`).
- Max `summary` length: 500 chars (`CoatCheckSummaryTooLarge`).
- Max `contentType` length: 64 chars.
- Max populated entries per ensemble: 20. The 21st put rejects with `CoatCheckSlotsFull` listing the oldest 3 ticket ids — caller must wait for TTL or call `coat_check_evict` (owner-or-conductor). **No LRU eviction** — refuse-and-error matches #334's saturation policy and is structurally safer in the multi-host scope (LRU on a shared store with multi-host writers means a noisy host silently evicts peers).
- TTL range: [1h, 30d]; default 7d. Sub-minute TTLs rejected with `CoatCheckInvalidTtl`.
- `evictedBy` permission gate on `coatCheckEvict`: must equal `entry.putBy` OR `<ensemble conductor's playerId>`; everyone else gets `CoatCheckEvictPermissionDenied`.

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
| `agentType` | `string` | Agent backend — one of `claude`, `copilot`, `mock` (dev-mode-only), `claude-api`, `opencode`, `claude-code-headless`. Mirrors `AgentType` in `src/types.ts`. (#535) |
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
| `broadcastId` | `string?` | #357: Stable id shared across every fan-out target of a single `broadcast` invocation. Generated once in the broadcaster's MCP-tool process and threaded through `CueOutboxEntry` → `receiveMessage` signal → `Message.broadcastId` / `SentMessage.broadcastId` → this projection. The TUI uses it to fold N identical broadcast deliveries into a single chat row. `undefined` for non-broadcast direct cues. Additive optional field — pre-#357 readers ignore it transparently. |

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
| `'user-stop'` | User-initiated graceful stop (`agent-tempo stop`). |
| `'restart'` | Adapter is being replaced by a new attachment (e.g. `restart` operation). |
| `'heartbeat-timeout'` | Adapter missed 3+ consecutive heartbeats; workflow forced detach. |
| `'superseded'` | Another adapter claimed the attachment (multi-host migration). |
| `'agent-exited'` | Adapter's underlying agent subprocess died (e.g. Ctrl+C on terminal). |
| `'spawn-failed'` | Spawn activity for a new attachment failed; workflow self-heals to `detached`. |
| `'destroy'` | Session permanently destroyed via the `destroy` update. |
| `'force'` | Main loop fired `drainingDeadline` — adapter sent `requestDetach` but never sent `adapterExited` within the grace period. Implementation extension; may merge with `'heartbeat-timeout'` in a future cleanup. |
| `'reconnect-exhausted'` | **v0.26.** Adapter exhausted its 15-minute reconnect budget without successfully re-claiming the session. Terminal — the adapter shuts down after emitting this reason. Added in #205. |
| `'continued-as-new'` | **v0.26.** Adapter-side signal that the pinned runId saw `WorkflowExecutionAlreadyCompleted` AND the closed run's history carried a `WorkflowExecutionContinuedAsNewEvent`. When the subclass opts in (`shouldReconnect`), the base class rebinds `pinnedHandle` to the successor runId in-place (no re-claim — lease is carried across CAN per §2.3) and the delivery loop resumes. When not opted in, it fires as a terminal reason. Added in #226 to fix the silent-cue-loss bug where adapters stopped polling after CAN. |
| `'boot-timeout'` | **New in 2.0 (#704).** The booting attach-timeout watchdog reaped a session that never reached `claimAttachment` within `BOOTING_DEADLINE_MS` (default 180s). Terminal: the workflow flips to `'gone'` and COMPLETEs (reuses `gone` — NOT a new phase enum), stamps the `AgentTempoCloseReason='boot-timeout'` memo, and surfaces this reason on `orphanSummary.reason`. Only armed for headless adapters on a fresh boot (interactive `claude-code` is disarmed until #890; handoffs never arm). |
