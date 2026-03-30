import {
  setHandler,
  condition,
  continueAsNew,
  workflowInfo,
  allHandlersFinished,
  upsertSearchAttributes,
  uuid4,
} from '@temporalio/workflow';

import {
  SessionInput,
  Message,
  Command,
  PlayerReport,
  HistoryEntry,
  ConductorStatus,
  receiveMessageSignal,
  setPartSignal,
  setNameSignal,
  shutdownSignal,
  markDeliveredSignal,
  getPartQuery,
  getMetadataQuery,
  pendingMessagesQuery,
  commandSignal,
  playerReportSignal,
  statusQuery,
  historyQuery,
} from './signals';

export async function claudeSessionWorkflow(input: SessionInput): Promise<void> {
  // State (carried across continue-as-new)
  let part = input.part ?? input.autoSummary ?? 'No description set';
  const messages: Message[] = input.messages ?? [];
  let shuttingDown = false;

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
  });

  setHandler(setNameSignal, (newName) => {
    input.metadata.playerId = newName;
    upsertSearchAttributes({ ClaudeTempoPlayerId: [newName] });
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
  });

  // ── Player Query Handlers ──

  setHandler(getPartQuery, () => part);
  setHandler(getMetadataQuery, () => input.metadata);
  setHandler(pendingMessagesQuery, () => messages.filter((m) => !m.delivered));

  // ── Conductor-specific Handlers ──

  if (input.metadata.isConductor) {
    const commandHistory: Command[] = [];
    const reportHistory: PlayerReport[] = [];

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

    setHandler(statusQuery, (): ConductorStatus => ({
      ensemble: [], // Populated by the MCP server via listWorkflows, not the workflow itself
      activeTasks: [],
      lastUpdate: new Date().toISOString(),
    }));

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

  while (!shuttingDown) {
    await condition(() => shuttingDown, '1 minute');

    // Prevent unbounded history growth
    const info = workflowInfo();
    if (info.continueAsNewSuggested || info.historyLength > 10_000) {
      await condition(allHandlersFinished);
      await continueAsNew<typeof claudeSessionWorkflow>({
        ...input,
        part,
        messages: messages.filter((m) => !m.delivered),
      });
    }
  }

  // Graceful shutdown — wait for in-flight handlers
  await condition(allHandlersFinished);
}
