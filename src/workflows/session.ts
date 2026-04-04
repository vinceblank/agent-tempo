import {
  setHandler,
  condition,
  continueAsNew,
  workflowInfo,
  allHandlersFinished,
  upsertSearchAttributes,
  getExternalWorkflowHandle,
  uuid4,
} from '@temporalio/workflow';

import {
  SessionInput,
  SessionStatus,
  Message,
  SentMessage,
  Command,
  PlayerReport,
  HistoryEntry,
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
} from './signals';

export async function claudeSessionWorkflow(input: SessionInput): Promise<void> {
  const STALE_MESSAGE_MS = 3 * 60 * 1000; // 3 minutes

  const HEARTBEAT_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

  // Ensure search attributes are always current — critical when reconnecting
  // via WorkflowIdConflictPolicy.USE_EXISTING, which skips the attributes
  // passed to client.workflow.start().
  upsertSearchAttributes({
    ClaudeTempoEnsemble: [input.metadata.ensemble],
    ClaudeTempoPlayerId: [input.metadata.playerId],
    ClaudeTempoHostname: [input.metadata.hostname],
    ...(input.metadata.gitRoot ? { ClaudeTempoGitRoot: [input.metadata.gitRoot] } : {}),
    ClaudeTempoStatus: [input.metadata.status || 'active'],
  });

  // State (carried across continue-as-new)
  let part = input.part ?? input.autoSummary ?? 'No description set';
  const messages: Message[] = input.messages ?? [];
  const sentMessages: SentMessage[] = input.sentMessages ?? [];
  let lastActivityTime = Date.now();

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
  });

  setHandler(setPartSignal, (newPart) => {
    part = newPart;
    lastActivityTime = Date.now();
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
      ClaudeTempoStatus: [input.metadata.status || 'active'],
    });
    lastActivityTime = Date.now();
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
  }

  // ── Main Loop ──

  while (input.metadata.status !== 'terminated') {
    await condition(() => input.metadata.status === 'terminated', '5 minutes');

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
        ...(input.metadata.isConductor ? { commandHistory, reportHistory } : {}),
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
