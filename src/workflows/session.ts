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
} from '@temporalio/workflow';

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
} from './signals';

// ── Outbox Activity Proxies ──

const { deliverCue, deliverReport, terminateSession, startRecruitedSession, performEncore } =
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
  const STALE_MESSAGE_MS = 3 * 60 * 1000; // 3 minutes

  const HEARTBEAT_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

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
  });

  // State (carried across continue-as-new)
  let part = input.part ?? input.autoSummary ?? 'No description set';
  const messages: Message[] = input.messages ?? [];
  const sentMessages: SentMessage[] = input.sentMessages ?? [];
  const outbox: OutboxEntry[] = input.outbox ?? [];
  let lastActivityTime = Date.now();
  let lastOutboundTime = input.lastOutboundTime ?? Date.now();
  let lastInboundRRTime = input.lastInboundRRTime ?? 0;

  // ── Outbox Update + Query Handlers ──

  setHandler(submitOutboxUpdate, (entryInput: OutboxEntryInput) => {
    const entry: OutboxEntry = {
      ...entryInput,
      id: uuid4(),
      createdAt: new Date().toISOString(),
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
    }

    lastActivityTime = Date.now();
    lastOutboundTime = Date.now();
    // Auto-recover from blocked when player sends outbound
    if (input.metadata.status === 'blocked') {
      input.metadata.status = 'active';
      upsertSearchAttributes({ ClaudeTempoStatus: ['active'] });
    }
    return entry.id;
  }, {
    validator: (entry: OutboxEntryInput) => {
      if (!entry.type) throw new Error('Outbox entry must have a type');
    },
  });

  setHandler(outboxQuery, () => outbox);

  // ── Player Signal Handlers ──

  setHandler(receiveMessageSignal, (msg) => {
    messages.push({
      id: uuid4(),
      from: msg.from,
      text: msg.text,
      timestamp: new Date().toISOString(),
      delivered: false,
      isMaestro: msg.isMaestro,
    });
    lastActivityTime = Date.now();
    // Track inbound messages that expect a response (default: true for backward compat)
    if (patched('v0.20-response-requested-blocked') && msg.responseRequested !== false) {
      lastInboundRRTime = Date.now();
    }
  });

  setHandler(setPartSignal, (newPart) => {
    part = newPart;
    lastActivityTime = Date.now();
    lastOutboundTime = Date.now();
  });

  setHandler(setNameSignal, (newName) => {
    input.metadata.playerId = newName;
    upsertSearchAttributes({ ClaudeTempoPlayerId: [newName] });
    lastActivityTime = Date.now();
  });

  setHandler(markDeliveredSignal, (ids) => {
    for (const msg of messages) {
      if (ids.includes(msg.id)) {
        msg.delivered = true;
      }
    }
    // Any delivery proves the session is alive
    lastActivityTime = Date.now();
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
      input.metadata.status = update.status as SessionStatus;
      // Re-enable stale detection only when explicitly requested (server.ts sets this)
      if (update.enableStaleDetection) input.disableStaleDetection = false;
      // Graceful termination: add termination message so the session sees it
      if (update.status === 'terminated') {
        messages.push({
          id: uuid4(),
          from: update.terminatedBy || 'system',
          text: 'Your session is being terminated by ' + (update.terminatedBy || 'system') + '.',
          timestamp: new Date().toISOString(),
          delivered: false,
        });
      }
    }
    upsertSearchAttributes({
      ClaudeTempoEnsemble: [input.metadata.ensemble],
      ClaudeTempoPlayerId: [input.metadata.playerId],
      ClaudeTempoHostname: [input.metadata.hostname],
      ...(input.metadata.gitRoot ? { ClaudeTempoGitRoot: [input.metadata.gitRoot] } : {}),
      ...(input.metadata.playerType ? { ClaudeTempoPlayerType: [input.metadata.playerType] } : {}),
      ClaudeTempoStatus: [input.metadata.status || 'active'],
    });
    lastActivityTime = Date.now();
  });

  // Atomic status transition — used by encore to prevent double-spawn races
  setHandler(checkAndSetStatusUpdate, ({ expectedStatus, newStatus }) => {
    if (input.metadata.status !== expectedStatus) return false;
    input.metadata.status = newStatus as SessionStatus;
    upsertSearchAttributes({ ClaudeTempoStatus: [newStatus] });
    lastActivityTime = Date.now();
    return true;
  });

  setHandler(recordSentMessageSignal, (msg) => {
    sentMessages.push({
      id: uuid4(),
      to: msg.to,
      text: msg.text,
      timestamp: new Date().toISOString(),
    });
  });

  // ── Player Query Handlers ──

  setHandler(getPartQuery, () => part);
  setHandler(getMetadataQuery, () => input.metadata);
  setHandler(pendingMessagesQuery, () => messages.filter((m) => !m.delivered));
  setHandler(allMessagesQuery, () => messages);
  setHandler(allSentMessagesQuery, () => sentMessages);

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
        timestamp: new Date().toISOString(),
      });
      // Deliver command as a message to self so the conductor's Claude session sees it
      messages.push({
        id: uuid4(),
        from: cmd.source,
        text: cmd.text,
        timestamp: new Date().toISOString(),
        delivered: false,
      });
      // Command processing counts as implicit outbound for blocked detection
      lastActivityTime = Date.now();
      lastOutboundTime = Date.now();
    });

    setHandler(playerReportSignal, (report) => {
      reportHistory.push({
        ...report,
        timestamp: new Date().toISOString(),
      });
      // Deliver report as a message to self
      messages.push({
        id: uuid4(),
        from: report.playerId,
        text: `[${report.type}] ${report.text}`,
        timestamp: new Date().toISOString(),
        delivered: false,
      });

      // ── Stage tracking: update player status in any active stage ──
      for (const stage of stages) {
        if (stage.status !== 'active') continue;

        const playerEntry = stage.players.find((p) => p.playerId === report.playerId);
        if (!playerEntry || playerEntry.status !== 'waiting') continue;

        const now = new Date().toISOString();

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
        createdAt: new Date().toISOString(),
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
      const now = new Date().toISOString();
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
        createdAt: new Date().toISOString(),
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
        stage.completedAt = new Date().toISOString();
        // Notify conductor
        messages.push({
          id: uuid4(),
          from: '_stage',
          text: `[stage cancelled] "${name}" was cancelled.`,
          timestamp: new Date().toISOString(),
          delivered: false,
        });
      }
    });

    setHandler(stagesQuery, () => stages);
  }

  // ── Main Loop ──

  const hasPendingOutbox = () => outbox.some((e) => e.status === 'pending');

  while (input.metadata.status !== 'terminated') {
    await condition(() => input.metadata.status === 'terminated' || hasPendingOutbox(), '5 minutes');

    // ── Outbox Dispatch ──
    while (hasPendingOutbox() && input.metadata.status as string !== 'terminated') {
      const entry = outbox.find((e) => e.status === 'pending')!;
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
            });
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
        }
        entry.status = 'delivered';
        entry.deliveredAt = new Date().toISOString();
      } catch (err) {
        entry.status = 'failed';
        entry.error = String(err);
      }
    }

    // Detect stale session: messages pending longer than threshold means poller is dead.
    // Also detect stuck pending: if status is still 'pending' after the threshold,
    // the spawned process never connected (prompt not acknowledged, crash, etc.).
    // Mark as stale so the workflow stays alive and can be reconnected later.
    if (!input.disableStaleDetection) {
      const now = Date.now();
      const staleMessages = messages.filter(
        (m) => !m.delivered && now - new Date(m.timestamp).getTime() > STALE_MESSAGE_MS,
      );
      const stuckPending = input.metadata.status === 'pending' && now - lastActivityTime > STALE_MESSAGE_MS;
      if ((staleMessages.length > 0 || stuckPending) && input.metadata.status !== 'stale') {
        input.metadata.status = 'stale';
        upsertSearchAttributes({ ClaudeTempoStatus: ['stale'] });
      }

      // Detect blocked session: active session that received a response-requested
      // message but has not produced any outbound activity for 5+ minutes.
      // Only messages with responseRequested !== false count as triggers.
      const BLOCKED_WINDOW_MS = 5 * 60 * 1000;
      if (
        input.metadata.status === 'active' &&
        lastInboundRRTime > lastOutboundTime &&
        now - lastInboundRRTime > BLOCKED_WINDOW_MS
      ) {
        input.metadata.status = 'blocked';
        upsertSearchAttributes({ ClaudeTempoStatus: ['blocked'] });
      }

      // Heartbeat: if no activity for 1 hour, inject a probe message.
      // If the session is alive, it will consume and deliver it.
      // If dead, stale detection will mark it on the next loop iteration.
      const noPending = messages.every((m) => m.delivered);
      if (noPending && now - lastActivityTime > HEARTBEAT_INTERVAL_MS) {
        messages.push({
          id: uuid4(),
          from: '_heartbeat',
          text: '_ping',
          timestamp: new Date().toISOString(),
          delivered: false,
        });
        // Heartbeat probes should not trigger blocked detection
        // (lastInboundRRTime is not updated — responseRequested is implicitly false)
      }
    }

    // Prevent unbounded history growth — let the SDK decide when
    const info = workflowInfo();
    if (info.continueAsNewSuggested) {
      await condition(allHandlersFinished);
      await continueAsNew<typeof claudeSessionWorkflow>({
        ...input,
        part,
        messages: messages.filter((m) => !m.delivered),
        sentMessages: sentMessages.slice(-50),
        outbox: outbox.filter((e) => e.status === 'pending' || e.status === 'processing'),
        lastInboundRRTime,
        lastOutboundTime,
        ...(input.metadata.isConductor ? { commandHistory, reportHistory, qualityGates, worktrees, stages } : {}),
      });
    }
  }

  // Graceful shutdown — wait for in-flight handlers
  await condition(allHandlersFinished);

  // If terminated, wait for the termination message to be delivered.
  // Skip in test mode (disableStaleDetection) since there's no message poller.
  if (input.metadata.status === 'terminated' && !input.disableStaleDetection) {
    const allDelivered = () => messages.every((m) => m.delivered);
    await condition(allDelivered, '2 minutes');
  }
}
