import { Client } from '@temporalio/client';
import { ApplicationFailure } from '@temporalio/activity';
import { conductorWorkflowId } from '../config';
import { HistoryEntry, MaestroPlayerInfo } from '../types';
import { scanEnsembleSessions } from './resolve';

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

/** Activity interface — used by proxyActivities in the Maestro workflow. */
export interface MaestroActivities {
  refreshEnsembleState(ensemble: string): Promise<MaestroPlayerInfo[]>;
  fetchConductorHistory(input: FetchConductorHistoryInput): Promise<FetchConductorHistoryResult>;
  relayCommandToConductor(input: RelayCommandInput): Promise<RelayCommandResult>;
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
  };
}
