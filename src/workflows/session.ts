import {
  setHandler,
  condition,
  continueAsNew,
  workflowInfo,
  allHandlersFinished,
  upsertSearchAttributes,
  getExternalWorkflowHandle,
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

import {
  SessionInput,
  SessionStatus,
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
  checkAndSetStatusUpdate,
  submitOutboxUpdate,
  outboxQuery,
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
} from './signals';
import type {
  Attachment,
  AttachmentPhase,
  AttachmentToken,
  AttachmentInfo,
  AdapterClass,
  DetachReason,
  OrphanSummary,
} from '../types';

// ── Outbox Activity Proxies ──

const { deliverCue, deliverReport, terminateSession, startRecruitedSession, performEncore, releasePlayer } =
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

export async function claudeSessionWorkflow(input: SessionInput): Promise<void> {
  // ── Legacy timers (shim era only; removed in PR-C when all adapters cut over) ──
  // Stale-by-undelivered is now gated on no in-flight messages AND the legacy status
  // shim. Heartbeat-as-probe-message is superseded by the attachment heartbeat signal.
  const STALE_MESSAGE_MS = 3 * 60 * 1000; // 3 minutes
  const HEARTBEAT_PROBE_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

  // ── v0.25 Attachment Lifecycle Timers (design §2.3, §9.5) ──
  /** Attachment lease duration. Renewed on each heartbeat signal. */
  const LEASE_MS = 90_000;
  /** Default heartbeat cadence (interactive). SDK adapters use 30s; descriptor-driven in PR-C. */
  const HEARTBEAT_INTERVAL_MS = 30_000;
  /** Max grace period for `draining → detached` transition after requestDetach. */
  const DRAINING_DEADLINE_MS = 5_000;
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

  // Ensure search attributes are always current — critical when reconnecting
  // via WorkflowIdConflictPolicy.USE_EXISTING, which skips the attributes
  // passed to client.workflow.start().
  upsertSearchAttributes({
    ClaudeTempoEnsemble: [input.metadata.ensemble],
    ClaudeTempoPlayerId: [input.metadata.playerId],
    ClaudeTempoHostname: [input.metadata.hostname],
    ...(input.metadata.gitRoot ? { ClaudeTempoGitRoot: [input.metadata.gitRoot] } : {}),
    ...(input.metadata.playerType ? { ClaudeTempoPlayerType: [input.metadata.playerType] } : {}),
    ClaudeTempoStatus: [input.metadata.status || 'active'],
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

  // ── Warm Hold + Pause State ──
  let outboxLocked = input.outboxLocked ?? false;
  let heldMessage: string | undefined = input.heldMessage;
  let paused = input.paused ?? false;

  // ── v0.25 Attachment Lifecycle State (design §2.2) ──
  /** Current attachment lease, or null when detached. */
  let currentAttachment: Attachment | null = input.currentAttachment ?? null;
  /** Current phase — authoritative post-v0.25. Legacy `input.metadata.status` is shimmed onto this. */
  let phase: AttachmentPhase = input.phase ?? (currentAttachment ? 'attached' : 'booting');
  /** Preferred host for daemon reconcile-on-boot auto-restore. */
  let preferredHost: string | undefined = input.preferredHost ?? currentAttachment?.hostname ?? input.metadata.hostname;
  /** ISO timestamp of when the current `draining` phase started. */
  let drainingSince: string | null = input.drainingSince ?? null;
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
  /**
   * ── Legacy Terminate State (shim; removed in PR-C) ──
   * v0.24 adapters request termination via `updateMetadata({ status: 'terminated' })`
   * and expect drain-wait semantics: workflow waits up to 2 min for delivery of pending
   * messages before completing. The shim keeps that graceful behavior so MVP adapter code
   * and tests keep working without the §2.5 destroy changes reverberating.
   */
  let legacyTerminateRequested = false;

  // ── Helpers ──

  /** Transition to a new phase, syncing the attachment search attribute. */
  function setPhase(next: AttachmentPhase): void {
    if (phase === next) return;
    phase = next;
    upsertSearchAttributes({ ClaudeTempoAttachmentState: [next] });
    lastActivityTime = workflowNow().getTime();
  }

  /** Build the token returned from `claimAttachment`. */
  function attachmentTokenFrom(a: Attachment): AttachmentToken {
    return {
      attachmentId: a.attachmentId,
      runId: a.runId,
      expiresAt: a.expiresAt,
      leaseMs: LEASE_MS,
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
      candidates.push(new Date(drainingSince).getTime() + DRAINING_DEADLINE_MS);
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

    // Record in sentMessages for history continuity
    if (entry.type === 'cue') {
      sentMessages.push({ id: entry.id, to: entry.targetPlayerId, text: entry.message, timestamp: entry.createdAt });
    } else if (entry.type === 'report') {
      sentMessages.push({ id: entry.id, to: 'conductor', text: `[${entry.reportType}] ${entry.text}`, timestamp: entry.createdAt });
    } else if (entry.type === 'stop') {
      sentMessages.push({ id: entry.id, to: entry.targetPlayerId, text: '[stop requested]', timestamp: entry.createdAt });
    } else if (entry.type === 'encore') {
      sentMessages.push({ id: entry.id, to: entry.targetPlayerId, text: '[encore requested]', timestamp: entry.createdAt });
    } else if (entry.type === 'release') {
      sentMessages.push({ id: entry.id, to: entry.targetPlayerId, text: '[release requested]', timestamp: entry.createdAt });
    }

    lastActivityTime = workflowNow().getTime();
    lastOutboundTime = workflowNow().getTime();
    // Legacy-compat: auto-recover from v0.24 `blocked` status when player sends outbound.
    // The phase machine replaces this with `attachmentInfo` — but the shim keeps
    // the legacy status search attr consistent for tools still reading it.
    if (input.metadata.status === 'blocked') {
      input.metadata.status = 'active';
      upsertSearchAttributes({ ClaudeTempoStatus: ['active'] });
    }
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
    });
    lastActivityTime = workflowNow().getTime();
    // Track inbound messages that expect a response (default: true for backward compat)
    if (patched('v0.20-response-requested-blocked') && msg.responseRequested !== false) {
      lastInboundRRTime = workflowNow().getTime();
    }
  });

  setHandler(setPartSignal, (newPart) => {
    part = newPart;
    lastActivityTime = workflowNow().getTime();
    lastOutboundTime = workflowNow().getTime();
  });

  setHandler(setNameSignal, (newName) => {
    input.metadata.playerId = newName;
    upsertSearchAttributes({ ClaudeTempoPlayerId: [newName] });
    lastActivityTime = workflowNow().getTime();
  });

  setHandler(markDeliveredSignal, (ids) => {
    for (const msg of messages) {
      if (ids.includes(msg.id)) {
        msg.delivered = true;
      }
    }
    // Any delivery proves the session is alive
    lastActivityTime = workflowNow().getTime();
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
    if (update.status != null) {
      const legacyStatus = update.status as SessionStatus;
      input.metadata.status = legacyStatus;
      // Re-enable stale detection only when explicitly requested (server.ts sets this)
      if (update.enableStaleDetection) input.disableStaleDetection = false;
      // ── v0.25 legacy-status shim ──
      // Translate the old single-status signal onto the attachment phase machine so
      // adapters that haven't migrated to the new wire protocol keep working through
      // PR-B/C. Removed in PR-C when src/channel.ts and src/copilot-bridge.ts are
      // rewritten against the attachment surface directly.
      if (legacyStatus === 'terminated') {
        // Old adapters route clean shutdown through here. v0.25 semantics for the NEW
        // `destroy` update are "abandon in-flight and COMPLETE" (§2.5) — but legacy callers
        // expect drain-wait semantics. The shim preserves the graceful-drain path so MVP
        // adapters (and their tests) keep working. Direct `destroy` callers get §2.5 timing.
        legacyTerminateRequested = true;
        if (currentAttachment) {
          lastAdapterMeta = { hostname: currentAttachment.hostname, adapterId: currentAttachment.adapterId };
          lastDetachReason = 'destroy';
          currentAttachment = null;
        }
        // Phase transitions to 'detached' so attachmentInfo reflects the legacy-terminated state;
        // the main-loop exit + drain-wait happens from the `legacyTerminateRequested` branch.
        upsertSearchAttributes({
          ClaudeTempoAttachedHost: [''],
          ClaudeTempoAttachmentId: [''],
        });
        setPhase('detached');
        detachedSince = workflowNow().toISOString();
        messages.push({
          id: uuid4(),
          from: update.terminatedBy || 'system',
          text: 'Your session is being terminated by ' + (update.terminatedBy || 'system') + '.',
          timestamp: workflowNow().toISOString(),
          delivered: false,
        });
      } else if (legacyStatus === 'active' || legacyStatus === 'pending') {
        // v0.24 MCP server signals `status: 'active'` post-connect. In the shim era,
        // synthesize a claim so the phase machine reflects liveness without requiring
        // the legacy adapter to speak the new wire protocol.
        if (!currentAttachment && phase !== 'gone') {
          const now = workflowNow();
          const newAttachment: Attachment = {
            attachmentId: uuid4(),
            hostname: input.metadata.hostname,
            adapterId: input.metadata.agentType ?? 'claude',
            adapterClass: input.metadata.agentType === 'copilot' ? 'sdk' : 'interactive',
            claimedAt: now.toISOString(),
            lastHeartbeatAt: now.toISOString(),
            expiresAt: new Date(now.getTime() + LEASE_MS).toISOString(),
            runId: workflowInfo().runId,
          };
          currentAttachment = newAttachment;
          lastAdapterMeta = { hostname: newAttachment.hostname, adapterId: newAttachment.adapterId };
          preferredHost = newAttachment.hostname;
          setPhase('attached');
          upsertSearchAttributes({
            ClaudeTempoAttachedHost: [newAttachment.hostname],
            ClaudeTempoAttachmentId: [newAttachment.attachmentId],
          });
          detachedSince = null;
        }
      }
      // legacyStatus === 'stale' or 'blocked' → handled by legacy status search attr only;
      // the phase machine treats these as presentation refinements of `detached` / `attached`.
    }
    upsertSearchAttributes({
      ClaudeTempoEnsemble: [input.metadata.ensemble],
      ClaudeTempoPlayerId: [input.metadata.playerId],
      ClaudeTempoHostname: [input.metadata.hostname],
      ...(input.metadata.gitRoot ? { ClaudeTempoGitRoot: [input.metadata.gitRoot] } : {}),
      ...(input.metadata.playerType ? { ClaudeTempoPlayerType: [input.metadata.playerType] } : {}),
      ClaudeTempoStatus: [input.metadata.status || 'active'],
      ClaudeTempoIsConductor: [input.metadata.isConductor === true],
    });
    lastActivityTime = workflowNow().getTime();
  });

  // Atomic status transition — shimmed in v0.25 for the `performEncore` activity which
  // still uses the legacy status CAS pattern. Removed when `encore` tool is deleted in PR-D.
  // Supported transitions (all others return false):
  //   stale → pending : ensure workflow is detached (no attachment); reset legacy status
  setHandler(checkAndSetStatusUpdate, ({ expectedStatus, newStatus }) => {
    if (input.metadata.status !== expectedStatus) return false;
    input.metadata.status = newStatus as SessionStatus;
    upsertSearchAttributes({ ClaudeTempoStatus: [newStatus] });
    lastActivityTime = workflowNow().getTime();
    return true;
  });

  setHandler(recordSentMessageSignal, (msg) => {
    sentMessages.push({
      id: uuid4(),
      to: msg.to,
      text: msg.text,
      timestamp: workflowNow().toISOString(),
    });
  });

  // ── Player Query Handlers ──

  setHandler(getPartQuery, () => part);
  setHandler(getMetadataQuery, () => input.metadata);
  setHandler(pendingMessagesQuery, () => messages.filter((m) => !m.delivered));
  setHandler(allMessagesQuery, () => messages);
  setHandler(allSentMessagesQuery, () => sentMessages);

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
    return { inFlightCount: inFlightMessages.size };
  }, {
    validator: ({ messageId }) => {
      if (!messageId || typeof messageId !== 'string') {
        throw ApplicationFailure.nonRetryable(
          'processingStart requires a non-empty messageId',
          'InvalidMessageId',
        );
      }
      if (destroyed || destroyRequested) {
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
      // Phase: back to `attached` (or `awaiting` if the outbox is empty; that refinement
      // happens in the main loop based on outbox state).
      if (phase === 'processing') setPhase('attached');
    }
    lastActivityTime = workflowNow().getTime();
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

  setHandler(destroyUpdate, ({ reason, terminatedBy }) => {
    if (phase === 'gone') return; // idempotent
    destroyRequested = true;
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
    // Revoke attachment (if any) — record metadata for orphanSummary/audit.
    if (currentAttachment) {
      lastAdapterMeta = { hostname: currentAttachment.hostname, adapterId: currentAttachment.adapterId };
      lastDetachReason = 'destroy';
      currentAttachment = null;
    }
    // Legacy-compat: keep ClaudeTempoStatus tracking so old tools see `terminated`.
    input.metadata.status = 'terminated';
    upsertSearchAttributes({
      ClaudeTempoStatus: ['terminated'],
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
  });

  setHandler(isDestroyedQuery, () => destroyed || destroyRequested);

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
      lastActivityTime = nowMs;
      return attachmentTokenFrom(currentAttachment);
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
      runId: workflowInfo().runId,
    };
    currentAttachment = newAttachment;
    lastAdapterMeta = { hostname: newAttachment.hostname, adapterId: newAttachment.adapterId };
    preferredHost = host;
    // Fresh claim abandons any residual in-flight messageIds from the previous adapter.
    inFlightMessages.clear();
    processingSince = null;
    detachedSince = null;
    setPhase('attached');
    upsertSearchAttributes({
      ClaudeTempoAttachedHost: [host],
      ClaudeTempoAttachmentId: [newAttachment.attachmentId],
    });
    lastActivityTime = nowMs;
    return attachmentTokenFrom(newAttachment);
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
   */
  setHandler(forceDetachUpdate, ({ reason, expectedAttachmentId }) => {
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
    const previousId = currentAttachment.attachmentId;
    lastAdapterMeta = { hostname: currentAttachment.hostname, adapterId: currentAttachment.adapterId };
    lastDetachReason = reason;
    currentAttachment = null;
    inFlightMessages.clear();
    processingSince = null;
    drainingSince = null;
    detachedSince = workflowNow().toISOString();
    setPhase('detached');
    upsertSearchAttributes({
      ClaudeTempoAttachedHost: [''],
      ClaudeTempoAttachmentId: [''],
    });
    return { reaped: true, previousAttachmentId: previousId };
  });

  /** Enqueue a spawn outbox entry carrying the claim token. */
  setHandler(enqueueSpawnUpdate, ({ host, attachmentId, runId, resume, sessionId, adapterId }) => {
    const spawnEntryId = uuid4();
    // We ride on the existing outbox as a typed 'recruit' entry with resume semantics.
    // PR-D's `restart` will use a dedicated `spawn` entry type; for PR-A we thread through
    // the existing recruit dispatch.
    const entry = {
      id: spawnEntryId,
      type: 'recruit' as const,
      targetName: input.metadata.playerId,
      workDir: input.metadata.workDir,
      isConductor: input.metadata.isConductor,
      agent: (input.metadata.agentType ?? 'claude') as 'claude' | 'copilot',
      initialMessage: undefined,
      targetHostname: host,
      attachmentId,
      attachmentRunId: runId,
      resumeAttachment: resume,
      sessionId,
      adapterId,
      createdAt: workflowNow().toISOString(),
      status: 'pending' as const,
    } as unknown as OutboxEntry;
    outbox.push(entry);
    lastActivityTime = workflowNow().getTime();
    lastOutboundTime = workflowNow().getTime();
    return { spawnEntryId };
  });

  /** Record a preferred host. Used by `reconcileOnBoot` (§10) in later PRs. */
  setHandler(setPreferredHostUpdate, ({ host }) => {
    preferredHost = host;
    lastActivityTime = workflowNow().getTime();
  });

  /**
   * `heartbeat` signal — extend the lease. Last-write-wins via the `attachmentId` guard;
   * heartbeats for superseded attachments are ignored.
   */
  setHandler(heartbeatSignal, ({ attachmentId }) => {
    if (!currentAttachment || currentAttachment.attachmentId !== attachmentId) return;
    const now = workflowNow();
    currentAttachment.lastHeartbeatAt = now.toISOString();
    currentAttachment.expiresAt = new Date(now.getTime() + LEASE_MS).toISOString();
    lastActivityTime = now.getTime();
  });

  /**
   * `requestDetach` signal — adapter-initiated graceful detach. Transitions to `draining`;
   * main loop reaps to `detached` when outbox is drained OR `drainingDeadline` elapses.
   */
  setHandler(requestDetachSignal, ({ reason }) => {
    if (!currentAttachment || phase === 'gone') return;
    if (phase === 'draining' || phase === 'detached') return; // idempotent
    drainingSince = workflowNow().toISOString();
    lastDetachReason = reason;
    setPhase('draining');
    lastActivityTime = workflowNow().getTime();
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
    detachedSince = workflowNow().toISOString();
    setPhase('detached');
    upsertSearchAttributes({
      ClaudeTempoAttachedHost: [''],
      ClaudeTempoAttachmentId: [''],
    });
    lastActivityTime = workflowNow().getTime();
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
  // COMPLETEs implicitly per design §2.2 invariant 2. Legacy callers that send
  // `updateMetadata({ status: 'terminated' })` are shimmed into `destroyRequested`.

  const hasPendingOutbox = () => outbox.some((e) => e.status === 'pending');
  /** Stop entries bypass pause — they must always be dispatched. */
  const hasPendingStop = () => outbox.some((e) => e.status === 'pending' && e.type === 'stop');
  const canDispatch = () => !outboxLocked && !paused && hasPendingOutbox();

  while (!destroyRequested && !legacyTerminateRequested) {
    // Deadline race: wake on outbox, phase change, destroy, or the nearest time deadline.
    const deadlineMs = nextDeadlineMs();
    const conditionPromise = condition(
      () => destroyRequested || legacyTerminateRequested || canDispatch() || hasPendingStop() || phase === 'gone',
      // Legacy shim: when no time-based deadline applies, still wake every 5 min so the
      // legacy stale/blocked heuristics below run. Replaced with a no-op in PR-C.
      deadlineMs === Number.POSITIVE_INFINITY ? '5 minutes' : Math.min(deadlineMs, 5 * 60 * 1000),
    );
    await conditionPromise;

    if (destroyRequested || legacyTerminateRequested) break;

    // ── §9.5.a: Lease expiry — reap attachment and transition to `detached`. ──
    if (currentAttachment && new Date(currentAttachment.expiresAt).getTime() <= workflowNow().getTime()) {
      const reaped = currentAttachment;
      lastAdapterMeta = { hostname: reaped.hostname, adapterId: reaped.adapterId };
      lastDetachReason = 'heartbeat-timeout';
      currentAttachment = null;
      inFlightMessages.clear();
      processingSince = null;
      drainingSince = null;
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
    if (
      phase === 'draining' &&
      drainingSince !== null &&
      workflowNow().getTime() - new Date(drainingSince).getTime() > DRAINING_DEADLINE_MS
    ) {
      const reaped = currentAttachment;
      lastDetachReason = lastDetachReason ?? 'force';
      currentAttachment = null;
      inFlightMessages.clear();
      processingSince = null;
      drainingSince = null;
      detachedSince = workflowNow().toISOString();
      setPhase('detached');
      upsertSearchAttributes({
        ClaudeTempoAttachedHost: [''],
        ClaudeTempoAttachmentId: [''],
      });
      if (reaped) {
        workflowLog.info(
          `drainingDeadline exceeded (${Math.round(DRAINING_DEADLINE_MS / 1000)}s); ` +
          `reaping attachment ${reaped.attachmentId}`,
        );
      }
    }


    // ── Outbox Dispatch ──
    while (hasPendingOutbox() && !destroyRequested && !legacyTerminateRequested) {
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
            });
            break;
          }
          case 'encore': {
            const encoreResult = await performEncore({
              ensemble: input.metadata.ensemble,
              targetPlayerId: entry.targetPlayerId,
              fromPlayerId: input.metadata.playerId,
              contextMessageCount: entry.contextMessageCount,
            });
            const encoreHost = entry.targetHostname || encoreResult.hostname;
            const encoreSpawnFn = getSpawnProxy(encoreHost);
            try {
              await encoreSpawnFn({
                targetName: entry.targetPlayerId,
                workDir: encoreResult.workDir,
                isConductor: encoreResult.isConductor,
                agent: encoreResult.agent,
                ensemble: input.metadata.ensemble,
                temporalAddress: encoreResult.temporalAddress,
                temporalNamespace: encoreResult.temporalNamespace,
                agentDefinition: encoreResult.agentDefinition,
                agentDefinitionPath: encoreResult.agentDefinitionPath,
                nativeResolvable: encoreResult.nativeResolvable,
                allowedTools: encoreResult.allowedTools,
                sessionId: encoreResult.sessionId,
                resume: true,
                claudeBin: entry.claudeBin || encoreResult.claudeBin,
              });
            } catch (spawnErr) {
              // Spawn failed after status was reset to pending — revert to stale
              // so the target isn't stuck in pending with no running process
              try {
                // Workflow ID format is hardcoded here because workflow code cannot
                // import config helpers (they depend on Node APIs unavailable in the
                // Temporal sandbox). Mirrors sessionWorkflowId/conductorWorkflowId.
                const targetWfId = encoreResult.isConductor
                  ? `claude-session-${input.metadata.ensemble}-conductor`
                  : `claude-session-${input.metadata.ensemble}-${entry.targetPlayerId}`;
                const targetHandle = getExternalWorkflowHandle(targetWfId);
                await targetHandle.signal('updateMetadata', { status: 'stale' });
              } catch {
                // Best-effort revert — target workflow may have terminated
              }
              throw spawnErr;
            }
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
        }
        entry.status = 'delivered';
        entry.deliveredAt = workflowNow().toISOString();
      } catch (err) {
        entry.status = 'failed';
        entry.error = String(err);
      }
    }

    // ── Legacy stale / blocked detection (shim, removed in PR-C) ──
    //
    // The phase machine's lease-expiry + processingDeadline (handled above in §9.5.a/b)
    // replaces this heuristic. We keep it so existing tools that read
    // `ClaudeTempoStatus` get consistent values while adapters migrate.
    //
    // Suppression rules preserved from MVP:
    //   - `inFlightMessages` non-empty → don't flag stale (would trigger #99 again)
    //   - `phase === 'attached' | 'processing' | 'awaiting'` → treat like alive
    if (!input.disableStaleDetection) {
      const now = workflowNow().getTime();
      const processingInFlight = inFlightMessages.size > 0;
      const attachmentAlive = phase === 'attached' || phase === 'processing' || phase === 'awaiting';

      const staleMessages = messages.filter(
        (m) => !m.delivered && now - new Date(m.timestamp).getTime() > STALE_MESSAGE_MS,
      );
      const stuckPending = input.metadata.status === 'pending' && now - lastActivityTime > STALE_MESSAGE_MS;
      if (
        !processingInFlight &&
        !attachmentAlive &&
        (staleMessages.length > 0 || stuckPending) &&
        input.metadata.status !== 'stale'
      ) {
        input.metadata.status = 'stale';
        upsertSearchAttributes({ ClaudeTempoStatus: ['stale'] });
      }

      const BLOCKED_WINDOW_MS = 5 * 60 * 1000;
      if (
        input.metadata.status === 'active' &&
        lastInboundRRTime > lastOutboundTime &&
        now - lastInboundRRTime > BLOCKED_WINDOW_MS
      ) {
        input.metadata.status = 'blocked';
        upsertSearchAttributes({ ClaudeTempoStatus: ['blocked'] });
      }

      // Legacy heartbeat probe — kept for old adapters that rely on periodic message flow.
      // The v0.25 attachment `heartbeat` signal is the real liveness channel; this probe
      // exists only so the MVP `_heartbeat`/`_ping` pattern in tests keeps working.
      const noPending = messages.every((m) => m.delivered);
      if (noPending && now - lastActivityTime > HEARTBEAT_PROBE_INTERVAL_MS) {
        messages.push({
          id: uuid4(),
          from: '_heartbeat',
          text: '_ping',
          timestamp: workflowNow().toISOString(),
          delivered: false,
        });
      }
    }

    // Prevent unbounded history growth — let the SDK decide when.
    const info = workflowInfo();
    if (info.continueAsNewSuggested) {
      await condition(allHandlersFinished);

      // ── CAN-boundary lease extension (design §2.3) ──
      // The CAN transition is not instantaneous. If we write the old expiresAt into the
      // new execution and the transition takes ~100–500ms, the new execution's first main
      // loop check could reap a healthy attachment as expired. Extend the lease by one
      // heartbeat interval so a normally-beating adapter has room to land its next heartbeat.
      const extendedAttachment = currentAttachment
        ? {
            ...currentAttachment,
            lastHeartbeatAt: workflowNow().toISOString(),
            expiresAt: new Date(workflowNow().getTime() + HEARTBEAT_INTERVAL_MS).toISOString(),
          }
        : undefined;

      await continueAsNew<typeof claudeSessionWorkflow>({
        ...input,
        part,
        messages: messages.filter((m) => !m.delivered),
        sentMessages: sentMessages.slice(-50),
        outbox: outbox.filter((e) => e.status === 'pending' || e.status === 'processing'),
        lastInboundRRTime,
        lastOutboundTime,
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
        ...(input.metadata.isConductor ? { commandHistory, reportHistory, qualityGates, worktrees, stages } : {}),
      });
    }
  }

  // ── Exit paths ──
  // Two terminal states:
  //   1. `destroyRequested` (from the `destroy` update) — §2.5 semantics: abandon in-flight,
  //      COMPLETE immediately.
  //   2. `legacyTerminateRequested` (from `updateMetadata({ status: 'terminated' })`) —
  //      shim preserves v0.24 graceful drain-wait so MVP adapters keep working.
  await condition(allHandlersFinished);

  if (legacyTerminateRequested && !destroyRequested && !input.disableStaleDetection) {
    // Legacy graceful drain — up to 2 minutes for the adapter to mark pending messages
    // delivered. The shim's backward-compat contract.
    const allDelivered = () => messages.every((m) => m.delivered);
    await condition(allDelivered, '2 minutes');
  }

  // Finalize `destroyed = true` so `isDestroyed` queries against the completed run return true.
  destroyed = true;
}
