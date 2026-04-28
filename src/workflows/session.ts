import {
  setHandler,
  condition,
  continueAsNew,
  workflowInfo,
  allHandlersFinished,
  upsertSearchAttributes,
  uuid4,
  proxyActivities,
  patched,
  log as workflowLog,
} from '@temporalio/workflow';
import { ApplicationFailure } from '@temporalio/common';

/**
 * Workflow-deterministic clock. The Temporal TS SDK intercepts `new Date()` at the
 * sandbox level to return replay-consistent time, so this wrapper is safe — the
 * name aligns with the project convention (CLAUDE.md: "no `Date.now()` in workflow
 * code, use `workflow.now()` instead") while using the SDK-intercepted constructor.
 */
function workflowNow(): Date {
  return new Date();
}

import type { OutboxActivities } from '../activities/outbox';
import type { HardTerminateResult } from '../activities/hard-terminate';
import { extendAttachmentForCAN } from './attachment-math';

import {
  SessionInput,
  Message,
  SentMessage,
  Command,
  PlayerReport,
  HistoryEntry,
  OutboxEntry,
  OutboxEntryInput,
  QualityGate,
  WorktreeEntry,
  receiveMessageSignal,
  setPartSignal,
  setNameSignal,
  markDeliveredSignal,
  updateMetadataSignal,
  getPartQuery,
  getMetadataQuery,
  pendingMessagesQuery,
  allMessagesQuery,
  recordSentMessageSignal,
  allSentMessagesQuery,
  commandSignal,
  playerReportSignal,
  historyQuery,
  submitOutboxUpdate,
  outboxQuery,
  // #399 W2 — session wire extensions (Q5.2/Q5.5/Q5.6/Q5.7)
  getRunIdQuery,
  getMessagingStateQuery,
  getActivityStateQuery,
  getLeaseStateQuery,
  setQualityGateSignal,
  evaluateGateCriteriaSignal,
  qualityGatesQuery,
  setWorktreeSignal,
  removeWorktreeSignal,
  worktreesQuery,
  setStageSignal,
  cancelStageSignal,
  stagesQuery,
  StageEntry,
  releaseHeldSignal,
  outboxLockedQuery,
  setPausedSignal,
  pausedQuery,
  processingStartUpdate,
  processingEndUpdate,
  inFlightMessagesQuery,
  destroyUpdate,
  isDestroyedQuery,
  // v0.25 attachment lifecycle
  claimAttachmentUpdate,
  forceDetachUpdate,
  enqueueSpawnUpdate,
  setPreferredHostUpdate,
  heartbeatSignal,
  requestDetachSignal,
  adapterExitedSignal,
  attachmentInfoQuery,
  orphanSummaryQuery,
  // Test-only (#226 reconnect-after-CAN coverage)
  testForceContinueAsNewSignal,
} from './signals';
import type {
  Attachment,
  AttachmentPhase,
  AttachmentToken,
  AttachmentInfo,
  AdapterClass,
  AgentType,
  DetachReason,
  OrphanSummary,
  SpawnOutboxEntry,
} from '../types';
// ── Outbox Activity Proxies ──

const { deliverCue, deliverReport, terminateSession, startRecruitedSession, releasePlayer, deliverDetach, deliverDestroy, deliverRestart } =
  proxyActivities<OutboxActivities>({
    startToCloseTimeout: '30 seconds',
    retry: { maximumAttempts: 3 },
  });

function getSpawnProxy(hostname: string) {
  return proxyActivities<Pick<OutboxActivities, 'spawnProcess'>>({
    taskQueue: `claude-tempo-${hostname}`,
    startToCloseTimeout: '2 minutes',
    retry: { maximumAttempts: 2 },
  }).spawnProcess;
}

/**
 * Host-routed proxy for the #159 Gap 2 hard-terminate activity. Runs on the target's
 * `claude-tempo-{hostname}` task queue so the kill happens where the child process
 * actually lives. Short timeout + low retry — this is a best-effort cleanup and the
 * workflow must not wedge if the host worker is down.
 */
function getHardTerminateProxy(hostname: string) {
  return proxyActivities<Pick<OutboxActivities, 'hardTerminateAttachment'>>({
    taskQueue: `claude-tempo-${hostname}`,
    startToCloseTimeout: '10 seconds',
    scheduleToCloseTimeout: '20 seconds',
    retry: { maximumAttempts: 1 },
  }).hardTerminateAttachment;
}

/**
 * Shorter-timeout proxy for destroyUpdate. Destroy is terminal/best-effort
 * (§2.5) — if the host worker is offline we don't want to block the workflow's
 * terminal transition for 20s waiting on a schedule-to-close timeout. Test
 * environments without a host worker fail fast in ~5s instead.
 */
function getHardTerminateProxyForDestroy(hostname: string) {
  return proxyActivities<Pick<OutboxActivities, 'hardTerminateAttachment'>>({
    taskQueue: `claude-tempo-${hostname}`,
    startToCloseTimeout: '5 seconds',
    scheduleToCloseTimeout: '5 seconds',
    retry: { maximumAttempts: 1 },
  }).hardTerminateAttachment;
}

export async function claudeSessionWorkflow(input: SessionInput): Promise<void> {
  // ── v0.25 Attachment Lifecycle Timers (design §2.3, §9.5) ──
  // PR-C commit 6 (#119a): each attachment carries its own `leaseMs` (negotiated at
  // claim time). No workflow-side default constant — heartbeats extend `expiresAt`
  // by `currentAttachment.leaseMs`.
  /**
   * Legacy CAN-extension constant. Retained solely so sessions that ran on a
   * pre-#249 workflow bundle replay deterministically: the `patched()` branch at
   * the CAN-boundary extension site selects this constant on the non-patched
   * side, matching the exact arg sequence those histories recorded. New runs
   * (and all post-#249 CAN transitions) use `currentAttachment.leaseMs` instead
   * — see the call site below.
   */
  const HEARTBEAT_INTERVAL_MS = 30_000;
  /**
   * Default grace period for `draining → detached` transition after requestDetach. Used when a
   * `requestDetach` signal omits `deadlineMs`. Per-signal overrides are honored via the
   * `drainingDeadlineMs` state variable below (fix for #159 Gap 1a).
   */
  const DEFAULT_DRAINING_DEADLINE_MS = 5_000;
  /** Max duration a messageId can stay in-flight before the safety timer ejects it. */
  const PROCESSING_DEADLINE_MS = 15 * 60 * 1000;

  // Version marker for v0.10 — records a patch marker in workflow history.
  // Future workflow changes that alter the command sequence should use
  // patched('v0.10-<change-name>') to protect in-flight sessions from
  // non-determinism errors during rolling deploys.
  patched('v0.10-initial');
  patched('v0.11-check-and-set-status');
  patched('v0.13-quality-gates');
  patched('v0.14-worktrees');
  patched('v0.15-blocked-detection');
  patched('v0.18-stages');
  patched('v0.23-hold-release');
  patched('v0.25-attachment-lifecycle');
  // Issue #172: kept as a replay marker for workflows that predate the
  // simpler hold-on-startup design (v0.26). The state field + interceptor
  // were removed in favor of baking the banner/directive into
  // `SessionInput.messages` at workflow creation, but leaving the patched
  // marker ensures existing replay histories that recorded this command
  // still deserialize cleanly. Safe no-op today.
  patched('v0.26-pending-startup-context');

  // Ensure search attributes are always current — critical when reconnecting
  // via WorkflowIdConflictPolicy.USE_EXISTING, which skips the attributes
  // passed to client.workflow.start().
  upsertSearchAttributes({
    ClaudeTempoEnsemble: [input.metadata.ensemble],
    ClaudeTempoPlayerId: [input.metadata.playerId],
    ClaudeTempoHostname: [input.metadata.hostname],
    ...(input.metadata.gitRoot ? { ClaudeTempoGitRoot: [input.metadata.gitRoot] } : {}),
    ...(input.metadata.playerType ? { ClaudeTempoPlayerType: [input.metadata.playerType] } : {}),
    ClaudeTempoIsConductor: [input.metadata.isConductor === true],
    // v0.25 attachment search attributes — initial values for a fresh/restored workflow.
    // Updated on every phase transition below.
    ClaudeTempoAttachedHost: [input.currentAttachment?.hostname ?? ''],
    ClaudeTempoAttachmentState: [input.phase ?? 'booting'],
    ClaudeTempoAttachmentId: [input.currentAttachment?.attachmentId ?? ''],
  });

  // ── State (carried across continue-as-new) ──
  let part = input.part ?? input.autoSummary ?? 'No description set';
  const messages: Message[] = input.messages ?? [];
  const sentMessages: SentMessage[] = input.sentMessages ?? [];
  const outbox: OutboxEntry[] = input.outbox ?? [];
  let lastActivityTime = workflowNow().getTime();
  let lastOutboundTime = input.lastOutboundTime ?? workflowNow().getTime();
  let lastInboundRRTime = input.lastInboundRRTime ?? 0;

  // ── #399 W2 — wire-extension counters (carried across continueAsNew) ──
  // `activityCount` mirrors the ~20 `lastActivityTime` mutation sites;
  // `receivedCount` / `sentCount` track inbound cues + outbox submissions.
  // All three feed dashboard surfaces via the new `getActivityStateQuery`
  // and `getMessagingStateQuery` queries.
  let activityCount = input.activityCount ?? 0;
  let receivedCount = input.receivedCount ?? 0;
  let sentCount = input.sentCount ?? 0;

  // ── Warm Hold + Pause State ──
  let outboxLocked = input.outboxLocked ?? false;
  let heldMessage: string | undefined = input.heldMessage;
  let paused = input.paused ?? false;

  // ── v0.25 Attachment Lifecycle State (design §2.2) ──
  /** Current attachment lease, or null when detached. */
  let currentAttachment: Attachment | null = input.currentAttachment ?? null;
  /** Current phase — authoritative source of lifecycle truth after #175. */
  let phase: AttachmentPhase = input.phase ?? (currentAttachment ? 'attached' : 'booting');
  /** Preferred host for daemon reconcile-on-boot auto-restore. */
  let preferredHost: string | undefined = input.preferredHost ?? currentAttachment?.hostname ?? input.metadata.hostname;
  /** ISO timestamp of when the current `draining` phase started. */
  let drainingSince: string | null = input.drainingSince ?? null;
  /**
   * Grace window (ms) for the current `draining` phase, if a `requestDetach` signal supplied one.
   * Fix for #159 Gap 1a: the pre-fix handler discarded `deadlineMs` and always used the 5s default,
   * so callers requesting a longer/shorter window were silently ignored. Reset to `null` whenever
   * `drainingSince` clears so it can't leak into the next detach cycle.
   */
  let drainingDeadlineMs: number | null = input.drainingDeadlineMs ?? null;
  /**
   * Monotonic counter bumped by signal/update handlers that *shorten* `nextDeadlineMs()` output
   * (e.g. `requestDetach` creates a new, sooner draining deadline; `forceDetach` nullifies the
   * current attachment expiry). The main-loop `condition(...)` includes `wakeEpoch` in its
   * predicate so state changes outside the existing wake conditions still punch through the
   * already-scheduled timeout — fix for #159 Gap 1b. Signal handlers that *extend* deadlines
   * (e.g. heartbeat) don't need to bump since the pre-existing, earlier deadline firing and
   * being re-checked is harmless.
   */
  let wakeEpoch = 0;
  /** Reason recorded when the last attachment detached (for orphanSummary query). */
  let lastDetachReason: DetachReason | undefined;
  /** Metadata about the last-known adapter (for orphanSummary query). */
  let lastAdapterMeta: { hostname: string; adapterId: string } | undefined = currentAttachment
    ? { hostname: currentAttachment.hostname, adapterId: currentAttachment.adapterId }
    : undefined;
  /** ISO timestamp of when the workflow most recently entered `detached`. */
  let detachedSince: string | null = null;

  // ── Processing Lifecycle State (fixes #99) ──
  // Tracks messages currently being processed by a blocking adapter. While non-empty,
  // stale detection is suppressed AND the phase refines to `processing`.
  const inFlightMessages = new Set<string>(input.inFlightMessageIds ?? []);
  // processingSince carried as ISO string in v0.25; normalize numeric legacy values.
  const _inputProcessingSince = input.processingSince;
  let processingSince: string | null =
    typeof _inputProcessingSince === 'string'
      ? _inputProcessingSince
      : typeof _inputProcessingSince === 'number'
        ? new Date(_inputProcessingSince).toISOString()
        : (inFlightMessages.size > 0 ? workflowNow().toISOString() : null);

  // ── Destroy State (fixes #102; §8.5 immediate-COMPLETE) ──
  // Once set, the workflow COMPLETES per §2.5 (abandon in-flight, no drain).
  // Adapter recovery code reads `isDestroyed` and exits.
  let destroyed = input.destroyed ?? false;
  let destroyRequested = destroyed;
  /** IDs of outbox entries abandoned by the last `destroy` — written to history event. */
  let destroyAbandonedIds: string[] = [];
  // PR-H (#132): the v0.25.1 `updateMetadata({ status: 'terminated' })` shim
  // path is gone. `destroyRequested` is set only by the `destroyUpdate` handler
  // below. Operator-initiated termination flows through the `destroy` verb +
  // its outbox path; adapter graceful exit fires `adapterExited`; MCP-server
  // SIGINT detaches without destroying. See
  // docs/design/session-lifecycle-rebuild-v2.md §2.5, §11.1.

  // ── Helpers ──

  /**
   * Reduce the outbox state list to a short status string for the
   * dashboard's `Messages` KV row (Q5.5 of #399 W2). Returns:
   *
   *   - `"empty"`               — no pending entries
   *   - `"N pending"`           — pending entries, oldest within `STALE_MS`
   *   - `"N pending (oldest 2m)"` — pending entries, oldest beyond
   *     the stale threshold; the magnitude (m / s) is human-rounded so
   *     the dashboard reads cleanly without further parsing.
   *
   * `STALE_MS = 30_000` per the brief — anything older than 30s pending
   * is the "outbox is backing up" signal we want to surface.
   */
  function outboxStatus(): string {
    const STALE_MS = 30_000;
    const nowMs = workflowNow().getTime();
    let count = 0;
    let oldestAge = 0;
    for (const e of outbox) {
      if (e.status !== 'pending') continue;
      count++;
      const age = nowMs - Date.parse(e.createdAt);
      if (age > oldestAge) oldestAge = age;
    }
    if (count === 0) return 'empty';
    if (oldestAge < STALE_MS) return `${count} pending`;
    const minutes = Math.floor(oldestAge / 60_000);
    const ageLabel = minutes >= 1 ? `${minutes}m` : `${Math.floor(oldestAge / 1000)}s`;
    return `${count} pending (oldest ${ageLabel})`;
  }

  /** Transition to a new phase, syncing the attachment search attribute. */
  function setPhase(next: AttachmentPhase): void {
    if (phase === next) return;
    phase = next;
    upsertSearchAttributes({ ClaudeTempoAttachmentState: [next] });
    lastActivityTime = workflowNow().getTime();
    activityCount++;
  }

  /** Build the token returned from `claimAttachment`. `leaseMs` is the value the caller
   *  supplied (or the default if they didn't), so the adapter knows when to heartbeat. */
  function attachmentTokenFrom(a: Attachment, leaseMs: number): AttachmentToken {
    return {
      attachmentId: a.attachmentId,
      runId: a.runId,
      expiresAt: a.expiresAt,
      leaseMs,
    };
  }

  /** Compute next time-based deadline for the main loop. Returns +Infinity when no deadline applies. */
  function nextDeadlineMs(): number {
    const nowMs = workflowNow().getTime();
    const candidates: number[] = [];
    if (currentAttachment) {
      candidates.push(new Date(currentAttachment.expiresAt).getTime());
    }
    if (processingSince) {
      candidates.push(new Date(processingSince).getTime() + PROCESSING_DEADLINE_MS);
    }
    if (phase === 'draining' && drainingSince) {
      const window = drainingDeadlineMs ?? DEFAULT_DRAINING_DEADLINE_MS;
      candidates.push(new Date(drainingSince).getTime() + window);
    }
    if (candidates.length === 0) return Number.POSITIVE_INFINITY;
    return Math.max(0, Math.min(...candidates) - nowMs);
  }

  // ── Outbox Update + Query Handlers ──

  setHandler(submitOutboxUpdate, (entryInput: OutboxEntryInput) => {
    const entry: OutboxEntry = {
      ...entryInput,
      id: uuid4(),
      createdAt: workflowNow().toISOString(),
      status: 'pending',
    } as OutboxEntry;
    outbox.push(entry);
    // #399 W2 — every outbox submission counts as outbound traffic.
    sentCount++;

    // Record in sentMessages for history continuity
    if (entry.type === 'cue') {
      // #357: forward broadcastId so the sender's view reflects the same
      // grouping the receiver sees.
      sentMessages.push({
        id: entry.id,
        to: entry.targetPlayerId,
        text: entry.message,
        timestamp: entry.createdAt,
        ...(entry.broadcastId !== undefined ? { broadcastId: entry.broadcastId } : {}),
      });
    } else if (entry.type === 'report') {
      sentMessages.push({ id: entry.id, to: 'conductor', text: `[${entry.reportType}] ${entry.text}`, timestamp: entry.createdAt });
    } else if (entry.type === 'stop') {
      sentMessages.push({ id: entry.id, to: entry.targetPlayerId, text: '[stop requested]', timestamp: entry.createdAt });
    } else if (entry.type === 'detach') {
      sentMessages.push({ id: entry.id, to: entry.targetPlayerId, text: '[detach requested]', timestamp: entry.createdAt });
    } else if (entry.type === 'destroy') {
      sentMessages.push({ id: entry.id, to: entry.targetPlayerId, text: '[destroy requested]', timestamp: entry.createdAt });
    } else if (entry.type === 'restart') {
      sentMessages.push({ id: entry.id, to: entry.targetPlayerId, text: '[restart requested]', timestamp: entry.createdAt });
    } else if (entry.type === 'release') {
      sentMessages.push({ id: entry.id, to: entry.targetPlayerId, text: '[release requested]', timestamp: entry.createdAt });
    }

    lastActivityTime = workflowNow().getTime();
    activityCount++;
    lastOutboundTime = workflowNow().getTime();
    return entry.id;
  }, {
    validator: (entry: OutboxEntryInput) => {
      if (!entry.type) throw new ApplicationFailure('Outbox entry must have a type', 'InvalidOutboxEntry', true);
    },
  });

  setHandler(outboxQuery, () => outbox);

  // ── Player Signal Handlers ──

  setHandler(receiveMessageSignal, (msg) => {
    messages.push({
      id: uuid4(),
      from: msg.from,
      text: msg.text,
      timestamp: workflowNow().toISOString(),
      delivered: false,
      isMaestro: msg.isMaestro,
      // #357: thread the broadcast id (if any) onto the stored Message
      // so subsequent `allMessages`/`fetchEnsembleChat` queries surface
      // it for TUI grouping.
      ...(msg.broadcastId !== undefined ? { broadcastId: msg.broadcastId } : {}),
    });
    lastActivityTime = workflowNow().getTime();
    activityCount++;
    // #399 W2 — every inbound cue counts as received traffic.
    receivedCount++;
    // Track inbound messages that expect a response (default: true for backward compat)
    if (patched('v0.20-response-requested-blocked') && msg.responseRequested !== false) {
      lastInboundRRTime = workflowNow().getTime();
    }
  });

  setHandler(setPartSignal, (newPart) => {
    part = newPart;
    lastActivityTime = workflowNow().getTime();
    activityCount++;
    lastOutboundTime = workflowNow().getTime();
  });

  setHandler(setNameSignal, (newName) => {
    input.metadata.playerId = newName;
    upsertSearchAttributes({ ClaudeTempoPlayerId: [newName] });
    lastActivityTime = workflowNow().getTime();
    activityCount++;
  });

  setHandler(markDeliveredSignal, (ids) => {
    for (const msg of messages) {
      if (ids.includes(msg.id)) {
        msg.delivered = true;
      }
    }
    // Any delivery proves the session is alive
    lastActivityTime = workflowNow().getTime();
    activityCount++;
  });

  setHandler(updateMetadataSignal, (update) => {
    if (update.hostname != null) input.metadata.hostname = update.hostname;
    if (update.gitBranch != null) input.metadata.gitBranch = update.gitBranch;
    if (update.gitRoot != null) input.metadata.gitRoot = update.gitRoot;
    if (update.playerType != null) input.metadata.playerType = update.playerType;
    if (update.playerTypeDescription != null) input.metadata.playerTypeDescription = update.playerTypeDescription;
    if (update.worktreePath != null) input.metadata.worktreePath = update.worktreePath;
    if (update.sessionId != null || (update as any).claudeSessionId != null) {
      input.metadata.sessionId = update.sessionId ?? (update as any).claudeSessionId;
    }
    // `update.enableStaleDetection` is silently dropped — attachment phase
    // (driven by the V2 wire surface: claimAttachment / adapterExited /
    // forceDetach / destroy) is authoritative for lifecycle state.
    upsertSearchAttributes({
      ClaudeTempoEnsemble: [input.metadata.ensemble],
      ClaudeTempoPlayerId: [input.metadata.playerId],
      ClaudeTempoHostname: [input.metadata.hostname],
      ...(input.metadata.gitRoot ? { ClaudeTempoGitRoot: [input.metadata.gitRoot] } : {}),
      ...(input.metadata.playerType ? { ClaudeTempoPlayerType: [input.metadata.playerType] } : {}),
      ClaudeTempoIsConductor: [input.metadata.isConductor === true],
    });
    lastActivityTime = workflowNow().getTime();
    activityCount++;
  });

  setHandler(recordSentMessageSignal, (msg) => {
    sentMessages.push({
      id: uuid4(),
      to: msg.to,
      text: msg.text,
      timestamp: workflowNow().toISOString(),
      // #357: mirror Message.broadcastId on the sender side so the
      // TUI's local-side projection sees the same fold key.
      ...(msg.broadcastId !== undefined ? { broadcastId: msg.broadcastId } : {}),
    });
  });

  // ── Player Query Handlers ──

  setHandler(getPartQuery, () => part);
  setHandler(getMetadataQuery, () => input.metadata);
  setHandler(pendingMessagesQuery, () => messages.filter((m) => !m.delivered));
  setHandler(allMessagesQuery, () => messages);
  setHandler(allSentMessagesQuery, () => sentMessages);

  // ── #399 W2 — Wire extension queries (Q5.2 / Q5.5 / Q5.6 / Q5.7) ──

  setHandler(getRunIdQuery, () => workflowInfo().runId);

  setHandler(getMessagingStateQuery, () => ({
    received: receivedCount,
    sent: sentCount,
    outbox: outboxStatus(),
  }));

  setHandler(getActivityStateQuery, () => ({
    activityCount,
    lastActivityAt: new Date(lastActivityTime).toISOString(),
  }));

  setHandler(getLeaseStateQuery, () => {
    if (!currentAttachment) return { expiresAt: null, leaseMs: null };
    return {
      expiresAt: Date.parse(currentAttachment.expiresAt),
      leaseMs: currentAttachment.leaseMs,
    };
  });

  // ── Hold / Release Handlers ──

  setHandler(releaseHeldSignal, () => {
    if (heldMessage) {
      // Deliver the stored initial message now that the hold is released
      messages.push({
        id: uuid4(),
        from: input.metadata.recruitedBy || 'system',
        text: heldMessage,
        timestamp: workflowNow().toISOString(),
        delivered: false,
      });
      heldMessage = undefined;
    }
    outboxLocked = false;
  });

  setHandler(outboxLockedQuery, () => outboxLocked);

  // ── Pause / Resume Handlers ──

  setHandler(setPausedSignal, (value: boolean) => {
    paused = value;
  });

  setHandler(pausedQuery, () => paused);

  // ── Processing Lifecycle Handlers (fixes #99; v0.25 phase-aware) ──

  setHandler(processingStartUpdate, ({ messageId, expectedAttachmentId }) => {
    // `expectedAttachmentId` is optional for shim compatibility; when provided, only operate
    // if it matches the current attachment (prevents late updates from a superseded adapter).
    if (expectedAttachmentId && currentAttachment?.attachmentId !== expectedAttachmentId) {
      throw ApplicationFailure.nonRetryable(
        `Attachment ${expectedAttachmentId} does not match current ${currentAttachment?.attachmentId ?? 'none'}`,
        'AttachmentMismatch',
      );
    }
    const wasEmpty = inFlightMessages.size === 0;
    inFlightMessages.add(messageId);
    if (wasEmpty) {
      processingSince = workflowNow().toISOString();
      // Phase refinement: if we're attached (or awaiting), move to `processing`.
      if (phase === 'attached' || phase === 'awaiting') setPhase('processing');
    }
    lastActivityTime = workflowNow().getTime();
    activityCount++;
    return { inFlightCount: inFlightMessages.size };
  }, {
    validator: ({ messageId }) => {
      if (!messageId || typeof messageId !== 'string') {
        throw ApplicationFailure.nonRetryable(
          'processingStart requires a non-empty messageId',
          'InvalidMessageId',
        );
      }
      if (phase === 'gone') {
        throw ApplicationFailure.nonRetryable(
          'Cannot start processing on destroyed session',
          'WorkflowGone',
        );
      }
    },
  });

  setHandler(processingEndUpdate, ({ messageId, expectedAttachmentId }) => {
    if (expectedAttachmentId && currentAttachment?.attachmentId !== expectedAttachmentId) {
      throw ApplicationFailure.nonRetryable(
        `Attachment ${expectedAttachmentId} does not match current ${currentAttachment?.attachmentId ?? 'none'}`,
        'AttachmentMismatch',
      );
    }
    inFlightMessages.delete(messageId);
    if (inFlightMessages.size === 0) {
      processingSince = null;
      // Phase refinement (§2.2, §2.4; fixes #117): when in-flight drops to 0, move
      // back out of `processing`. If the outbox has nothing left to dispatch, land
      // directly in `awaiting` (idle refinement of attached). Otherwise `attached`,
      // and the main-loop outbox-dispatch drain will refine to `awaiting` once the
      // outbox clears.
      if (phase === 'processing') {
        const outboxIdle = !outbox.some(
          (e) => e.status === 'pending' || e.status === 'processing',
        );
        setPhase(outboxIdle ? 'awaiting' : 'attached');
      }
    }
    lastActivityTime = workflowNow().getTime();
    activityCount++;
    return { inFlightCount: inFlightMessages.size };
  }, {
    validator: ({ messageId }) => {
      if (!messageId || typeof messageId !== 'string') {
        throw ApplicationFailure.nonRetryable(
          'processingEnd requires a non-empty messageId',
          'InvalidMessageId',
        );
      }
    },
  });

  setHandler(inFlightMessagesQuery, () => [...inFlightMessages]);

  // ── Destroy Handler (fixes #102; design §8.5) ──
  // Terminal: set phase = gone, revoke attachment, emit audit event with abandoned outbox
  // IDs, return from main loop → workflow COMPLETES. Per §2.5: abandon in-flight outbox
  // (no drain wait) — destroy is an explicit operator action; delivery is best-effort.
  //
  // #164: the handler is `async` because it also fires `hardTerminateAttachment` on the
  // host's per-host task queue before the state flip, to prevent an orphaned claude.exe
  // when destroy is invoked while an attachment is live. Unlike `forceDetachUpdate` this
  // is wrapped best-effort — a failure there MUST NOT wedge the workflow, because destroy
  // is terminal by contract. See issue #164 for the orphan repro.

  setHandler(destroyUpdate, async ({ reason, terminatedBy }) => {
    if (phase === 'gone') return; // idempotent
    // Record abandoned outbox entries for the history/audit event.
    destroyAbandonedIds = outbox
      .filter((e) => e.status === 'pending' || e.status === 'processing')
      .map((e) => e.id);
    if (destroyAbandonedIds.length > 0) {
      workflowLog.warn(
        `destroy abandoning ${destroyAbandonedIds.length} outbox entr${destroyAbandonedIds.length === 1 ? 'y' : 'ies'}: ${destroyAbandonedIds.join(', ')}` +
        `${reason ? ` (reason: ${reason})` : ''}`,
      );
    } else if (reason) {
      workflowLog.info(`destroy requested (reason: ${reason})`);
    }
    // #164: await hardTerminate BEFORE flipping `destroyRequested` / `phase`. Must
    // await (fire-and-forget is dropped because the workflow's main loop exits as
    // soon as destroyRequested=true, before the activity has a chance to dispatch).
    // Best-effort: 5s timeout, log-and-continue on failure. `destroyRequested` flips
    // AFTER the activity so the main loop stays alive to dispatch it.
    //
    // #227: the original (#164) guard was `if (currentAttachment)` — correct for the
    // `phase=attached` case but silently skipped the kill when `phase=detached`, leaking
    // `claude.exe` + terminal tab when a destroy ran on a session whose lease had been
    // reaped. The ensemble cascade exposed by #226/#201 made this a reliable orphan
    // generator: destroy → workflow COMPLETES, process survives. Fix: pick the best
    // host we have from workflow state and fire the kill whenever *any* host is known.
    //
    // `hardTerminateAttachment` is already safe to run speculatively — it does image-
    // name PID-reuse guards + command-line matching on `-n <playerName>` AND
    // `--remote-control-session-name-prefix <ensemble>`, so a stale state that no
    // longer corresponds to a live process returns `strategy: 'none'` with a clean
    // log line. No new PID / attach-time wire-protocol fields needed.
    //
    // Host-pick priority (aligns with the reap path's provenance tracking):
    //   1. `currentAttachment.hostname`  — `phase=attached` / `processing` / `awaiting`
    //   2. `lastAdapterMeta.hostname`    — `phase=detached` (set by forceDetach / reap)
    //   3. `preferredHost`               — post-CAN restore before any adapter landed
    //   4. `input.metadata.hostname`     — recruit-time fallback (booting path)
    const killHost =
      currentAttachment?.hostname ??
      lastAdapterMeta?.hostname ??
      preferredHost ??
      input.metadata.hostname;
    if (killHost) {
      try {
        const killResult: HardTerminateResult = await getHardTerminateProxyForDestroy(killHost)({
          ensemble: input.metadata.ensemble,
          playerName: input.metadata.playerId,
          agent: (input.metadata.agentType ?? 'claude') as AgentType,
          workDir: input.metadata.workDir,
        });
        workflowLog.info(
          `destroy hard-terminate on ${killHost} (phase=${phase}): strategy=${killResult.strategy}, ` +
          `killedPids=[${killResult.killedPids.join(',')}]`,
        );
      } catch (err) {
        workflowLog.warn(
          `destroy hard-terminate failed on ${killHost} (continuing, best-effort): ` +
          `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    // Flip destroyRequested AFTER the kill so the main loop stays alive for activity
    // dispatch. Any concurrent claimAttachment / processingStart that arrives during
    // the 5s kill window will still hit the phase!=='gone' guard until we setPhase
    // below; on rare kill-in-progress races, the new work is abandoned by setPhase('gone').
    destroyRequested = true;
    // Revoke attachment (if any) — record metadata for orphanSummary/audit.
    if (currentAttachment) {
      lastAdapterMeta = { hostname: currentAttachment.hostname, adapterId: currentAttachment.adapterId };
      lastDetachReason = 'destroy';
      currentAttachment = null;
    }
    upsertSearchAttributes({
      ClaudeTempoAttachedHost: [''],
      ClaudeTempoAttachmentId: [''],
    });
    setPhase('gone');
    // Inject a final audit message so the old adapter-completion path has something to show.
    messages.push({
      id: uuid4(),
      from: terminatedBy || 'system',
      text: `Session destroyed${reason ? `: ${reason}` : ''}.`,
      timestamp: workflowNow().toISOString(),
      delivered: false,
    });
    lastActivityTime = workflowNow().getTime();
    activityCount++;
  });

  setHandler(isDestroyedQuery, () => destroyed || destroyRequested);

  // ── Test-only CAN trigger (#226) ──
  // Force the next main-loop iteration into the `continueAsNew` branch without
  // waiting for the server's history-size threshold. Production code never sends
  // this; the adapter reconnect test uses it to exercise the CAN-boundary path
  // in <1s instead of emitting ~10k filler events. One-shot: the flag is cleared
  // when the main loop acts on it, so repeated signals require repeated sends.
  //
  // The `wakeEpoch` bump is essential — the main loop's `condition()` predicate
  // (see §9.5 loop body below) only wakes on outbox activity, phase changes,
  // destroy, or `wakeEpoch` drift. Without the bump, an idle session would sit
  // asleep until its lease-expiry deadline and the test would time out.
  let forceContinueAsNew = false;
  setHandler(testForceContinueAsNewSignal, () => {
    forceContinueAsNew = true;
    wakeEpoch++;
    lastActivityTime = workflowNow().getTime();
    activityCount++;
  });

  // ── v0.25 Attachment Lifecycle Handlers (design §§8, §9.2, §9.5) ──

  /**
   * `claimAttachment` — transactional claim / renewal of the attachment lease.
   * Pseudocode and behavior per design §9.2.
   */
  setHandler(claimAttachmentUpdate, ({ host, adapterId, adapterClass, leaseMs, expectedAttachmentId }) => {
    if (phase === 'gone') {
      throw ApplicationFailure.nonRetryable(
        `Cannot attach to ${workflowInfo().workflowId}: workflow is terminated`,
        'WorkflowGone',
      );
    }
    const now = workflowNow();
    const nowMs = now.getTime();

    // Renewal path: caller provides a valid expectedAttachmentId matching the current
    // attachment, and the lease hasn't expired yet.
    if (
      currentAttachment &&
      currentAttachment.attachmentId === expectedAttachmentId &&
      new Date(currentAttachment.expiresAt).getTime() > nowMs
    ) {
      currentAttachment.lastHeartbeatAt = now.toISOString();
      currentAttachment.expiresAt = new Date(nowMs + leaseMs).toISOString();
      // Honour the caller's renewal-time leaseMs so subsequent heartbeats extend
      // the lease by the current negotiated value (not the claim-time value).
      currentAttachment.leaseMs = leaseMs;
      lastActivityTime = nowMs;
      activityCount++;
      return attachmentTokenFrom(currentAttachment, leaseMs);
    }

    // Conflict: active lease held by someone else.
    if (currentAttachment && new Date(currentAttachment.expiresAt).getTime() > nowMs) {
      throw ApplicationFailure.nonRetryable(
        `Attached on ${currentAttachment.hostname} until ${currentAttachment.expiresAt}`,
        'AttachmentConflict',
      );
    }

    // Free or expired — claim fresh.
    const newAttachment: Attachment = {
      attachmentId: uuid4(),
      hostname: host,
      adapterId,
      adapterClass,
      claimedAt: now.toISOString(),
      lastHeartbeatAt: now.toISOString(),
      expiresAt: new Date(nowMs + leaseMs).toISOString(),
      leaseMs,
      runId: workflowInfo().runId,
    };
    currentAttachment = newAttachment;
    lastAdapterMeta = { hostname: newAttachment.hostname, adapterId: newAttachment.adapterId };
    preferredHost = host;
    // Fresh claim abandons any residual in-flight messageIds from the previous adapter.
    inFlightMessages.clear();
    processingSince = null;
    // A fresh claim always supersedes an in-flight drain; clear its window so a later
    // `requestDetach` starts from the default and doesn't inherit a stale value.
    drainingSince = null;
    drainingDeadlineMs = null;
    detachedSince = null;
    setPhase('attached');
    upsertSearchAttributes({
      ClaudeTempoAttachedHost: [host],
      ClaudeTempoAttachmentId: [newAttachment.attachmentId],
    });
    lastActivityTime = nowMs;
    activityCount++;
    return attachmentTokenFrom(newAttachment, leaseMs);
  }, {
    validator: ({ leaseMs }) => {
      if (!Number.isInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 600_000) {
        throw ApplicationFailure.nonRetryable(
          `leaseMs must be between 1000 and 600000, got ${leaseMs}`,
          'InvalidLease',
        );
      }
    },
  });

  /**
   * `forceDetach` — revoke the current attachment. `expectedAttachmentId` guards against TOCTOU.
   * `gracePeriodMs` is reserved for future use (§8.3); v0.25 PR-A ignores it and detaches
   * immediately — PR-D's `restart` flow passes `gracePeriodMs: 0`.
   *
   * #159 Gap 2: this handler is the canonical "kill then flip" point. Before we null out
   * the attachment and transition to `detached`, we invoke `hardTerminateAttachment` on the
   * reaped host's per-host task queue so the child process tree is actually torn down at
   * the OS level. If the activity throws, the update itself throws and the caller
   * (`deliverRestart`, operator tooling) retries — we DON'T silently flip state while the
   * orphan is still alive, because that produces exactly the bug reported in #159.
   */
  setHandler(forceDetachUpdate, async ({ reason, expectedAttachmentId }) => {
    if (phase === 'gone') {
      throw ApplicationFailure.nonRetryable('Workflow is terminated', 'WorkflowGone');
    }
    if (!currentAttachment) {
      return { reaped: false };
    }
    if (expectedAttachmentId && currentAttachment.attachmentId !== expectedAttachmentId) {
      // TOCTOU — the expected attachment is already gone; don't reap a fresh one.
      return { reaped: false };
    }
    const reaped = currentAttachment;
    const previousId = reaped.attachmentId;

    // Kill OS process tree on the host where the adapter is actually running. In
    // production `reaped.hostname === input.metadata.hostname` — both are the machine
    // that spawned the child — but `metadata.hostname` is the more stable routing key
    // (attachments can come and go during cross-host restart flows, and test harnesses
    // sometimes set the two fields independently). Failure aborts the update so the
    // workflow state stays in sync with what actually happened on the host.
    const killHost = input.metadata.hostname;
    try {
      const killResult: HardTerminateResult = await getHardTerminateProxy(killHost)({
        ensemble: input.metadata.ensemble,
        playerName: input.metadata.playerId,
        agent: (input.metadata.agentType ?? 'claude') as AgentType,
        workDir: input.metadata.workDir,
      });
      workflowLog.info(
        `forceDetach hard-terminate on ${killHost}: strategy=${killResult.strategy}, ` +
        `killedPids=[${killResult.killedPids.join(',')}]`,
      );
    } catch (err) {
      // Turn into an ApplicationFailure so the caller sees a clean retry signal rather
      // than a raw activity timeout / cancelation.
      throw ApplicationFailure.nonRetryable(
        `forceDetach hard-terminate failed on ${killHost}: ` +
        `${err instanceof Error ? err.message : String(err)}. ` +
        `Refusing to flip phase to detached while the OS process may still be live.`,
        'HardTerminateFailed',
      );
    }

    lastAdapterMeta = { hostname: reaped.hostname, adapterId: reaped.adapterId };
    lastDetachReason = reason;
    currentAttachment = null;
    inFlightMessages.clear();
    processingSince = null;
    drainingSince = null;
    drainingDeadlineMs = null;
    detachedSince = workflowNow().toISOString();
    setPhase('detached');
    upsertSearchAttributes({
      ClaudeTempoAttachedHost: [''],
      ClaudeTempoAttachmentId: [''],
    });
    // #159 Gap 1b: wake the main loop — `phase === 'detached'` isn't in the predicate
    // and the condition would otherwise sleep on the now-stale lease-expiry deadline.
    wakeEpoch++;
    return { reaped: true, previousAttachmentId: previousId };
  });

  /**
   * Enqueue a spawn outbox entry carrying the claim token. PR-C commit 6 (#118)
   * replaced the double-cast `type: 'recruit'` workaround with a dedicated
   * `SpawnOutboxEntry` discriminated-union variant. The dispatch branch
   * (`case 'spawn':` below) routes through `startRecruitedSession` today and
   * will be extended by PR-D to forward `attachmentId`/`runId`/`resume`/
   * `sessionId`/`adapterId` into the activity signature so the adapter boots
   * into the pre-claimed attachment.
   */
  setHandler(enqueueSpawnUpdate, ({ host, attachmentId, runId, resume, sessionId, adapterId, agentDefinition, agentDefinitionPath, nativeResolvable }) => {
    const spawnEntryId = uuid4();
    const entry: SpawnOutboxEntry = {
      id: spawnEntryId,
      type: 'spawn',
      targetName: input.metadata.playerId,
      workDir: input.metadata.workDir,
      isConductor: input.metadata.isConductor,
      agent: (input.metadata.agentType ?? 'claude') as AgentType,
      targetHostname: host,
      attachmentId,
      attachmentRunId: runId,
      resumeAttachment: resume,
      sessionId,
      adapterId,
      agentDefinition,
      agentDefinitionPath,
      nativeResolvable,
      createdAt: workflowNow().toISOString(),
      status: 'pending',
    };
    outbox.push(entry);
    lastActivityTime = workflowNow().getTime();
    activityCount++;
    lastOutboundTime = workflowNow().getTime();
    return { spawnEntryId };
  });

  /** Record a preferred host. Used by `reconcileOnBoot` (§10) in later PRs. */
  setHandler(setPreferredHostUpdate, ({ host }) => {
    preferredHost = host;
    lastActivityTime = workflowNow().getTime();
    activityCount++;
  });

  /**
   * `heartbeat` signal — extend the lease. Last-write-wins via the `attachmentId` guard;
   * heartbeats for superseded attachments are ignored.
   */
  setHandler(heartbeatSignal, ({ attachmentId }) => {
    if (!currentAttachment || currentAttachment.attachmentId !== attachmentId) return;
    const now = workflowNow();
    currentAttachment.lastHeartbeatAt = now.toISOString();
    // #119a: extend by the caller-negotiated `leaseMs` stored on the attachment at
    // claim time, not a workflow-side default. Adapters with non-default lease windows
    // (e.g. test harnesses running accelerated clocks) get the lease duration they asked for.
    currentAttachment.expiresAt = new Date(now.getTime() + currentAttachment.leaseMs).toISOString();
    lastActivityTime = now.getTime();
    activityCount++;
  });

  /**
   * `requestDetach` signal — adapter-initiated graceful detach. Transitions to `draining`;
   * main loop reaps to `detached` when outbox is drained OR `drainingDeadline` elapses.
   *
   * Fix for #159 Gap 1a: previously this handler destructured only `reason` and threw away
   * `deadlineMs`, so the workflow always used `DEFAULT_DRAINING_DEADLINE_MS` regardless of
   * what the caller requested. We now store the caller's window in `drainingDeadlineMs` so
   * `nextDeadlineMs()` and the §9.5.c reap block honor it.
   *
   * Fix for #159 Gap 1b: bumping `wakeEpoch` causes the main-loop `condition(...)` predicate
   * to flip, waking it from its pre-existing (longer) timer so it re-computes `nextDeadlineMs()`
   * with the fresh, sooner drainingDeadline. Without this, the signal lands while the loop is
   * asleep on a lease-expiry timer and the phase stays in `draining` until that far-away
   * timer fires — exactly the smoke-test repro in #159.
   */
  setHandler(requestDetachSignal, ({ reason, deadlineMs }) => {
    if (!currentAttachment || phase === 'gone') return;
    if (phase === 'draining' || phase === 'detached') return; // idempotent
    drainingSince = workflowNow().toISOString();
    drainingDeadlineMs =
      typeof deadlineMs === 'number' && Number.isFinite(deadlineMs) && deadlineMs >= 0
        ? deadlineMs
        : DEFAULT_DRAINING_DEADLINE_MS;
    lastDetachReason = reason;
    setPhase('draining');
    lastActivityTime = workflowNow().getTime();
    activityCount++;
    wakeEpoch++;
  });

  /**
   * `adapterExited` signal — collapses `draining → detached` immediately if `attachmentId` matches.
   */
  setHandler(adapterExitedSignal, ({ attachmentId, reason }) => {
    if (phase === 'detached' || phase === 'gone') return;
    if (!currentAttachment || currentAttachment.attachmentId !== attachmentId) return;
    lastAdapterMeta = { hostname: currentAttachment.hostname, adapterId: currentAttachment.adapterId };
    lastDetachReason = reason;
    currentAttachment = null;
    inFlightMessages.clear();
    processingSince = null;
    drainingSince = null;
    drainingDeadlineMs = null;
    detachedSince = workflowNow().toISOString();
    setPhase('detached');
    upsertSearchAttributes({
      ClaudeTempoAttachedHost: [''],
      ClaudeTempoAttachmentId: [''],
    });
    lastActivityTime = workflowNow().getTime();
    activityCount++;
    // Wake main loop; the pre-existing condition timer was sized for the old lease
    // window which no longer applies.
    wakeEpoch++;
  });

  /** `attachmentInfo` query — current phase + attachment state snapshot. */
  setHandler(attachmentInfoQuery, (): AttachmentInfo => ({
    phase,
    ...(currentAttachment ? { currentAttachment } : {}),
    ...(preferredHost ? { preferredHost } : {}),
    inFlightCount: inFlightMessages.size,
    ...(processingSince ? { processingSince } : {}),
  }));

  /** `orphanSummary` query — daemon/CLI restore metadata when phase === 'detached'. */
  setHandler(orphanSummaryQuery, (): OrphanSummary => ({
    ensemble: input.metadata.ensemble,
    playerId: input.metadata.playerId,
    ...(detachedSince ? { detachedSince } : {}),
    ...(lastDetachReason ? { reason: lastDetachReason } : {}),
    ...(preferredHost ? { preferredHost } : {}),
    ...(lastAdapterMeta ? { lastAdapter: lastAdapterMeta } : {}),
  }));

  // ── Conductor State ──

  const commandHistory: Command[] = input.commandHistory ?? [];
  const reportHistory: PlayerReport[] = input.reportHistory ?? [];
  const qualityGates: QualityGate[] = input.qualityGates ?? [];
  const worktrees: WorktreeEntry[] = input.worktrees ?? [];
  const stages: StageEntry[] = input.stages ?? [];

  // ── Conductor-specific Handlers ──

  if (input.metadata.isConductor) {

    setHandler(commandSignal, (cmd) => {
      commandHistory.push({
        ...cmd,
        timestamp: workflowNow().toISOString(),
      });
      // Deliver command as a message to self so the conductor's Claude session sees it
      messages.push({
        id: uuid4(),
        from: cmd.source,
        text: cmd.text,
        timestamp: workflowNow().toISOString(),
        delivered: false,
      });
      // Command processing counts as implicit outbound for blocked detection
      lastActivityTime = workflowNow().getTime();
      activityCount++;
      lastOutboundTime = workflowNow().getTime();
    });

    setHandler(playerReportSignal, (report) => {
      reportHistory.push({
        ...report,
        timestamp: workflowNow().toISOString(),
      });
      // Deliver report as a message to self
      messages.push({
        id: uuid4(),
        from: report.playerId,
        text: `[${report.type}] ${report.text}`,
        timestamp: workflowNow().toISOString(),
        delivered: false,
      });

      // ── Stage tracking: update player status in any active stage ──
      for (const stage of stages) {
        if (stage.status !== 'active') continue;

        const playerEntry = stage.players.find((p) => p.playerId === report.playerId);
        if (!playerEntry || playerEntry.status !== 'waiting') continue;

        const now = workflowNow().toISOString();

        if (report.type === 'result') {
          playerEntry.status = 'reported';
          playerEntry.reportType = 'result';
          playerEntry.reportText = report.text;
          playerEntry.reportedAt = now;
        } else if (report.type === 'blocker') {
          playerEntry.status = 'blocked';
          playerEntry.reportType = 'blocker';
          playerEntry.reportText = report.text;
          playerEntry.reportedAt = now;

          // Halt policy: fail stage immediately on any blocker
          if (stage.failurePolicy === 'halt') {
            stage.status = 'failed';
            stage.completedAt = now;
            messages.push({
              id: uuid4(),
              from: '_stage',
              text: `[stage failed] "${stage.name}" halted — ${report.playerId} reported blocker: ${report.text}`,
              timestamp: now,
              delivered: false,
            });
            continue; // Don't check completion for a failed stage
          }
        } else {
          // 'question' or 'update' — no stage effect, player is still working
          continue;
        }

        // Check if all players in the stage are done (reported or blocked)
        const allDone = stage.players.every((p) => p.status !== 'waiting');
        if (allDone) {
          const blocked = stage.players.filter((p) => p.status === 'blocked');
          if (blocked.length > 0) {
            // Some players blocked (continue policy — didn't halt above)
            stage.status = 'failed';
            stage.completedAt = now;
            const blockerNames = blocked.map((p) => p.playerId).join(', ');
            messages.push({
              id: uuid4(),
              from: '_stage',
              text: `[stage failed] "${stage.name}" completed with ${blocked.length} blocker(s): ${blockerNames}`,
              timestamp: now,
              delivered: false,
            });
          } else {
            // All players reported successfully
            stage.status = 'complete';
            stage.completedAt = now;
            messages.push({
              id: uuid4(),
              from: '_stage',
              text: `[stage complete] "${stage.name}" — all ${stage.players.length} players reported successfully.`,
              timestamp: now,
              delivered: false,
            });
          }
        }
      }
    });

    setHandler(historyQuery, (): HistoryEntry[] => {
      const entries: HistoryEntry[] = [
        ...commandHistory.map((c): HistoryEntry => ({
          type: 'command',
          timestamp: c.timestamp,
          data: c,
        })),
        ...reportHistory.map((r): HistoryEntry => ({
          type: 'report',
          timestamp: r.timestamp,
          data: r,
        })),
      ];
      return entries.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    });

    // ── Quality Gate Handlers ──

    /** Derive aggregate gate status from individual criteria. */
    function deriveGateStatus(gate: QualityGate): 'open' | 'passed' | 'failed' {
      if (gate.criteria.length === 0) return 'open';
      if (gate.criteria.some((c) => c.status === 'failed')) return 'failed';
      if (gate.criteria.every((c) => c.status === 'passed')) return 'passed';
      return 'open';
    }

    setHandler(setQualityGateSignal, ({ task, criteria, createdBy }) => {
      const existing = qualityGates.findIndex((g) => g.task === task);
      const gate: QualityGate = {
        task,
        criteria: criteria.map((text) => ({ text, status: 'pending' as const })),
        createdBy,
        createdAt: workflowNow().toISOString(),
        status: 'open',
      };
      if (existing >= 0) {
        qualityGates[existing] = gate;
      } else {
        qualityGates.push(gate);
      }
    });

    setHandler(evaluateGateCriteriaSignal, ({ task, evaluations, evaluatedBy }) => {
      const gate = qualityGates.find((g) => g.task === task);
      if (!gate) return;
      const now = workflowNow().toISOString();
      for (const ev of evaluations) {
        if (ev.index >= 0 && ev.index < gate.criteria.length) {
          gate.criteria[ev.index].status = ev.status;
          gate.criteria[ev.index].evaluatedBy = evaluatedBy;
          gate.criteria[ev.index].evaluatedAt = now;
          if (ev.notes) gate.criteria[ev.index].notes = ev.notes;
        }
      }
      gate.status = deriveGateStatus(gate);
    });

    setHandler(qualityGatesQuery, () => qualityGates);

    // ── Worktree Handlers ──

    setHandler(setWorktreeSignal, (entry: WorktreeEntry) => {
      const existing = worktrees.findIndex((w) => w.player === entry.player);
      if (existing >= 0) {
        worktrees[existing] = entry;
      } else {
        worktrees.push(entry);
      }
    });

    setHandler(removeWorktreeSignal, (playerName: string) => {
      const idx = worktrees.findIndex((w) => w.player === playerName);
      if (idx >= 0) {
        worktrees.splice(idx, 1);
      }
    });

    setHandler(worktreesQuery, () => worktrees);

    // ── Stage Handlers ──

    setHandler(setStageSignal, ({ name, players, failurePolicy, createdBy }) => {
      const entry: StageEntry = {
        name,
        players: players.map((playerId) => ({
          playerId,
          status: 'waiting' as const,
        })),
        status: 'active',
        failurePolicy: failurePolicy || 'halt',
        createdAt: workflowNow().toISOString(),
        createdBy,
      };
      const existing = stages.findIndex((s) => s.name === name);
      if (existing >= 0) {
        stages[existing] = entry;
      } else {
        stages.push(entry);
      }
    });

    setHandler(cancelStageSignal, (name: string) => {
      const stage = stages.find((s) => s.name === name);
      if (stage && stage.status === 'active') {
        stage.status = 'cancelled';
        stage.completedAt = workflowNow().toISOString();
        // Notify conductor
        messages.push({
          id: uuid4(),
          from: '_stage',
          text: `[stage cancelled] "${name}" was cancelled.`,
          timestamp: workflowNow().toISOString(),
          delivered: false,
        });
      }
    });

    setHandler(stagesQuery, () => stages);
  }

  // ── Main Loop ──
  //
  // v0.25 design §9.5: the loop is a deadline-race. On each iteration we wait for
  //   - an outbox dispatch opportunity, OR
  //   - a phase transition condition wake, OR
  //   - the nearest time-based deadline (lease expiry, processingDeadline, drainingDeadline).
  // On wake, we handle time-based deadlines first (§9.5.a–c), then dispatch outbox entries,
  // then run the legacy stale/blocked heuristics (shim until PR-C), then check continueAsNew.
  //
  // The only exit from this loop is `destroyRequested === true` — the workflow never
  // COMPLETEs implicitly per design §2.2 invariant 2. `destroyRequested` is set
  // exclusively by the `destroyUpdate` handler (PR-H removed the
  // `updateMetadata({ status: 'terminated' })` compat shim that previously also
  // routed onto this flag).

  const hasPendingOutbox = () => outbox.some((e) => e.status === 'pending');
  /** Stop entries bypass pause — they must always be dispatched. */
  const hasPendingStop = () => outbox.some((e) => e.status === 'pending' && e.type === 'stop');
  const canDispatch = () => !outboxLocked && !paused && hasPendingOutbox();

  while (!destroyRequested) {
    // Deadline race: wake on outbox, phase change, destroy, or the nearest time deadline.
    //
    // #159 Gap 1b: `wakeEpoch` is captured here and included in the predicate so any handler
    // that mutates the deadline landscape (e.g. `requestDetach` setting a draining window)
    // can force re-entry to this loop *before* the pre-scheduled timeout fires. Without
    // this, a detach signal landing while the loop is asleep on a far-away lease-expiry
    // timer would leave the workflow in `draining` until that old timer fired.
    const epochAtWait = wakeEpoch;
    const deadlineMs = nextDeadlineMs();
    // NOTE: This 5-min fallback wake is LOAD-BEARING despite an old "PR-C shim"
    // framing that surfaced in researcher's tier-2 cleanup audit (2026-04-26).
    // While #175 removed the legacy stale/blocked detection block this originally
    // fed (see ~§1527 below), the wake itself remains essential as the loop's
    // periodic re-evaluation tick for state changes from handlers that mutate
    // `nextDeadlineMs()` inputs WITHOUT bumping `wakeEpoch`:
    //
    //   - `claimAttachmentUpdate` (renewal + fresh paths) — sets
    //     `currentAttachment.expiresAt` → new lease-expiry deadline
    //   - `processingStartUpdate` — sets `processingSince` → new
    //     `PROCESSING_DEADLINE_MS` deadline
    //   - `processingEndUpdate` — clears `processingSince` → cancels processing
    //     deadline
    //   - `destroyUpdate` (async hard-terminate-then-flip path)
    //
    // Without the fallback wake, a workflow waiting in `condition(predicate)` on
    // an `Infinity` deadline (booting / detached, no draining, no processing)
    // never re-evaluates `nextDeadlineMs()` after one of these handlers fires —
    // the freshly-set lease-expiry timer is never picked up, lease expiry is
    // never reaped, and the workflow stalls until external state forces the
    // predicate true. Smoking-gun test that fails without the fallback:
    // `test/session-phase-processing.test.ts:54` "attached -> processing ->
    // awaiting via processingStart/End (#117 fix)" — times out at 10s because
    // the loop never makes progress after `processingStart` lands on a fresh
    // claim.
    //
    // Removing this fallback safely is a "main-loop wake-discipline cleanup"
    // separate from the audit's framing — adds `wakeEpoch++` to each affected
    // handler, gates with `patched()` markers for replay-determinism (live
    // workflow histories already recorded the existing `Timer 5min` events),
    // and adds a regression test covering the handler-induced-deadline pickup.
    // Estimated 4–6 handler edits + tests, separate dedicated PR. See the
    // 2026-04-26 forensics for the full mechanism walkthrough — link from this
    // file's PR history.
    //
    // Until that cleanup happens, DO NOT remove this fallback. The
    // `Math.min(deadlineMs, 5 * 60 * 1000)` cap is part of the same mechanism:
    // it ensures every deadline (even hour-long lease-expiry timers) is
    // re-evaluated at least every 5 min so handler-induced deadline shortenings
    // can't be missed.
    const conditionPromise = condition(
      () =>
        destroyRequested ||
        canDispatch() ||
        hasPendingStop() ||
        phase === 'gone' ||
        wakeEpoch !== epochAtWait,
      deadlineMs === Number.POSITIVE_INFINITY ? '5 minutes' : Math.min(deadlineMs, 5 * 60 * 1000),
    );
    await conditionPromise;

    if (destroyRequested) break;

    // ── §9.5.a: Lease expiry — reap attachment and transition to `detached`. ──
    if (currentAttachment && new Date(currentAttachment.expiresAt).getTime() <= workflowNow().getTime()) {
      const reaped = currentAttachment;
      lastAdapterMeta = { hostname: reaped.hostname, adapterId: reaped.adapterId };
      lastDetachReason = 'heartbeat-timeout';
      currentAttachment = null;
      inFlightMessages.clear();
      processingSince = null;
      drainingSince = null;
      drainingDeadlineMs = null;
      detachedSince = workflowNow().toISOString();
      setPhase('detached');
      upsertSearchAttributes({
        ClaudeTempoAttachedHost: [''],
        ClaudeTempoAttachmentId: [''],
      });
      workflowLog.warn(`lease expired for attachment ${reaped.attachmentId} (host=${reaped.hostname})`);
    }

    // ── §9.5.b: processingDeadline — force exit from `processing` if a messageId is wedged. ──
    if (
      processingSince !== null &&
      workflowNow().getTime() - new Date(processingSince).getTime() > PROCESSING_DEADLINE_MS
    ) {
      const abandoned = [...inFlightMessages];
      workflowLog.warn(
        `processingDeadline exceeded (${Math.round(PROCESSING_DEADLINE_MS / 1000)}s); ` +
        `ejecting ${abandoned.length} in-flight message(s): ${abandoned.join(', ')}`,
      );
      inFlightMessages.clear();
      processingSince = null;
      if (phase === 'processing') setPhase('attached');
    }

    // ── §9.5.c: drainingDeadline — force exit from `draining` to `detached`. ──
    // #159 Gap 1a: use the caller-supplied `drainingDeadlineMs` when present; fall back to
    // `DEFAULT_DRAINING_DEADLINE_MS` otherwise. `nextDeadlineMs()` uses the same value, so
    // the condition wake timing and the reap threshold stay in sync.
    //
    // #159 Gap 2: before flipping to `detached`, kill the OS child process on the host
    // where the adapter was running. If we skipped this step the workflow would happily
    // report `phase=detached` while an orphaned `claude.exe` kept holding the session
    // lock — and the next `recruit`/`restart` would collide with its own past self.
    // Best-effort: errors from the activity are logged but don't block the state flip
    // (the alternative is a workflow wedged in `draining` forever when the host worker
    // is down, which is worse than a lingering process that operators can clean up).
    if (
      phase === 'draining' &&
      drainingSince !== null &&
      workflowNow().getTime() - new Date(drainingSince).getTime() >
        (drainingDeadlineMs ?? DEFAULT_DRAINING_DEADLINE_MS)
    ) {
      const window = drainingDeadlineMs ?? DEFAULT_DRAINING_DEADLINE_MS;
      const reaped = currentAttachment;
      if (reaped) {
        // Same routing consideration as in `forceDetachUpdate`: use `metadata.hostname`
        // as the stable key. Best-effort only — a failure here (e.g. host worker down)
        // would otherwise wedge the workflow in `draining` forever, which is worse than
        // a lingering OS process that operators can clean up by hand.
        const killHost = input.metadata.hostname;
        try {
          const killResult = await getHardTerminateProxy(killHost)({
            ensemble: input.metadata.ensemble,
            playerName: input.metadata.playerId,
            agent: (input.metadata.agentType ?? 'claude') as AgentType,
            workDir: input.metadata.workDir,
          });
          workflowLog.info(
            `drainingDeadline hard-terminate on ${killHost}: strategy=${killResult.strategy}, ` +
            `killedPids=[${killResult.killedPids.join(',')}]`,
          );
        } catch (err) {
          workflowLog.warn(
            `drainingDeadline hard-terminate failed for ${killHost} ` +
            `(continuing with state flip): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      lastDetachReason = lastDetachReason ?? 'force';
      currentAttachment = null;
      inFlightMessages.clear();
      processingSince = null;
      drainingSince = null;
      drainingDeadlineMs = null;
      detachedSince = workflowNow().toISOString();
      setPhase('detached');
      upsertSearchAttributes({
        ClaudeTempoAttachedHost: [''],
        ClaudeTempoAttachmentId: [''],
      });
      if (reaped) {
        workflowLog.info(
          `drainingDeadline exceeded (${Math.round(window / 1000)}s); ` +
          `reaping attachment ${reaped.attachmentId}`,
        );
      }
    }


    // ── Outbox Dispatch ──
    while (hasPendingOutbox() && !destroyRequested) {
      // When paused or locked, only dispatch stop entries (bypass)
      const nextEntry = (canDispatch())
        ? outbox.find((e) => e.status === 'pending')!
        : outbox.find((e) => e.status === 'pending' && e.type === 'stop') ?? null;
      if (!nextEntry) break;
      const entry = nextEntry;
      entry.status = 'processing';
      try {
        switch (entry.type) {
          case 'cue':
            await deliverCue({
              ensemble: input.metadata.ensemble,
              fromPlayerId: input.metadata.playerId,
              targetPlayerId: entry.targetPlayerId,
              message: entry.message,
              // #357: thread broadcast id so the target's `receiveMessage`
              // signal carries it onto the stored Message.
              ...(entry.broadcastId !== undefined ? { broadcastId: entry.broadcastId } : {}),
            });
            break;
          case 'report':
            await deliverReport({
              ensemble: input.metadata.ensemble,
              fromPlayerId: input.metadata.playerId,
              text: entry.text,
              reportType: entry.reportType,
            });
            break;
          case 'stop':
            await terminateSession({
              ensemble: input.metadata.ensemble,
              targetPlayerId: entry.targetPlayerId,
              terminatedBy: input.metadata.playerId,
            });
            break;
          case 'recruit': {
            const tc = input.temporalConfig;
            const recruitResult = await startRecruitedSession({
              ensemble: input.metadata.ensemble,
              targetName: entry.targetName,
              workDir: entry.workDir,
              isConductor: entry.isConductor,
              initialMessage: entry.initialMessage,
              fromPlayerId: input.metadata.playerId,
              agent: entry.agent,
              systemPrompt: entry.systemPrompt,
              taskQueue: tc?.taskQueue || 'claude-tempo',
              agentDefinition: entry.agentDefinition,
              agentDefinitionDescription: entry.agentDefinitionDescription,
              allowedTools: entry.allowedTools,
              claudeBin: entry.claudeBin,
              held: entry.held,
            });
            // Warm hold: process always spawns. When held, the workflow's outbox
            // is locked and the initial message is deferred until release.
            const targetHost = entry.targetHostname || input.metadata.hostname;
            const spawnFn = getSpawnProxy(targetHost);
            await spawnFn({
              targetName: entry.targetName,
              workDir: entry.workDir,
              isConductor: entry.isConductor,
              agent: entry.agent,
              systemPrompt: entry.systemPrompt,
              ensemble: input.metadata.ensemble,
              temporalAddress: tc?.temporalAddress || 'localhost:7233',
              temporalNamespace: tc?.temporalNamespace || 'default',
              agentDefinition: entry.agentDefinition,
              agentDefinitionPath: entry.agentDefinitionPath,
              nativeResolvable: entry.nativeResolvable,
              sessionId: recruitResult.sessionId,
              allowedTools: entry.allowedTools,
              claudeBin: entry.claudeBin,
              mockMode: entry.mockMode,
              mockScenario: entry.mockScenario,
            });
            break;
          }
          case 'release': {
            // Warm hold release — signal the target to unlock outbox and deliver held message.
            // No spawning needed — the process is already running.
            await releasePlayer({
              ensemble: input.metadata.ensemble,
              targetPlayerId: entry.targetPlayerId,
            });
            break;
          }
          case 'detach': {
            // PR-D: route the `detach` verb through the outbox (QA B1). The
            // activity resolves the target and signals `requestDetachSignal`.
            await deliverDetach({
              ensemble: input.metadata.ensemble,
              targetPlayerId: entry.targetPlayerId,
              ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
              ...(entry.deadlineMs !== undefined ? { deadlineMs: entry.deadlineMs } : {}),
            });
            break;
          }
          case 'destroy': {
            // PR-D: route the `destroy` verb through the outbox (QA B2).
            await deliverDestroy({
              ensemble: input.metadata.ensemble,
              targetPlayerId: entry.targetPlayerId,
              terminatedBy: input.metadata.playerId,
              ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
              ...(entry.notifyConductor !== undefined ? { notifyConductor: entry.notifyConductor } : {}),
            });
            break;
          }
          case 'restart': {
            // PR-D: route the `restart`/`migrate` verbs through the outbox
            // (QA B3). The activity owns the §8.2 algorithm: graceful detach
            // → optional force → claim → context replay → enqueueSpawn.
            await deliverRestart({
              ensemble: input.metadata.ensemble,
              targetPlayerId: entry.targetPlayerId,
              invokerPlayerId: entry.invokerPlayerId ?? input.metadata.playerId,
              ...(entry.force !== undefined ? { force: entry.force } : {}),
              ...(entry.host !== undefined ? { host: entry.host } : {}),
              ...(entry.fresh !== undefined ? { fresh: entry.fresh } : {}),
              ...(entry.contextMessages !== undefined ? { contextMessages: entry.contextMessages } : {}),
            });
            break;
          }
          case 'spawn': {
            // PR-D: forward the pre-claimed attachment token + pinned runId +
            // resolved adapterId to the spawn activity. The child process picks
            // these up from env in `BaseAttachment.startV2Lifecycle(workflowId,
            // expectedAttachmentId)` and renews the lease rather than claiming
            // fresh. Design §8.2 step 5.
            const spawnTc = input.temporalConfig;
            const spawnHost = entry.targetHostname;
            const spawnFn = getSpawnProxy(spawnHost);
            await spawnFn({
              targetName: entry.targetName,
              workDir: entry.workDir,
              isConductor: entry.isConductor,
              agent: entry.agent,
              ensemble: input.metadata.ensemble,
              temporalAddress: spawnTc?.temporalAddress || 'localhost:7233',
              temporalNamespace: spawnTc?.temporalNamespace || 'default',
              sessionId: entry.sessionId,
              resume: entry.resumeAttachment,
              attachmentId: entry.attachmentId,
              attachmentRunId: entry.attachmentRunId,
              adapterId: entry.adapterId,
              agentDefinition: entry.agentDefinition,
              agentDefinitionPath: entry.agentDefinitionPath,
              nativeResolvable: entry.nativeResolvable,
            });
            break;
          }
        }
        entry.status = 'delivered';
        entry.deliveredAt = workflowNow().toISOString();
      } catch (err) {
        entry.status = 'failed';
        entry.error = String(err);

        // PR-D §8.4: spawn-entry failure rollback. When `restart` or `migrate`
        // creates an attachment + enqueues a spawn, a subsequent spawn
        // activity failure leaves the session `attached` with no adapter — the
        // worst steady state. Force-detach the just-created attachment so the
        // session lands in `detached` and `restart` can be retried. Guard with
        // `expectedAttachmentId` (TOCTOU: another claim may have superseded).
        if (
          entry.type === 'spawn' &&
          entry.attachmentId &&
          currentAttachment?.attachmentId === entry.attachmentId
        ) {
          lastAdapterMeta = {
            hostname: currentAttachment.hostname,
            adapterId: currentAttachment.adapterId,
          };
          lastDetachReason = 'spawn-failed';
          currentAttachment = null;
          inFlightMessages.clear();
          processingSince = null;
          drainingSince = null;
          drainingDeadlineMs = null;
          detachedSince = workflowNow().toISOString();
          setPhase('detached');
          upsertSearchAttributes({
            ClaudeTempoAttachedHost: [''],
            ClaudeTempoAttachmentId: [''],
          });
          workflowLog.warn(
            `spawn failed for "${entry.targetName}"; rolled back attachment ${entry.attachmentId} → detached`,
          );
        }
      }
    }

    // ── §2.2 phase refinement: attached → awaiting when idle ──
    // Issue #117: after outbox drain completes, if the attachment is still held,
    // no messages are in flight, and no outbox entries are pending/processing,
    // the session is in its idle steady state. Transition to `awaiting` so
    // external observers (ClaudeTempoAttachmentState search attribute, TUI,
    // monitoring) see the correct phase. `processingStart` (line 502) already
    // guards for `awaiting`, so the next inbound message lifts us to `processing`.
    if (phase === 'attached' && inFlightMessages.size === 0) {
      const outboxIdle = !outbox.some(
        (e) => e.status === 'pending' || e.status === 'processing',
      );
      if (outboxIdle) setPhase('awaiting');
    }

    // Legacy stale/blocked detection + `_heartbeat`/`_ping` probe removed in #175.
    // The phase machine (lease expiry, `processingDeadline`, `adapterExited`) is now
    // the single source of liveness truth; see §§9.5.a/b above.

    // Prevent unbounded history growth — let the SDK decide when. The
    // `forceContinueAsNew` flag (#226 test-only) piggybacks on this branch so
    // the test fixture exercises the exact production CAN path, including the
    // §2.3 lease extension below.
    const info = workflowInfo();
    if (info.continueAsNewSuggested || forceContinueAsNew) {
      forceContinueAsNew = false;
      await condition(allHandlersFinished);

      // ── CAN-boundary lease extension (design §2.3) ──
      // The CAN transition is not instantaneous. If we write the old expiresAt into the
      // new execution and the transition takes ~100–500ms, the new execution's first main
      // loop check could reap a healthy attachment as expired. Extend the lease so a
      // normally-beating adapter has room to land its next heartbeat.
      //
      // #249 Bug 3: pre-fix this used a hardcoded 30s constant, but the claude-code
      // adapter's `heartbeatMs` is 60s → CAN would grant 30s of runway when the adapter
      // needed 60s minimum, so the first post-CAN main-loop tick reaped the healthy
      // attachment before its next heartbeat could land. Post-fix we use
      // `currentAttachment.leaseMs` (= 3 × heartbeatMs, negotiated at claim time) which
      // matches what the adapter signed up for and covers at least one full heartbeat
      // interval for every adapter class.
      //
      // The `patched()` gate keeps replay of pre-#249 workflow runs deterministic:
      // histories that CAN'd on the old bundle recorded `extendAttachmentForCAN(…, 30_000, …)`,
      // so replaying those runs must pick the legacy constant. New runs (and in-flight
      // runs that CAN *after* the deploy) take the patched branch.
      //
      // Math lives in `./attachment-math.ts` for direct unit testability (#127).
      //
      // #255 cleanup: the `patched()` call stays at the eager/unconditional
      // position it was introduced in — relocating it inside the
      // `currentAttachment ?` branch would skip marker recording on histories
      // that hit the CAN site with a null attachment, risking replay
      // non-determinism against those recordings. The dead-code cleanup is
      // strictly the removal of the `?? HEARTBEAT_INTERVAL_MS` fallback that
      // used to sit inside the ternary: on the patched branch it never fires
      // (Attachment.leaseMs is required), and on the pre-patched branch the
      // fallback is replaced by the bare constant — same value either way.
      const usePatchedLease = patched('v0.26-can-lease-from-attachment');
      const extendedAttachment = currentAttachment
        ? extendAttachmentForCAN(
            currentAttachment,
            usePatchedLease ? currentAttachment.leaseMs : HEARTBEAT_INTERVAL_MS,
            workflowNow().getTime(),
          )
        : undefined;

      await continueAsNew<typeof claudeSessionWorkflow>({
        ...input,
        part,
        messages: messages.filter((m) => !m.delivered),
        sentMessages: sentMessages.slice(-50),
        outbox: outbox.filter((e) => e.status === 'pending' || e.status === 'processing'),
        lastInboundRRTime,
        lastOutboundTime,
        // #399 W2 — counters carried across continueAsNew so the
        // dashboard's "Messages" + "tempo" surfaces stay monotonic.
        receivedCount,
        sentCount,
        activityCount,
        outboxLocked,
        heldMessage,
        paused,
        inFlightMessageIds: [...inFlightMessages],
        processingSince: processingSince ?? undefined,
        destroyed: destroyed || destroyRequested,
        // v0.25 attachment state — each carried forward with the lease extension applied.
        ...(extendedAttachment ? { currentAttachment: extendedAttachment } : {}),
        ...(preferredHost ? { preferredHost } : {}),
        phase,
        ...(drainingSince ? { drainingSince } : {}),
        ...(drainingDeadlineMs !== null ? { drainingDeadlineMs } : {}),
        ...(input.metadata.isConductor ? { commandHistory, reportHistory, qualityGates, worktrees, stages } : {}),
      });
    }
  }

  // ── Exit path ──
  // Single terminal state: `destroyRequested` (from the `destroy` update OR from the
  // quarantined `updateMetadata({ status: 'terminated' })` test-compat shim — both
  // route through §2.5 abandon-in-flight semantics). PR-C commit 4 retired the
  // v0.24 legacy 2-min drain-wait branch; callers expecting drain semantics should
  // request it before destroy (e.g. via `requestDetach` + wait for phase=detached).
  await condition(allHandlersFinished);

  // Finalize `destroyed = true` so `isDestroyed` queries against the completed run return true.
  destroyed = true;
}
