import { Client } from '@temporalio/client';
import { ApplicationFailure } from '@temporalio/activity';
import { conductorWorkflowId } from '../config';
import { HistoryEntry, MaestroPlayerInfo, Message, SentMessage } from '../types';
import { scanEnsembleSessions, resolveSession } from './resolve';

const log = (...args: unknown[]) => console.error('[claude-tempo:maestro]', ...args);

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

/** Activity interface — used by proxyActivities in the Maestro workflow. */
export interface MaestroActivities {
  refreshEnsembleState(ensemble: string): Promise<MaestroPlayerInfo[]>;
  fetchConductorHistory(input: FetchConductorHistoryInput): Promise<FetchConductorHistoryResult>;
  relayCommandToConductor(input: RelayCommandInput): Promise<RelayCommandResult>;
  discoverEnsembles(): Promise<string[]>;
  deliverMaestroMessage(input: DeliverMaestroMessageInput): Promise<DeliverMaestroMessageResult>;
  fetchPlayerMessages(input: FetchPlayerMessagesInput): Promise<FetchPlayerMessagesResult>;
}

/**
 * Create the Maestro activity implementations bound to a Temporal client.
 * Registered with the shared worker.
 */
export function createMaestroActivities(client: Client): MaestroActivities {
  return {
    async refreshEnsembleState(ensemble: string): Promise<MaestroPlayerInfo[]> {
      try {
        const sessions = await scanEnsembleSessions(client, ensemble);
        return sessions.map((s) => ({
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
          status: s.status,
        }));
      } catch (err) {
        log('refreshEnsembleState failed:', err);
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
      try {
        const ensembles = new Set<string>();
        const query = `WorkflowType = "claudeSessionWorkflow" AND ExecutionStatus = "Running"`;
        for await (const wf of client.workflow.list({ query })) {
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
  };
}
