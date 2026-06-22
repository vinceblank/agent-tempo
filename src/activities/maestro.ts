import { Client } from '@temporalio/client';
import { ApplicationFailure, activityInfo } from '@temporalio/activity';
import { conductorWorkflowId, sessionWorkflowId } from '../config';
import { HistoryEntry, MaestroPlayerInfo, Message, SentMessage, EnsembleChatMessage, ChatHighWater, ZERO_CHAT_HIGH_WATER } from '../types';
import { scanEnsembleSessions, scanEnsembleSessionsCloud, resolveSession, type EnsembleSessionInfo } from './resolve';
import { tagActionSource } from '../utils/action-counters';
import {
  iterateWithDeadline,
  isVisibilityTimeout,
  VISIBILITY_DEADLINES_MS,
} from '../utils/visibility-deadline';

const log = (...args: unknown[]) => console.error('[agent-tempo:maestro]', ...args);

// ── Activity input types ──

export interface RelayCommandInput {
  ensemble: string;
  text: string;
  source: string;
  replyTo?: string;
}

export interface RelayCommandResult {
  success: boolean;
  error?: string;
}

export interface FetchConductorHistoryInput {
  ensemble: string;
}

export interface FetchConductorHistoryResult {
  success: boolean;
  history: HistoryEntry[];
  error?: string;
}

export interface DeliverMaestroMessageInput {
  ensemble: string;
  to: string;
  text: string;
  source: string;
}

export interface DeliverMaestroMessageResult {
  success: boolean;
  error?: string;
}

export interface FetchPlayerMessagesInput {
  ensemble: string;
  playerId: string;
}

export interface FetchPlayerMessagesResult {
  success: boolean;
  messages: Array<(Message & { direction?: 'received' }) | (SentMessage & { direction: 'sent' })>;
  error?: string;
}

export interface FetchEnsembleChatInput {
  ensemble: string;
  /** Known message counts to enable delta returns. */
  knownCounts?: ChatHighWater;
}

export interface FetchEnsembleChatResult {
  success: boolean;
  /** Only NEW messages since the known counts. */
  newMessages: EnsembleChatMessage[];
  /** Updated counts for next call. */
  currentCounts: ChatHighWater;
  hasConductor: boolean;
  error?: string;
}

/** T0.1 (#748) — result of the V2 refresh (cloud-profile maestros). */
export interface RefreshEnsembleStateV2Result {
  players: MaestroPlayerInfo[];
  /**
   * Whether the daemon currently has any live SSE subscriber (TUI, web
   * dashboard, mission-control board). Read in-process from the
   * AggregateRunner — zero Temporal cost. The maestro workflow stretches
   * its next refresh timer when nobody is watching. `true` when no
   * presence source is wired (fail-open: never stretch by accident).
   */
  observersPresent: boolean;
}

/**
 * T0.1 (#748) — daemon-side observer presence source. A mutable holder
 * because worker/activity construction happens BEFORE the daemon's
 * AggregateRunner exists; daemon.ts fills `current` in once the HTTP/SSE
 * plane is up (same late-wiring pattern as IngestTokenRegistry).
 */
export interface ObserverPresenceSource {
  current: (() => number) | null;
}

/** Options for {@link createMaestroActivities} (T0.1, #748). */
export interface MaestroActivityOptions {
  /** Daemon cost profile — drives the V2 scan strategy. Default 'local'. */
  costProfile?: 'local' | 'cloud';
  /** Late-wired SSE subscriber count source (see {@link ObserverPresenceSource}). */
  observerPresence?: ObserverPresenceSource;
}

/** Activity interface — used by proxyActivities in the Maestro workflow. */
export interface MaestroActivities {
  /**
   * Ensemble-scoped player scan. Returns the player rows plus `observersPresent`
   * (SSE subscriber presence) for workflow-side cadence stretching on the cloud
   * profile. Honors the daemon's cost profile internally: cloud → SA/memo
   * ensemble-scoped scan, local → the legacy visibility scan.
   *
   * 2.0 (#788): the only refresh activity — the former V1 `refreshEnsembleState`
   * was removed; both profiles call this (the A2 cutover means no pre-#748
   * maestro survives to need the V1 replay path).
   */
  refreshEnsembleStateV2(input: { ensemble: string }): Promise<RefreshEnsembleStateV2Result>;
  fetchConductorHistory(input: FetchConductorHistoryInput): Promise<FetchConductorHistoryResult>;
  relayCommandToConductor(input: RelayCommandInput): Promise<RelayCommandResult>;
  discoverEnsembles(): Promise<string[]>;
  deliverMaestroMessage(input: DeliverMaestroMessageInput): Promise<DeliverMaestroMessageResult>;
  fetchPlayerMessages(input: FetchPlayerMessagesInput): Promise<FetchPlayerMessagesResult>;
  fetchEnsembleChat(input: FetchEnsembleChatInput): Promise<FetchEnsembleChatResult>;
}

/**
 * Create the Maestro activity implementations bound to a Temporal client.
 * Registered with the shared worker.
 */
export function createMaestroActivities(
  client: Client,
  opts: MaestroActivityOptions = {},
): MaestroActivities {
  /** Shared row-mapper for both refresh shapes. */
  const toPlayerInfo = (ensemble: string) => (s: EnsembleSessionInfo): MaestroPlayerInfo => ({
    playerId: s.playerId,
    ensemble,
    part: s.part,
    hostname: s.hostname,
    workDir: s.workDir,
    gitRoot: s.gitRoot,
    gitBranch: s.gitBranch,
    isConductor: s.isConductor,
    agentType: s.agentType,
    playerType: s.playerType,
    phase: s.phase,
    // #399 W1 — forward the activity-counter pair so the maestro's
    // tempo bucket can diff across refreshes.
    activityCount: s.activityCount,
    lastActivityAt: s.lastActivityAt,
  });

  // #753 — attribute every Temporal call made by these activities (however
  // deep, e.g. scanEnsembleSessions → queryHandleWithTimeout) to the maestro.
  //
  // T0.6/#774 (architect verification prerequisite) — the tag is SPLIT by
  // the CALLING workflow, resolved per invocation from the activity
  // context: the same factory serves the per-ensemble maestro (chat-gated)
  // and the global maestro (never gated — the prime unwatched-residual
  // suspect), and the meter must tell them apart. Anything else (incl.
  // direct test invocation outside an activity context) lands in
  // 'maestro-session'. NOTE: bySource report keys for the maestro line
  // changed from 'maestro' to these three.
  const maestroSource = (): 'maestro-ensemble' | 'maestro-global' | 'maestro-session' => {
    try {
      switch (activityInfo().workflowType) {
        case 'agentMaestroWorkflow': return 'maestro-ensemble';
        case 'agentGlobalMaestroWorkflow': return 'maestro-global';
        default: return 'maestro-session';
      }
    } catch {
      return 'maestro-session'; // outside an activity context (tests, direct calls)
    }
  };
  return tagActionSource(maestroSource, {
    async refreshEnsembleStateV2(input: { ensemble: string }): Promise<RefreshEnsembleStateV2Result> {
      try {
        // Honor the DAEMON's configured profile for the scan strategy: a
        // cloud-input maestro on a daemon flipped back to 'local' degrades
        // gracefully to the legacy scan (still on the stretched cadence
        // until its next restart).
        const sessions = opts.costProfile === 'cloud'
          ? await scanEnsembleSessionsCloud(client, input.ensemble, log)
          : await scanEnsembleSessions(client, input.ensemble);
        const count = opts.observerPresence?.current?.();
        return {
          players: sessions.map(toPlayerInfo(input.ensemble)),
          // Fail-open: unknown presence (no aggregate wired yet, e.g. during
          // daemon boot) counts as "observers present" — never stretch the
          // cadence on missing information.
          observersPresent: count === undefined ? true : count > 0,
        };
      } catch (err) {
        log('refreshEnsembleStateV2 failed:', err);
        throw ApplicationFailure.nonRetryable(
          `Failed to scan ensemble: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },

    async fetchConductorHistory(input: FetchConductorHistoryInput): Promise<FetchConductorHistoryResult> {
      try {
        const wfId = conductorWorkflowId(input.ensemble);
        const handle = client.workflow.getHandle(wfId);
        const history: HistoryEntry[] = await handle.query('history');
        return { success: true, history };
      } catch (err) {
        // ContinueAsNew transient errors and missing conductor are soft failures
        const msg = err instanceof Error ? err.message : String(err);
        log('fetchConductorHistory failed (soft):', msg);
        return { success: false, history: [], error: msg };
      }
    },

    async relayCommandToConductor(input: RelayCommandInput): Promise<RelayCommandResult> {
      try {
        const wfId = conductorWorkflowId(input.ensemble);
        const handle = client.workflow.getHandle(wfId);
        await handle.signal('command', {
          text: input.text,
          source: input.source,
          ...(input.replyTo ? { replyTo: input.replyTo } : {}),
        });
        return { success: true };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log('relayCommandToConductor failed:', msg);
        return { success: false, error: msg };
      }
    },

    async discoverEnsembles(): Promise<string[]> {
      // #336/#529 — bounded visibility iterator. On deadline, return
      // the partial result rather than aborting; the maestro retries on
      // its own schedule, so a truncated enumeration this tick self-heals
      // on the next.
      const ensembles = new Set<string>();
      const query = `WorkflowType = "agentSessionWorkflow" AND ExecutionStatus = "Running"`;
      try {
        for await (const wf of iterateWithDeadline(
          client.workflow.list({ query }),
          VISIBILITY_DEADLINES_MS.discoverEnsembles,
          'discoverEnsembles',
        )) {
          try {
            const handle = client.workflow.getHandle(wf.workflowId);
            const metadata = await handle.query('getMetadata') as { ensemble: string };
            if (metadata.ensemble) {
              ensembles.add(metadata.ensemble);
            }
          } catch {
            // Workflow may have completed — skip
          }
        }
        return Array.from(ensembles).sort();
      } catch (err) {
        if (isVisibilityTimeout(err)) {
          log(`discoverEnsembles: ${err.message} — returning partial (${ensembles.size} ensembles)`);
          return Array.from(ensembles).sort();
        }
        // Discovery failures are typically transient (network, server restart) — allow retry
        log('discoverEnsembles failed:', err);
        throw new Error(
          `Failed to discover ensembles: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },

    async deliverMaestroMessage(input: DeliverMaestroMessageInput): Promise<DeliverMaestroMessageResult> {
      try {
        const handle = await resolveSession(client, input.ensemble, input.to);
        if (!handle) {
          return { success: false, error: `Player '${input.to}' not found in ensemble '${input.ensemble}'` };
        }
        await handle.signal('receiveMessage', {
          from: input.source,
          text: input.text,
          isMaestro: true,
        });
        return { success: true };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log('deliverMaestroMessage failed:', msg);
        return { success: false, error: msg };
      }
    },

    async fetchPlayerMessages(input: FetchPlayerMessagesInput): Promise<FetchPlayerMessagesResult> {
      try {
        const handle = await resolveSession(client, input.ensemble, input.playerId);
        if (!handle) {
          return { success: false, messages: [], error: `Player '${input.playerId}' not found in ensemble '${input.ensemble}'` };
        }
        const received: Message[] = await handle.query('allMessages');
        const sent: SentMessage[] = await handle.query('allSentMessages');

        // Merge into a single timeline sorted by timestamp
        const merged: Array<(Message & { direction?: 'received' }) | (SentMessage & { direction: 'sent' })> = [
          ...received.map((m) => ({ ...m, direction: 'received' as const })),
          ...sent.map((m) => ({ ...m, direction: 'sent' as const })),
        ];
        merged.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

        return { success: true, messages: merged };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log('fetchPlayerMessages failed (soft):', msg);
        return { success: false, messages: [], error: msg };
      }
    },

    async fetchEnsembleChat(input: FetchEnsembleChatInput): Promise<FetchEnsembleChatResult> {
      const { ensemble, knownCounts } = input;
      const hw: ChatHighWater = knownCounts ?? ZERO_CHAT_HIGH_WATER;
      const TRUNC = 500;
      const truncate = (t: string) => t.length > TRUNC ? t.slice(0, TRUNC - 1) + '...' : t;

      try {
        const maestroHandle = client.workflow.getHandle(sessionWorkflowId(ensemble, 'maestro'));

        let conductorHandle: ReturnType<typeof client.workflow.getHandle> | null = null;
        let conductorId = '';
        const sessions = await scanEnsembleSessions(client, ensemble);
        const conductorSession = sessions.find(s => s.isConductor);
        if (conductorSession) {
          conductorHandle = client.workflow.getHandle(conductorSession.workflowId);
          conductorId = conductorSession.playerId;
        }

        const [maestroRecvRes, maestroSentRes, condRecvRes, condSentRes] = await Promise.allSettled([
          maestroHandle.query('allMessages') as Promise<Message[]>,
          maestroHandle.query('allSentMessages') as Promise<SentMessage[]>,
          conductorHandle ? conductorHandle.query('allMessages') as Promise<Message[]> : Promise.resolve([] as Message[]),
          conductorHandle ? conductorHandle.query('allSentMessages') as Promise<SentMessage[]> : Promise.resolve([] as SentMessage[]),
        ]);

        const maestroRecv: Message[] = maestroRecvRes.status === 'fulfilled' ? maestroRecvRes.value : [];
        const maestroSent: SentMessage[] = maestroSentRes.status === 'fulfilled' ? maestroSentRes.value : [];
        const condRecv: Message[] = condRecvRes.status === 'fulfilled' ? condRecvRes.value : [];
        const condSent: SentMessage[] = condSentRes.status === 'fulfilled' ? condSentRes.value : [];

        const newMessages: EnsembleChatMessage[] = [];

        // #357: each push site forwards the source's broadcastId (when
        // present) onto the projected EnsembleChatMessage so the TUI's
        // ConversationStream can fold fan-out deliveries into one row.
        const maybeBroadcast = (m: { broadcastId?: string }): { broadcastId?: string } =>
          m.broadcastId !== undefined ? { broadcastId: m.broadcastId } : {};

        for (const m of maestroRecv.slice(hw.maestroRecv)) {
          newMessages.push({
            id: m.id,
            from: m.from,
            to: 'maestro',
            text: m.text,
            timestamp: m.timestamp,
            role: 'maestro-in',
            ...maybeBroadcast(m),
          });
        }

        for (const m of maestroSent.slice(hw.maestroSent)) {
          newMessages.push({
            id: m.id,
            from: 'maestro',
            to: m.to,
            text: m.text,
            timestamp: m.timestamp,
            role: 'maestro-out',
            ...maybeBroadcast(m),
          });
        }

        for (const m of condRecv.slice(hw.conductorRecv)) {
          if (m.from === 'maestro' || m.isMaestro) continue; // Skip maestro<->conductor (already covered)
          // Conductor self-reports (e.g. `tempo-conductor` calling `report`) land in the
          // conductor's own `messages` array. Re-target them as inbound-to-maestro so the
          // chat renders "tempo-conductor → maestro" instead of a confusing self-loop.
          const isConductorSelfReport = m.from === conductorId;
          newMessages.push({
            id: `cond-${m.id}`,
            from: m.from,
            to: isConductorSelfReport ? 'maestro' : conductorId,
            text: truncate(m.text),
            timestamp: m.timestamp,
            role: isConductorSelfReport ? 'maestro-in' : 'conductor-in',
            ...maybeBroadcast(m),
          });
        }

        for (const m of condSent.slice(hw.conductorSent)) {
          if (m.to === 'maestro') continue; // Skip conductor->maestro (already covered)
          newMessages.push({
            id: `cond-${m.id}`,
            from: conductorId,
            to: m.to,
            text: truncate(m.text),
            timestamp: m.timestamp,
            role: 'conductor-out',
            ...maybeBroadcast(m),
          });
        }

        newMessages.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

        return {
          success: true,
          newMessages,
          currentCounts: {
            maestroRecv: maestroRecv.length,
            maestroSent: maestroSent.length,
            conductorRecv: condRecv.length,
            conductorSent: condSent.length,
          },
          hasConductor: !!conductorHandle,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log('fetchEnsembleChat failed:', msg);
        return {
          success: false,
          newMessages: [],
          currentCounts: hw,
          hasConductor: false,
          error: msg,
        };
      }
    },
  });
}
