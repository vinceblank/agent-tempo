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
  EnsembleChatMessage,
  ChatHighWater,
  ZERO_CHAT_HIGH_WATER,
  maestroShutdownSignal,
  maestroPlayersQuery,
  maestroEventsQuery,
  maestroPendingCommandsQuery,
  maestroEnsembleChatQuery,
  maestroSendCommandUpdate,
  maestroSetPausedSignal,
  maestroPausedQuery,
  // Global Maestro signals/queries/updates
  maestroNotifyMessageSignal,
  maestroEnsemblesQuery,
  maestroPlayersByEnsembleQuery,
  maestroRecentMessagesQuery,
  maestroSendMessageUpdate,
  maestroFetchPlayerMessagesUpdate,
  maestroFetchConductorHistoryUpdate,
  maestroGlobalSendCommandUpdate,
  // #274 — host discovery
  hostProfileSignal,
  hostProfilesQuery,
  // #280 — combined existence + profiles query
  hostProfilesWithExistenceQuery,
} from './maestro-signals';
import type { HostProfile } from '../types';

// ── Activity Proxies ──
// Only proxy activities actually used in the workflow.
// fetchConductorHistory is available in the activities but reserved for Phase 2 (TUI).

const { refreshEnsembleState, relayCommandToConductor, fetchEnsembleChat } =
  proxyActivities<Pick<MaestroActivities, 'refreshEnsembleState' | 'relayCommandToConductor' | 'fetchEnsembleChat'>>({
    startToCloseTimeout: '30 seconds',
    retry: { maximumAttempts: 3 },
  });

const DEFAULT_REFRESH_INTERVAL_MS = 5_000; // 5 seconds
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
  let cachedChat: EnsembleChatMessage[] = input.cachedChat ?? [];
  let cachedChatMeta = input.cachedChatMeta ?? { hasConductor: false };
  let chatHighWater: ChatHighWater = input.chatHighWater ?? ZERO_CHAT_HIGH_WATER;
  let shutdownRequested = false;
  let commandQueued = false;
  let lastActiveSessionTime = Date.now();
  let ensemblePaused = input.paused ?? false;

  // ── Signal Handlers ──

  setHandler(maestroShutdownSignal, () => {
    shutdownRequested = true;
  });

  setHandler(maestroSetPausedSignal, (value: boolean) => {
    ensemblePaused = value;
  });

  // ── Query Handlers ──

  setHandler(maestroPlayersQuery, () => players);
  setHandler(maestroEventsQuery, () => events);
  setHandler(maestroPendingCommandsQuery, () => pendingCommands);
  setHandler(maestroPausedQuery, () => ensemblePaused);
  setHandler(maestroEnsembleChatQuery, ({ offset = 0, limit = 50 } = {}) => {
    const clampedLimit = Math.min(limit, 200);
    const total = cachedChat.length;
    const end = Math.max(0, total - offset);
    const start = Math.max(0, end - clampedLimit);
    return {
      messages: cachedChat.slice(start, end),
      total,
      hasMore: start > 0,
      hasConductor: cachedChatMeta.hasConductor,
    };
  });

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
          // `status_changed` events fire on attachment-phase transitions; the
          // event name is kept for dashboard stability (MaestroEvent wire shape).
          if (old.phase !== player.phase) {
            events.push({
              type: 'status_changed',
              playerId: id,
              timestamp: now,
              oldValue: old.phase,
              newValue: player.phase,
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

      const eventsExcess = events.length - MAX_EVENTS;
      if (eventsExcess > 0) events.splice(0, eventsExcess);

      players = newPlayers;

      // Track last time we saw running sessions — phases the ensemble can
      // meaningfully coordinate with (attached/processing/awaiting/booting).
      const COORDINATABLE_PHASES: readonly string[] = ['attached', 'processing', 'awaiting', 'booting'];
      const hasRunningSessions = players.some(
        (p) => p.phase !== undefined && COORDINATABLE_PHASES.includes(p.phase),
      );
      if (hasRunningSessions) {
        lastActiveSessionTime = Date.now();
      }
    } catch {
      // Activity failure after retries — skip this cycle, try again next loop
    }

    // ── Refresh Ensemble Chat ──
    if (patched('v0.19-ensemble-chat')) {
      try {
        const chatResult = await fetchEnsembleChat({
          ensemble: input.ensemble,
          knownCounts: chatHighWater,
        });
        if (chatResult.success) {
          cachedChat.push(...chatResult.newMessages);
          const MAX_CACHED_CHAT = 500;
          const chatExcess = cachedChat.length - MAX_CACHED_CHAT;
          if (chatExcess > 0) cachedChat.splice(0, chatExcess);
          chatHighWater = chatResult.currentCounts;
          cachedChatMeta = { hasConductor: chatResult.hasConductor };
        }
      } catch {
        // Chat refresh failed — keep stale cache, retry next cycle
      }
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
        cachedChat,
        cachedChatMeta,
        chatHighWater,
        paused: ensemblePaused,
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
  // #274 — host capability ledger. Plain `Record<hostname, HostProfile>`
  // so CAN serialization is the default-converter happy path (Maps require
  // a codec tweak). Lazy GC of stale hosts happens at the `listHosts` join
  // site; the workflow itself just stores forever (or until CAN).
  const hostProfiles: Record<string, HostProfile> = { ...(input.hostProfiles ?? {}) };
  let shutdownRequested = false;
  let actionQueued = false;

  // ── Signal Handlers ──

  setHandler(maestroShutdownSignal, () => {
    shutdownRequested = true;
  });

  setHandler(maestroNotifyMessageSignal, (msg) => {
    recentMessages.push(msg);
    const msgExcess = recentMessages.length - GLOBAL_MAX_MESSAGES;
    if (msgExcess > 0) recentMessages.splice(0, msgExcess);
  });

  /**
   * #274 — daemon boot signal carrying the host's capability profile.
   *
   * Validation policy per architect delta AC3c (M9): ONLY `hostname` is
   * validated here (required, ≤64 chars, alphanumeric + `_-`). All other
   * fields are stored opaquely — the per-field Zod guard lives at the
   * `listHosts` join site in `src/utils/hosts.ts`, never at this
   * handler. This keeps the workflow additive-compatible across daemon
   * versions: a newer daemon can signal new fields and older maestros
   * will still accept the payload; an older daemon's payload is accepted
   * by a newer maestro without special-casing.
   *
   * The hostname regex is inlined (rather than importing from
   * `src/utils/validation.ts`) to keep the workflow bundle's import
   * surface narrow — it's pure constants either way.
   */
  setHandler(hostProfileSignal, (payload) => {
    if (!payload || typeof payload !== 'object') return;
    const hostname = (payload as { hostname?: unknown }).hostname;
    if (typeof hostname !== 'string') return;
    if (hostname.length === 0 || hostname.length > 64) return;
    if (!/^[a-zA-Z0-9_-]+$/.test(hostname)) return;
    // Cast is deliberate: `HostProfile` has an open `[extraField]: unknown`
    // index signature, so the spread is semantically safe. TypeScript can't
    // prove narrower optional fields from the spread alone.
    hostProfiles[hostname] = { ...payload, hostname } as HostProfile;
  });

  // ── Query Handlers ──

  setHandler(maestroEnsemblesQuery, () => knownEnsembles);
  setHandler(maestroPlayersByEnsembleQuery, () => ({ ...playersByEnsemble }));
  setHandler(maestroRecentMessagesQuery, () => recentMessages);
  setHandler(maestroEventsQuery, () => events);
  setHandler(maestroPendingCommandsQuery, () => pendingCommands);
  // Return a defensive copy so callers can't mutate workflow state.
  setHandler(hostProfilesQuery, () => ({ ...hostProfiles }));
  // #280 — combined query: reaching this handler proves the workflow is
  // running, so `exists` is always `true` here. Callers infer "missing"
  // by catching transport-level errors (workflow not found, etc.).
  setHandler(hostProfilesWithExistenceQuery, () => ({
    exists: true,
    profiles: { ...hostProfiles },
  }));

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
    const relayExcess = recentMessages.length - GLOBAL_MAX_MESSAGES;
    if (relayExcess > 0) recentMessages.splice(0, relayExcess);
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
            // Diffs attachment-phase values (see per-ensemble Maestro comment).
            if (old.phase !== player.phase) {
              events.push({ type: 'status_changed', playerId: id, timestamp: now, oldValue: old.phase, newValue: player.phase });
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

    const globalEventsExcess = events.length - GLOBAL_MAX_EVENTS;
    if (globalEventsExcess > 0) events.splice(0, globalEventsExcess);

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
        // #274 — carry the capability ledger across the CAN boundary so
        // hosts that signaled their profile in a prior execution don't
        // disappear on the next one (they won't re-signal until the next
        // daemon boot).
        hostProfiles,
      });
    }
  }

  // Graceful shutdown
  await condition(allHandlersFinished);
}
