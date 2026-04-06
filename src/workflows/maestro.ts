import {
  setHandler,
  condition,
  continueAsNew,
  workflowInfo,
  allHandlersFinished,
  proxyActivities,
  patched,
  uuid4,
} from '@temporalio/workflow';

import type { MaestroActivities } from '../activities/maestro';

import {
  MaestroPlayerInfo,
  MaestroEvent,
  MaestroPendingCommand,
  MaestroInput,
  MaestroRelayMessage,
  GlobalMaestroInput,
  maestroShutdownSignal,
  maestroPlayersQuery,
  maestroEventsQuery,
  maestroPendingCommandsQuery,
  maestroSendCommandUpdate,
  // Global Maestro signals/queries/updates
  maestroNotifyMessageSignal,
  maestroEnsemblesQuery,
  maestroPlayersByEnsembleQuery,
  maestroRecentMessagesQuery,
  maestroSendMessageUpdate,
  maestroFetchPlayerMessagesUpdate,
  maestroFetchConductorHistoryUpdate,
  maestroGlobalSendCommandUpdate,
} from './maestro-signals';

// ── Activity Proxies ──
// Only proxy activities actually used in the workflow.
// fetchConductorHistory is available in the activities but reserved for Phase 2 (TUI).

const { refreshEnsembleState, relayCommandToConductor } =
  proxyActivities<Pick<MaestroActivities, 'refreshEnsembleState' | 'relayCommandToConductor'>>({
    startToCloseTimeout: '30 seconds',
    retry: { maximumAttempts: 3 },
  });

const DEFAULT_REFRESH_INTERVAL_MS = 10_000; // 10 seconds
const MAX_EVENTS = 200;
const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes with no running sessions

// ══════════════════════════════════════════════════════════════════════════════
// Per-Ensemble Maestro (existing — unchanged)
// ══════════════════════════════════════════════════════════════════════════════

export async function claudeMaestroWorkflow(input: MaestroInput): Promise<void> {
  patched('v0.17-initial');

  const refreshIntervalMs = input.pollIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;

  let players: MaestroPlayerInfo[] = input.players ?? [];
  const events: MaestroEvent[] = input.events ?? [];
  const pendingCommands: MaestroPendingCommand[] = input.pendingCommands ?? [];
  let shutdownRequested = false;
  let commandQueued = false;
  let lastActiveSessionTime = Date.now();

  // ── Signal Handlers ──

  setHandler(maestroShutdownSignal, () => {
    shutdownRequested = true;
  });

  // ── Query Handlers ──

  setHandler(maestroPlayersQuery, () => players);
  setHandler(maestroEventsQuery, () => events);
  setHandler(maestroPendingCommandsQuery, () => pendingCommands);

  // ── Update Handler ──

  setHandler(maestroSendCommandUpdate, (cmd) => {
    const entry: MaestroPendingCommand = {
      id: uuid4(),
      text: cmd.text,
      source: cmd.source,
      replyTo: cmd.replyTo,
      createdAt: new Date().toISOString(),
      status: 'pending',
    };
    pendingCommands.push(entry);
    commandQueued = true;
    return entry.id;
  }, {
    validator: (cmd) => {
      if (!cmd.text || cmd.text.trim().length === 0) {
        throw new Error('Command text must not be empty');
      }
    },
  });

  // ── Main Loop ──

  while (!shutdownRequested) {
    // Wait for either the refresh interval or a queued command
    commandQueued = false;
    await condition(() => shutdownRequested || commandQueued, `${refreshIntervalMs} milliseconds`);

    if (shutdownRequested) break;

    // ── Refresh Ensemble State ──
    try {
      const newPlayers = await refreshEnsembleState(input.ensemble);
      const now = new Date().toISOString();

      // Diff snapshots to generate events
      const oldMap = new Map(players.map((p) => [p.playerId, p]));
      const newMap = new Map(newPlayers.map((p) => [p.playerId, p]));

      // Player joined
      for (const [id, player] of newMap) {
        if (!oldMap.has(id)) {
          events.push({ type: 'player_joined', playerId: id, timestamp: now });
        } else {
          const old = oldMap.get(id)!;
          // Status changed
          if (old.status !== player.status) {
            events.push({
              type: 'status_changed',
              playerId: id,
              timestamp: now,
              oldValue: old.status,
              newValue: player.status,
            });
          }
          // Part changed
          if (old.part !== player.part) {
            events.push({
              type: 'part_changed',
              playerId: id,
              timestamp: now,
              oldValue: old.part,
              newValue: player.part,
            });
          }
        }
      }

      // Player left
      for (const [id] of oldMap) {
        if (!newMap.has(id)) {
          events.push({ type: 'player_left', playerId: id, timestamp: now });
        }
      }

      // Trim events ring buffer
      while (events.length > MAX_EVENTS) {
        events.shift();
      }

      players = newPlayers;

      // Track last time we saw running (non-terminated) sessions
      const hasRunningSessions = players.some(
        (p) => p.status !== 'terminated' && p.status !== 'stale',
      );
      if (hasRunningSessions) {
        lastActiveSessionTime = Date.now();
      }
    } catch {
      // Activity failure after retries — skip this cycle, try again next loop
    }

    // ── Dispatch Pending Commands ──
    const pending = pendingCommands.filter((c) => c.status === 'pending');
    for (const cmd of pending) {
      cmd.status = 'delivered'; // optimistic — revert on failure
      try {
        const result = await relayCommandToConductor({
          ensemble: input.ensemble,
          text: cmd.text,
          source: cmd.source,
          replyTo: cmd.replyTo,
        });
        if (!result.success) {
          cmd.status = 'failed';
          cmd.error = result.error;
        }
      } catch (err) {
        cmd.status = 'failed';
        cmd.error = String(err);
      }
    }

    // ── Auto-terminate if idle ──
    if (Date.now() - lastActiveSessionTime > IDLE_TIMEOUT_MS) {
      break;
    }

    // ── ContinueAsNew if suggested ──
    const info = workflowInfo();
    if (info.continueAsNewSuggested) {
      await condition(allHandlersFinished);
      await continueAsNew<typeof claudeMaestroWorkflow>({
        ensemble: input.ensemble,
        players,
        events,
        // Only carry pending commands; delivered/failed are historical
        pendingCommands: pendingCommands.filter((c) => c.status === 'pending'),
        pollIntervalMs: input.pollIntervalMs,
      });
    }
  }

  // Graceful shutdown — wait for in-flight handlers
  await condition(allHandlersFinished);
}

// ══════════════════════════════════════════════════════════════════════════════
// Global Maestro — single instance handling ALL ensembles
// ══════════════════════════════════════════════════════════════════════════════

const GLOBAL_MAX_MESSAGES = 500;
const GLOBAL_MAX_EVENTS = 500;

const globalActivities = proxyActivities<
  Pick<MaestroActivities,
    | 'discoverEnsembles'
    | 'refreshEnsembleState'
    | 'relayCommandToConductor'
    | 'deliverMaestroMessage'
    | 'fetchPlayerMessages'
    | 'fetchConductorHistory'
  >
>({
  startToCloseTimeout: '30 seconds',
  retry: { maximumAttempts: 3 },
});

export async function claudeGlobalMaestroWorkflow(input: GlobalMaestroInput): Promise<void> {
  patched('v0.18-global-maestro');

  const refreshIntervalMs = input.pollIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;

  let knownEnsembles: string[] = input.knownEnsembles ?? [];
  let playersByEnsemble: Record<string, MaestroPlayerInfo[]> = input.playersByEnsemble ?? {};
  const recentMessages: MaestroRelayMessage[] = input.recentMessages ?? [];
  const events: MaestroEvent[] = input.events ?? [];
  const pendingCommands: MaestroPendingCommand[] = input.pendingCommands ?? [];
  let shutdownRequested = false;
  let actionQueued = false;

  // ── Signal Handlers ──

  setHandler(maestroShutdownSignal, () => {
    shutdownRequested = true;
  });

  setHandler(maestroNotifyMessageSignal, (msg) => {
    recentMessages.push(msg);
    while (recentMessages.length > GLOBAL_MAX_MESSAGES) {
      recentMessages.shift();
    }
  });

  // ── Query Handlers ──

  setHandler(maestroEnsemblesQuery, () => knownEnsembles);
  setHandler(maestroPlayersByEnsembleQuery, () => ({ ...playersByEnsemble }));
  setHandler(maestroRecentMessagesQuery, () => recentMessages);
  setHandler(maestroEventsQuery, () => events);
  setHandler(maestroPendingCommandsQuery, () => pendingCommands);

  // ── Update Handlers (can await activities) ──

  setHandler(maestroSendMessageUpdate, async (req) => {
    const msgId = uuid4();
    const result = await globalActivities.deliverMaestroMessage({
      ensemble: req.ensemble,
      to: req.to,
      text: req.text,
      source: req.source,
    });
    if (!result.success) {
      throw new Error(result.error ?? 'Failed to deliver message');
    }
    // Record in ring buffer
    const relayMsg: MaestroRelayMessage = {
      id: msgId,
      ensemble: req.ensemble,
      from: req.source,
      to: req.to,
      text: req.text,
      timestamp: new Date().toISOString(),
      direction: 'outbound',
    };
    recentMessages.push(relayMsg);
    while (recentMessages.length > GLOBAL_MAX_MESSAGES) {
      recentMessages.shift();
    }
    return msgId;
  }, {
    validator: (req) => {
      if (!req.ensemble || !req.ensemble.trim()) throw new Error('Ensemble must not be empty');
      if (!req.to || !req.to.trim()) throw new Error('Target player must not be empty');
      if (!req.text || !req.text.trim()) throw new Error('Message text must not be empty');
    },
  });

  setHandler(maestroFetchPlayerMessagesUpdate, async (req) => {
    const result = await globalActivities.fetchPlayerMessages({
      ensemble: req.ensemble,
      playerId: req.playerId,
    });
    if (!result.success) {
      throw new Error(result.error ?? 'Failed to fetch player messages');
    }
    return result.messages;
  }, {
    validator: (req) => {
      if (!req.ensemble || !req.ensemble.trim()) throw new Error('Ensemble must not be empty');
      if (!req.playerId || !req.playerId.trim()) throw new Error('Player ID must not be empty');
    },
  });

  setHandler(maestroFetchConductorHistoryUpdate, async (req) => {
    const result = await globalActivities.fetchConductorHistory({
      ensemble: req.ensemble,
    });
    return result;
  }, {
    validator: (req) => {
      if (!req.ensemble || !req.ensemble.trim()) throw new Error('Ensemble must not be empty');
    },
  });

  setHandler(maestroGlobalSendCommandUpdate, (cmd) => {
    const entry: MaestroPendingCommand = {
      id: uuid4(),
      text: cmd.text,
      source: cmd.source,
      replyTo: cmd.replyTo,
      createdAt: new Date().toISOString(),
      status: 'pending',
    };
    entry.ensemble = cmd.ensemble;
    pendingCommands.push(entry);
    actionQueued = true;
    return entry.id;
  }, {
    validator: (cmd) => {
      if (!cmd.ensemble || !cmd.ensemble.trim()) throw new Error('Ensemble must not be empty');
      if (!cmd.text || !cmd.text.trim()) throw new Error('Command text must not be empty');
    },
  });

  // ── Main Loop ──

  while (!shutdownRequested) {
    actionQueued = false;
    await condition(() => shutdownRequested || actionQueued, `${refreshIntervalMs} milliseconds`);

    if (shutdownRequested) break;

    // ── Discover ensembles ──
    try {
      knownEnsembles = await globalActivities.discoverEnsembles();
    } catch {
      // Discovery failed — use last known ensembles
    }

    // ── Refresh players per ensemble ──
    for (const ensemble of knownEnsembles) {
      try {
        const newPlayers = await globalActivities.refreshEnsembleState(ensemble);
        const oldPlayers = playersByEnsemble[ensemble] ?? [];
        const now = new Date().toISOString();

        // Diff snapshots to generate events
        const oldMap = new Map(oldPlayers.map((p) => [p.playerId, p]));
        const newMap = new Map(newPlayers.map((p) => [p.playerId, p]));

        for (const [id, player] of newMap) {
          if (!oldMap.has(id)) {
            events.push({ type: 'player_joined', playerId: id, timestamp: now });
          } else {
            const old = oldMap.get(id)!;
            if (old.status !== player.status) {
              events.push({ type: 'status_changed', playerId: id, timestamp: now, oldValue: old.status, newValue: player.status });
            }
            if (old.part !== player.part) {
              events.push({ type: 'part_changed', playerId: id, timestamp: now, oldValue: old.part, newValue: player.part });
            }
          }
        }
        for (const [id] of oldMap) {
          if (!newMap.has(id)) {
            events.push({ type: 'player_left', playerId: id, timestamp: now });
          }
        }

        playersByEnsemble[ensemble] = newPlayers;
      } catch {
        // Activity failure — keep last known state for this ensemble
      }
    }

    // Remove stale ensembles (no longer discovered)
    for (const key of Object.keys(playersByEnsemble)) {
      if (!knownEnsembles.includes(key)) {
        delete playersByEnsemble[key];
      }
    }

    // Trim events ring buffer
    while (events.length > GLOBAL_MAX_EVENTS) {
      events.shift();
    }

    // ── Dispatch Pending Commands ──
    const pending = pendingCommands.filter((c) => c.status === 'pending');
    for (const cmd of pending) {
      const ensemble = cmd.ensemble;
      if (!ensemble) {
        cmd.status = 'failed';
        cmd.error = 'Missing ensemble';
        continue;
      }
      cmd.status = 'delivered';
      try {
        const result = await globalActivities.relayCommandToConductor({
          ensemble,
          text: cmd.text,
          source: cmd.source,
          replyTo: cmd.replyTo,
        });
        if (!result.success) {
          cmd.status = 'failed';
          cmd.error = result.error;
        }
      } catch (err) {
        cmd.status = 'failed';
        cmd.error = String(err);
      }
    }

    // ── ContinueAsNew if suggested ──
    const info = workflowInfo();
    if (info.continueAsNewSuggested) {
      await condition(allHandlersFinished);
      await continueAsNew<typeof claudeGlobalMaestroWorkflow>({
        knownEnsembles,
        playersByEnsemble,
        recentMessages,
        events,
        pendingCommands: pendingCommands.filter((c) => c.status === 'pending'),
        pollIntervalMs: input.pollIntervalMs,
      });
    }
  }

  // Graceful shutdown
  await condition(allHandlersFinished);
}
