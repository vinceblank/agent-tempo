import { Client, WorkflowIdConflictPolicy } from '@temporalio/client';
import { ApplicationFailure } from '@temporalio/activity';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { Config, conductorWorkflowId, sessionWorkflowId } from '../config';
import { ENCORE_DEFAULT_CONTEXT_MESSAGES, PREVIEW_MAX_LENGTH } from '../utils/validation';
import { AgentType, SessionInput } from '../types';
import { getGitInfo } from '../git-info';
import { spawnInTerminal, spawnCopilotBridge } from '../spawn';
import { ENV } from '../config';
import { resolveSession } from './resolve';
import { resolveAgentType } from '../ensemble/agent-types';

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
  allowedTools?: string[];
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
  /** When true, use --resume instead of -n (reconnect to existing session). */
  resume?: boolean;
  /** Claude Code session UUID for --session-id (new sessions) or --resume (encore). */
  claudeSessionId?: string;
  /** Tool restrictions from the agent definition frontmatter. */
  allowedTools?: string[];
}

export interface PerformEncoreInput {
  ensemble: string;
  targetPlayerId: string;
  fromPlayerId: string;
  contextMessageCount?: number;
}

export interface EncoreResult {
  workDir: string;
  hostname: string;
  isConductor: boolean;
  agent: AgentType;
  agentDefinition?: string;
  agentDefinitionPath?: string;
  nativeResolvable?: boolean;
  allowedTools?: string[];
  /** Claude Code session UUID for deterministic --resume. */
  claudeSessionId?: string;
  temporalAddress: string;
  temporalNamespace: string;
}

// ── Activity result type ──

export interface OutboxActivityResult {
  success: boolean;
  error?: string;
}

export interface RecruitResult extends OutboxActivityResult {
  /** Claude Code session UUID assigned at recruit time. */
  claudeSessionId?: string;
}

// ── Activity interface ──

export interface OutboxActivities {
  deliverCue(input: DeliverCueInput): Promise<OutboxActivityResult>;
  deliverReport(input: DeliverReportInput): Promise<OutboxActivityResult>;
  terminateSession(input: TerminateSessionInput): Promise<OutboxActivityResult>;
  startRecruitedSession(input: StartRecruitedSessionInput): Promise<RecruitResult>;
  spawnProcess(input: SpawnProcessInput): Promise<OutboxActivityResult>;
  performEncore(input: PerformEncoreInput): Promise<EncoreResult>;
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

    async startRecruitedSession(input: StartRecruitedSessionInput): Promise<RecruitResult> {
      const { ensemble, targetName, workDir, isConductor, initialMessage, fromPlayerId, agent, systemPrompt, taskQueue, agentDefinition, agentDefinitionDescription } = input;
      try {
        const workflowId = isConductor
          ? conductorWorkflowId(ensemble)
          : sessionWorkflowId(ensemble, targetName);

        const { gitRoot, gitBranch } = getGitInfo(workDir);

        // Generate a UUID for the Claude Code session — used for deterministic --resume on encore
        const claudeSessionId = crypto.randomUUID();

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
            claudeSessionId,
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

        log(`Pre-created workflow ${workflowId} for recruit "${targetName}" (sessionId=${claudeSessionId})`);
        return { success: true, claudeSessionId };
      } catch (err) {
        throw ApplicationFailure.nonRetryable(
          `Failed to start recruited session "${targetName}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },

    async spawnProcess(input: SpawnProcessInput): Promise<OutboxActivityResult> {
      const { targetName, workDir, isConductor, agent, systemPrompt, ensemble, temporalAddress, temporalNamespace, agentDefinition, agentDefinitionPath, nativeResolvable, resume, claudeSessionId, allowedTools } = input;
      // Read secrets from the worker's config closure — never from workflow state
      const { temporalApiKey, temporalTlsCertPath, temporalTlsKeyPath } = config;
      try {
        if (agent === 'copilot') {
          if (allowedTools && allowedTools.length > 0) {
            log(`Warning: allowedTools [${allowedTools.join(', ')}] specified for copilot agent "${targetName}" — copilot bridge does not support --allowedTools, skipping`);
          }
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

          // Use --resume for encore (reconnect to existing session) or -n for new sessions.
          // For encore: use UUID for deterministic --resume (no interactive picker).
          // For new sessions: use --session-id to track the UUID for future encores.
          const nameArgs = resume
            ? ['--resume', claudeSessionId || targetName]
            : ['-n', targetName, ...(claudeSessionId ? ['--session-id', claudeSessionId] : [])];

          // Build --allowedTools flag from agent definition frontmatter
          const allowedToolsFlags = allowedTools && allowedTools.length > 0
            ? ['--allowedTools', ...allowedTools]
            : [];

          const spawnArgs = [
            '--dangerously-skip-permissions',
            '--dangerously-load-development-channels', 'server:claude-tempo',
            ...nameArgs,
            ...agentFlags,
            ...allowedToolsFlags,
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
          log(`Spawned claude process (pid ${pid}) in ${workDir} as "${targetName}" (resume=${!!resume})`);
        }

        return { success: true };
      } catch (err) {
        throw ApplicationFailure.nonRetryable(
          `Failed to spawn process for "${targetName}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },

    async performEncore(input: PerformEncoreInput): Promise<EncoreResult> {
      const { ensemble, targetPlayerId, fromPlayerId, contextMessageCount = ENCORE_DEFAULT_CONTEXT_MESSAGES } = input;
      try {
        const handle = await resolveSession(client, ensemble, targetPlayerId);
        if (!handle) {
          throw ApplicationFailure.nonRetryable(`No session found for "${targetPlayerId}"`);
        }

        // Atomically transition status from 'stale' to 'pending' — prevents double-spawn races
        const transitioned = await handle.executeUpdate('checkAndSetStatus', {
          args: [{ expectedStatus: 'stale', newStatus: 'pending' }],
        });
        if (!transitioned) {
          // Read current status for a useful error message
          const metadata = await handle.query('getMetadata') as Record<string, any>;
          const status = metadata.status as string;
          throw ApplicationFailure.nonRetryable(
            `Cannot encore "${targetPlayerId}" — status is "${status}" (must be "stale"). Another encore may already be in progress.`,
          );
        }

        // Query context (status is now locked to 'pending', safe from races)
        const metadata = await handle.query('getMetadata') as Record<string, any>;
        const part = await handle.query('getPart') as string;
        const allMessages = await handle.query('allMessages') as Array<{ from: string; text: string; timestamp: string }>;

        // Build context message from recent messages
        const recentMessages = allMessages.slice(-contextMessageCount);
        const msgSummary = recentMessages.length > 0
          ? recentMessages.map(m => `[${m.from}] ${m.text.slice(0, PREVIEW_MAX_LENGTH)}`).join('\n')
          : '(no recent messages)';

        const contextMessage = [
          `🎵 **Encore** — you've been revived by ${fromPlayerId}.`,
          part ? `Your last status: ${part}` : '',
          `Recent messages (last ${recentMessages.length}):`,
          msgSummary,
          '',
          'Resume where you left off. Use `ensemble` to see who is active.',
        ].filter(Boolean).join('\n');

        // Inject context message (status already set to pending atomically above)
        await handle.signal('receiveMessage', { from: fromPlayerId, text: contextMessage });

        log(`Encore prepared for "${targetPlayerId}" — status reset to pending, context injected`);

        // Return spawn parameters from the target's metadata
        const agentType = (metadata.agentType as string) || 'claude';
        const playerType = metadata.playerType as string | undefined;
        let agentDefinitionPath: string | undefined;
        let nativeResolvable: boolean | undefined;
        let allowedTools: string[] | undefined;
        if (playerType) {
          try {
            const info = resolveAgentType(playerType);
            if (info) {
              agentDefinitionPath = info.path;
              nativeResolvable = info.nativeResolvable;
              allowedTools = info.allowedTools;
            }
          } catch {
            // Agent type resolution failure is non-fatal
          }
        }

        return {
          workDir: metadata.workDir as string,
          hostname: metadata.hostname as string,
          isConductor: metadata.isConductor as boolean,
          agent: agentType === 'copilot' ? 'copilot' : 'claude',
          agentDefinition: playerType,
          agentDefinitionPath,
          nativeResolvable,
          allowedTools,
          claudeSessionId: (metadata.claudeSessionId as string) || undefined,
          temporalAddress: config.temporalAddress,
          temporalNamespace: config.temporalNamespace,
        };
      } catch (err) {
        if (err instanceof ApplicationFailure) throw err;
        throw ApplicationFailure.nonRetryable(
          `Encore failed for "${targetPlayerId}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  };
}
