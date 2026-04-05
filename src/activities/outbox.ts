import { Client, WorkflowIdConflictPolicy } from '@temporalio/client';
import { ApplicationFailure } from '@temporalio/activity';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { Config, conductorWorkflowId, sessionWorkflowId } from '../config';
import { AgentType, SessionInput } from '../types';
import { getGitInfo } from '../git-info';
import { spawnInTerminal, spawnCopilotBridge } from '../spawn';
import { ENV } from '../config';
import { resolveSession } from './resolve';

const log = (...args: unknown[]) => console.error('[claude-tempo:outbox]', ...args);

// ── Activity input types ──

export interface DeliverCueInput {
  ensemble: string;
  fromPlayerId: string;
  targetPlayerId: string;
  message: string;
}

export interface DeliverReportInput {
  ensemble: string;
  fromPlayerId: string;
  text: string;
  reportType: 'result' | 'blocker' | 'question';
}

export interface TerminateSessionInput {
  ensemble: string;
  targetPlayerId: string;
  terminatedBy: string;
}

export interface StartRecruitedSessionInput {
  ensemble: string;
  targetName: string;
  workDir: string;
  isConductor: boolean;
  initialMessage?: string;
  fromPlayerId: string;
  agent: AgentType;
  systemPrompt?: string;
  taskQueue: string;
  agentDefinition?: string;
  agentDefinitionDescription?: string;
}

export interface SpawnProcessInput {
  targetName: string;
  workDir: string;
  isConductor: boolean;
  agent: AgentType;
  systemPrompt?: string;
  ensemble: string;
  temporalAddress: string;
  temporalNamespace: string;
  agentDefinition?: string;
  agentDefinitionPath?: string;
  nativeResolvable?: boolean;
}

// ── Activity result type ──

export interface OutboxActivityResult {
  success: boolean;
  error?: string;
}

// ── Activity interface ──

export interface OutboxActivities {
  deliverCue(input: DeliverCueInput): Promise<OutboxActivityResult>;
  deliverReport(input: DeliverReportInput): Promise<OutboxActivityResult>;
  terminateSession(input: TerminateSessionInput): Promise<OutboxActivityResult>;
  startRecruitedSession(input: StartRecruitedSessionInput): Promise<OutboxActivityResult>;
  spawnProcess(input: SpawnProcessInput): Promise<OutboxActivityResult>;
}

/**
 * Create outbox delivery activities bound to a Temporal client and config.
 * The returned object is registered with the worker as activities.
 */
export function createOutboxActivities(client: Client, config: Config): OutboxActivities {
  return {
    async deliverCue(input: DeliverCueInput): Promise<OutboxActivityResult> {
      const { ensemble, fromPlayerId, targetPlayerId, message } = input;
      const handle = await resolveSession(client, ensemble, targetPlayerId);
      if (!handle) {
        throw ApplicationFailure.nonRetryable(`No active session found for "${targetPlayerId}"`);
      }
      await handle.signal('receiveMessage', { from: fromPlayerId, text: message });
      return { success: true };
    },

    async deliverReport(input: DeliverReportInput): Promise<OutboxActivityResult> {
      const { ensemble, fromPlayerId, text, reportType } = input;
      const conductorId = conductorWorkflowId(ensemble);
      const handle = client.workflow.getHandle(conductorId);
      await handle.signal('playerReport', { playerId: fromPlayerId, text, type: reportType });
      return { success: true };
    },

    async terminateSession(input: TerminateSessionInput): Promise<OutboxActivityResult> {
      const { ensemble, targetPlayerId, terminatedBy } = input;
      const handle = await resolveSession(client, ensemble, targetPlayerId);
      if (!handle) {
        throw ApplicationFailure.nonRetryable(`No active session found for "${targetPlayerId}"`);
      }
      // Signal target to mark as terminated
      await handle.signal('updateMetadata', { status: 'terminated', terminatedBy });

      // Notify conductor about the termination (best effort)
      try {
        const conductorId = conductorWorkflowId(ensemble);
        const conductorHandle = client.workflow.getHandle(conductorId);
        await conductorHandle.signal('receiveMessage', {
          from: 'system',
          text: `Session "${targetPlayerId}" was terminated by ${terminatedBy}.`,
        });
      } catch {
        // Conductor may not exist — that's fine
      }

      return { success: true };
    },

    async startRecruitedSession(input: StartRecruitedSessionInput): Promise<OutboxActivityResult> {
      const { ensemble, targetName, workDir, isConductor, initialMessage, fromPlayerId, agent, systemPrompt, taskQueue, agentDefinition, agentDefinitionDescription } = input;
      try {
        const workflowId = isConductor
          ? conductorWorkflowId(ensemble)
          : sessionWorkflowId(ensemble, targetName);

        const { gitRoot, gitBranch } = getGitInfo(workDir);

        const sessionInput: SessionInput = {
          metadata: {
            playerId: targetName,
            ensemble,
            hostname: os.hostname(),
            workDir,
            gitRoot,
            gitBranch,
            isConductor,
            agentType: agent,
            status: 'pending',
            ...(agentDefinition ? { playerType: agentDefinition } : {}),
            ...(agentDefinitionDescription ? { playerTypeDescription: agentDefinitionDescription } : {}),
            recruitedBy: fromPlayerId,
          },
          autoSummary: `Session in ${path.basename(workDir)}`,
          disableStaleDetection: true,
          ...(initialMessage ? {
            messages: [{
              id: crypto.randomUUID(),
              from: fromPlayerId,
              text: initialMessage,
              timestamp: new Date().toISOString(),
              delivered: false,
            }],
          } : {}),
        };

        await client.workflow.start('claudeSessionWorkflow', {
          workflowId,
          taskQueue,
          args: [sessionInput],
          workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
          searchAttributes: {
            ...(gitRoot ? { ClaudeTempoGitRoot: [gitRoot] } : {}),
            ClaudeTempoHostname: [os.hostname()],
            ClaudeTempoEnsemble: [ensemble],
            ClaudeTempoPlayerId: [targetName],
          },
        });

        log(`Pre-created workflow ${workflowId} for recruit "${targetName}"`);
        return { success: true };
      } catch (err) {
        throw ApplicationFailure.nonRetryable(
          `Failed to start recruited session "${targetName}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },

    async spawnProcess(input: SpawnProcessInput): Promise<OutboxActivityResult> {
      const { targetName, workDir, isConductor, agent, systemPrompt, ensemble, temporalAddress, temporalNamespace, agentDefinition, agentDefinitionPath, nativeResolvable } = input;
      // Read secrets from the worker's config closure — never from workflow state
      const { temporalApiKey, temporalTlsCertPath, temporalTlsKeyPath } = config;
      try {
        if (agent === 'copilot') {
          const { pid } = spawnCopilotBridge({
            name: targetName,
            ensemble,
            temporalAddress,
            temporalNamespace,
            temporalApiKey,
            temporalTlsCertPath,
            temporalTlsKeyPath,
            isConductor,
            workDir,
          });
          log(`Spawned copilot-bridge (pid ${pid}) in ${workDir} as "${targetName}"`);
        } else {
          // Resolve agent flags: --agent (native) > --system-prompt (shipped/legacy)
          let agentFlags: string[] = [];
          if (agentDefinition && nativeResolvable) {
            agentFlags = ['--agent', agentDefinition];
          } else if (agentDefinitionPath) {
            agentFlags = ['--system-prompt', agentDefinitionPath];
          } else if (systemPrompt) {
            agentFlags = ['--system-prompt', systemPrompt];
          }

          const spawnArgs = [
            '--dangerously-skip-permissions',
            '--dangerously-load-development-channels', 'server:claude-tempo',
            '-n', targetName,
            ...agentFlags,
          ];
          const envVars: Record<string, string> = {
            [ENV.ENSEMBLE]: ensemble,
            [ENV.CONDUCTOR]: isConductor ? 'true' : '',
            [ENV.PLAYER_NAME]: targetName,
            [ENV.TEMPORAL_ADDRESS]: temporalAddress,
            [ENV.TEMPORAL_NAMESPACE]: temporalNamespace,
          };
          if (agentDefinition) envVars[ENV.PLAYER_TYPE] = agentDefinition;
          if (temporalApiKey) envVars[ENV.TEMPORAL_API_KEY] = temporalApiKey;
          if (temporalTlsCertPath) envVars[ENV.TEMPORAL_TLS_CERT_PATH] = temporalTlsCertPath;
          if (temporalTlsKeyPath) envVars[ENV.TEMPORAL_TLS_KEY_PATH] = temporalTlsKeyPath;
          const { pid } = spawnInTerminal(spawnArgs, workDir, envVars);
          log(`Spawned claude process (pid ${pid}) in ${workDir} as "${targetName}"`);
        }

        return { success: true };
      } catch (err) {
        throw ApplicationFailure.nonRetryable(
          `Failed to spawn process for "${targetName}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  };
}
