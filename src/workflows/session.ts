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
  Message,
  SentMessage,
  Command,
  PlayerReport,
  HistoryEntry,
  receiveMessageSignal,
  setPartSignal,
  setNameSignal,
  shutdownSignal,
  markDeliveredSignal,
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

  // State (carried across continue-as-new)
  let part = input.part ?? input.autoSummary ?? 'No description set';
  const messages: Message[] = input.messages ?? [];
  const sentMessages: SentMessage[] = input.sentMessages ?? [];
  let shuttingDown = false;
  let lastActivityTime = Date.now();

  // ── Player Signal Handlers ──

  setHandler(receiveMessageSignal, (msg) => {
    messages.push({
      id: uuid4(),
      from: msg.from,
      text: msg.text,
      timestamp: new Date().toISOString(),
      delivered: false,
    });
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

  setHandler(shutdownSignal, () => {
    shuttingDown = true;
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

  let staleExit = false;

  while (!shuttingDown) {
    await condition(() => shuttingDown, '5 minutes');

    if (shuttingDown) break;

    // Detect stale session: messages pending longer than threshold means poller is dead
    if (!input.disableStaleDetection) {
      const now = Date.now();
      const staleMessages = messages.filter(
        (m) => !m.delivered && now - new Date(m.timestamp).getTime() > STALE_MESSAGE_MS,
      );
      if (staleMessages.length > 0) {
        staleExit = true;
        break;
      }

      // Heartbeat: if no activity for 1 hour, inject a probe message.
      // If the session is alive, it will consume and deliver it.
      // If dead, stale detection will clean up on the next loop iteration.
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

  // Notify conductor with undelivered messages before exiting
  if (staleExit && !input.metadata.isConductor) {
    try {
      const undelivered = messages.filter((m) => !m.delivered);
      const summary = undelivered.map((m) => `  From ${m.from}: ${m.text}`).join('\n');
      const conductorWfId = `claude-session-${input.metadata.ensemble}-conductor`;
      const handle = getExternalWorkflowHandle(conductorWfId);
      await handle.signal(playerReportSignal, {
        playerId: input.metadata.playerId,
        text: `Session ended — ${undelivered.length} undelivered message(s):\n${summary}`,
        type: 'blocker',
      });
    } catch {
      // No conductor running — that's fine
    }
  }

  // Graceful shutdown — wait for in-flight handlers
  await condition(allHandlersFinished);
}
