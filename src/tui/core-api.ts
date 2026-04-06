/**
 * Core API for the TUI — wraps Temporal client queries to the Maestro and conductor workflows.
 * Pure TypeScript, no Ink/React dependency. Used by hooks in the TUI layer.
 *
 * Supports multi-ensemble discovery via the Global Maestro workflow,
 * with fallback to per-ensemble Maestro and direct workflow list.
 */
import { Client } from '@temporalio/client';
import { maestroWorkflowId, GLOBAL_MAESTRO_WORKFLOW_ID } from '../config';
import type {
  MaestroPlayerInfo,
  MaestroRelayMessage,
  HistoryEntry,
  Message,
  SentMessage,
} from '../types';

// ── Public Types ──

export interface EnsembleSummary {
  name: string;
  playerCount: number;
  hasConductor: boolean;
  conductorStatus?: string;
}

export interface TuiApi {
  /** Discover all running ensembles across the cluster. */
  discoverEnsembles(): Promise<EnsembleSummary[]>;
  /** Get current player snapshot for an ensemble. */
  getPlayers(ensemble: string): Promise<MaestroPlayerInfo[]>;
  /** Get recent messages for an ensemble. */
  getMessages(ensemble: string, limit?: number): Promise<MaestroRelayMessage[]>;
  /** Get conductor command/report history for an ensemble. */
  getConductorHistory(ensemble: string): Promise<HistoryEntry[]>;
  /** Get a player's message history (received + sent). */
  getPlayerMessages(ensemble: string, playerId: string): Promise<Array<Message | (SentMessage & { direction: 'sent' })>>;
  /** Get a player's workflow metadata. */
  getPlayerMetadata(ensemble: string, playerId: string): Promise<any>;
  /** Send a command to an ensemble's conductor via Maestro. Returns command ID. */
  sendCommand(ensemble: string, text: string, source: string): Promise<string>;
  /** Send a message to a specific player in an ensemble. Returns message ID. */
  sendMessage(ensemble: string, to: string, text: string, source: string): Promise<string>;
  /** Terminate a player's workflow. */
  terminatePlayer(ensemble: string, playerId: string): Promise<void>;
  /** Check if the Temporal connection is alive. */
  isConnected(): Promise<boolean>;
  /** Check if the Global Maestro workflow is running. */
  hasGlobalMaestro(): Promise<boolean>;
}

// ── Implementation ──

export function createTuiApi(client: Client): TuiApi {
  const globalMaestroId = GLOBAL_MAESTRO_WORKFLOW_ID;

  /** Helper: get a workflow handle by ID. */
  function handle(workflowId: string) {
    return client.workflow.getHandle(workflowId);
  }

  return {
    async discoverEnsembles(): Promise<EnsembleSummary[]> {
      // Strategy 1: Global Maestro playersByEnsemble query
      try {
        const h = handle(globalMaestroId);
        const byEnsemble: Record<string, MaestroPlayerInfo[]> = await h.query('maestroPlayersByEnsemble');
        return Object.entries(byEnsemble).map(([name, players]) => {
          const conductor = players.find(p => p.isConductor);
          return {
            name,
            playerCount: players.length,
            hasConductor: !!conductor,
            conductorStatus: conductor?.status,
          };
        });
      } catch {
        // Global Maestro not available — fall through
      }

      // Strategy 2: Direct workflow list scan
      try {
        const query = 'WorkflowType = "claudeSessionWorkflow" AND ExecutionStatus = "Running"';
        const ensembleMap = new Map<string, { count: number; hasConductor: boolean; conductorStatus?: string }>();

        for await (const wf of client.workflow.list({ query })) {
          const vals = wf.searchAttributes?.ClaudeTempoEnsemble;
          if (!Array.isArray(vals) || vals.length === 0) continue;
          const name = String(vals[0]);

          const entry = ensembleMap.get(name) || { count: 0, hasConductor: false };
          entry.count++;

          const isConductor = wf.searchAttributes?.ClaudeTempoIsConductor;
          if (Array.isArray(isConductor) && isConductor[0] === true) {
            entry.hasConductor = true;
            const statusArr = wf.searchAttributes?.ClaudeTempoStatus;
            entry.conductorStatus = Array.isArray(statusArr) ? String(statusArr[0]) : undefined;
          }

          ensembleMap.set(name, entry);
        }

        return [...ensembleMap.entries()].map(([name, info]) => ({
          name,
          playerCount: info.count,
          hasConductor: info.hasConductor,
          conductorStatus: info.conductorStatus,
        }));
      } catch {
        return [];
      }
    },

    async getPlayers(ensemble: string): Promise<MaestroPlayerInfo[]> {
      // Strategy 1: Global Maestro — filter by ensemble
      try {
        const h = handle(globalMaestroId);
        const byEnsemble: Record<string, MaestroPlayerInfo[]> = await h.query('maestroPlayersByEnsemble');
        if (byEnsemble[ensemble]) return byEnsemble[ensemble];
      } catch {
        // Fall through
      }

      // Strategy 2: Per-ensemble Maestro
      try {
        const h = handle(maestroWorkflowId(ensemble));
        return await h.query('maestroPlayers');
      } catch {
        // Fall through
      }

      // Strategy 3: Direct workflow list
      try {
        const query = `WorkflowType = "claudeSessionWorkflow" AND ExecutionStatus = "Running" AND ClaudeTempoEnsemble = "${ensemble}"`;
        const players: MaestroPlayerInfo[] = [];
        for await (const wf of client.workflow.list({ query })) {
          const sa = wf.searchAttributes || {};
          const playerId = Array.isArray(sa.ClaudeTempoPlayerId) ? String(sa.ClaudeTempoPlayerId[0]) : wf.workflowId;
          players.push({
            playerId,
            ensemble,
            part: '',
            hostname: Array.isArray(sa.ClaudeTempoHostname) ? String(sa.ClaudeTempoHostname[0]) : '',
            workDir: '',
            isConductor: Array.isArray(sa.ClaudeTempoIsConductor) && sa.ClaudeTempoIsConductor[0] === true,
            agentType: 'claude',
            status: Array.isArray(sa.ClaudeTempoStatus) ? String(sa.ClaudeTempoStatus[0]) : undefined,
          });
        }
        return players;
      } catch {
        return [];
      }
    },

    async getMessages(ensemble: string, limit?: number): Promise<MaestroRelayMessage[]> {
      try {
        const h = handle(globalMaestroId);
        const all: MaestroRelayMessage[] = await h.query('maestroRecentMessages');
        const filtered = all.filter(m => m.ensemble === ensemble);
        return limit ? filtered.slice(-limit) : filtered;
      } catch {
        return [];
      }
    },

    async getConductorHistory(ensemble: string): Promise<HistoryEntry[]> {
      try {
        const h = handle(globalMaestroId);
        const result: { success: boolean; history: HistoryEntry[] } = await h.executeUpdate('maestroFetchConductorHistory', {
          args: [{ ensemble }],
        });
        if (result.success) return result.history;
        return [];
      } catch {
        return [];
      }
    },

    async getPlayerMessages(ensemble: string, playerId: string): Promise<Array<Message | (SentMessage & { direction: 'sent' })>> {
      try {
        const h = handle(globalMaestroId);
        return await h.executeUpdate('maestroFetchPlayerMessages', {
          args: [{ ensemble, playerId }],
        });
      } catch {
        return [];
      }
    },

    async getPlayerMetadata(ensemble: string, playerId: string): Promise<any> {
      try {
        // Query the player's workflow directly for metadata
        const query = `WorkflowType = "claudeSessionWorkflow" AND ExecutionStatus = "Running" AND ClaudeTempoEnsemble = "${ensemble}" AND ClaudeTempoPlayerId = "${playerId}"`;
        for await (const wf of client.workflow.list({ query })) {
          const h = handle(wf.workflowId);
          return await h.query('metadata');
        }
        return null;
      } catch {
        return null;
      }
    },

    async sendCommand(ensemble: string, text: string, source: string): Promise<string> {
      // Try Global Maestro first
      try {
        const h = handle(globalMaestroId);
        return await h.executeUpdate('maestroGlobalSendCommand', {
          args: [{ ensemble, text, source }],
        });
      } catch {
        // Fall back to per-ensemble Maestro
        const h = handle(maestroWorkflowId(ensemble));
        return await h.executeUpdate('maestroSendCommand', {
          args: [{ text, source }],
        });
      }
    },

    async sendMessage(ensemble: string, to: string, text: string, source: string): Promise<string> {
      const h = handle(globalMaestroId);
      return await h.executeUpdate('maestroSendMessage', {
        args: [{ ensemble, to, text, source }],
      });
    },

    async terminatePlayer(ensemble: string, playerId: string): Promise<void> {
      const query = `WorkflowType = "claudeSessionWorkflow" AND ExecutionStatus = "Running" AND ClaudeTempoEnsemble = "${ensemble}" AND ClaudeTempoPlayerId = "${playerId}"`;
      for await (const wf of client.workflow.list({ query })) {
        const h = handle(wf.workflowId);
        await h.terminate('terminated via TUI');
        return;
      }
      throw new Error(`Player "${playerId}" not found in ensemble "${ensemble}"`);
    },

    async isConnected(): Promise<boolean> {
      try {
        // Lightweight check: list with limit 1
        const query = 'ExecutionStatus = "Running"';
        for await (const _ of client.workflow.list({ query })) {
          return true;
        }
        return true; // Connected but no workflows
      } catch {
        return false;
      }
    },

    async hasGlobalMaestro(): Promise<boolean> {
      try {
        const h = handle(globalMaestroId);
        const desc = await h.describe();
        return desc.status.name === 'RUNNING';
      } catch {
        return false;
      }
    },
  };
}
