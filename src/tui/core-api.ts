/**
 * Core API for the TUI — wraps Temporal client queries to the Maestro and conductor workflows.
 * Pure TypeScript, no Ink/React dependency. Used by hooks in the TUI layer.
 */
import { Client } from '@temporalio/client';
import { maestroWorkflowId, conductorWorkflowId } from '../config';
import type {
  MaestroPlayerInfo,
  MaestroEvent,
  MaestroPendingCommand,
  HistoryEntry,
} from '../types';

export interface TuiApi {
  /** Query current player snapshot from Maestro. */
  getPlayers(): Promise<MaestroPlayerInfo[]>;
  /** Query event log from Maestro. */
  getEvents(limit?: number): Promise<MaestroEvent[]>;
  /** Query pending commands from Maestro. */
  getPendingCommands(): Promise<MaestroPendingCommand[]>;
  /** Send a command to the conductor via Maestro's update handler. */
  sendCommand(text: string, source: string): Promise<string>;
  /** Query conductor command/report history. */
  getConductorHistory(): Promise<HistoryEntry[]>;
  /** Check if Maestro workflow is running. */
  isConnected(): Promise<boolean>;
  /** Ensemble name. */
  ensemble: string;
}

/**
 * Create a TUI API instance bound to a Temporal client and ensemble.
 */
export function createTuiApi(client: Client, ensemble: string): TuiApi {
  const maestroWfId = maestroWorkflowId(ensemble);
  const conductorWfId = conductorWorkflowId(ensemble);

  return {
    ensemble,

    async getPlayers(): Promise<MaestroPlayerInfo[]> {
      try {
        const handle = client.workflow.getHandle(maestroWfId);
        return await handle.query('maestroPlayers');
      } catch {
        return [];
      }
    },

    async getEvents(limit?: number): Promise<MaestroEvent[]> {
      try {
        const handle = client.workflow.getHandle(maestroWfId);
        const events: MaestroEvent[] = await handle.query('maestroEvents');
        return limit ? events.slice(-limit) : events;
      } catch {
        return [];
      }
    },

    async getPendingCommands(): Promise<MaestroPendingCommand[]> {
      try {
        const handle = client.workflow.getHandle(maestroWfId);
        return await handle.query('maestroPendingCommands');
      } catch {
        return [];
      }
    },

    async sendCommand(text: string, source: string): Promise<string> {
      const handle = client.workflow.getHandle(maestroWfId);
      return await handle.executeUpdate('maestroSendCommand', {
        args: [{ text, source }],
      });
    },

    async getConductorHistory(): Promise<HistoryEntry[]> {
      try {
        const handle = client.workflow.getHandle(conductorWfId);
        return await handle.query('history');
      } catch {
        return [];
      }
    },

    async isConnected(): Promise<boolean> {
      try {
        const handle = client.workflow.getHandle(maestroWfId);
        const desc = await handle.describe();
        return desc.status.name === 'RUNNING';
      } catch {
        return false;
      }
    },
  };
}
