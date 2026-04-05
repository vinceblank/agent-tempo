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
  maestroShutdownSignal,
  maestroPlayersQuery,
  maestroEventsQuery,
  maestroPendingCommandsQuery,
  maestroSendCommandUpdate,
} from './maestro-signals';

// ── Activity Proxies ──
// Only proxy activities actually used in the workflow.
// fetchConductorHistory is available in the activities but reserved for Phase 2 (TUI).

const { refreshEnsembleState, relayCommandToConductor } =
  proxyActivities<Pick<MaestroActivities, 'refreshEnsembleState' | 'relayCommandToConductor'>>({
    startToCloseTimeout: '30 seconds',
    retry: { maximumAttempts: 3 },
  });

const REFRESH_INTERVAL_MS = 10_000; // 10 seconds
const MAX_EVENTS = 200;
const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes with no running sessions

export async function claudeMaestroWorkflow(input: MaestroInput): Promise<void> {
  patched('v0.17-initial');

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
    await condition(() => shutdownRequested || commandQueued, `${REFRESH_INTERVAL_MS} milliseconds`);

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
      });
    }
  }

  // Graceful shutdown — wait for in-flight handlers
  await condition(allHandlersFinished);
}
