import { Client, WorkflowIdConflictPolicy } from '@temporalio/client';
import { ApplicationFailure } from '@temporalio/activity';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { Config, conductorWorkflowId, sessionWorkflowId } from '../config';
import { ENCORE_DEFAULT_CONTEXT_MESSAGES, PREVIEW_MAX_LENGTH } from '../utils/validation';
import { AgentType, AdapterClass, AttachmentInfo, SessionInput, SessionMetadata, Message } from '../types';
import { getGitInfo } from '../git-info';
import { spawnInTerminal, spawnCopilotBridge } from '../spawn';
import { ENV } from '../config';
import { resolveSession } from './resolve';
import { registry } from '../adapters';
import {
  attachmentInfoQuery,
  forceDetachUpdate,
  claimAttachmentUpdate,
  enqueueSpawnUpdate,
  getMetadataQuery,
  getPartQuery,
  allMessagesQuery,
  receiveMessageSignal,
} from '../workflows/signals';

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
  reportType: 'result' | 'blocker' | 'question' | 'update';
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
  /** Custom claude binary path (from config.claudeBin). */
  claudeBin?: string;
  /** When true, spawn process but lock outbox and defer initial message until release (warm hold). */
  held?: boolean;
}

export interface ReleasePlayerInput {
  ensemble: string;
  targetPlayerId: string;
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
  /** Session UUID — used for Copilot SDK sessionId and Claude Code --resume/--session-id. */
  sessionId?: string;
  /** Tool restrictions from the agent definition frontmatter. */
  allowedTools?: string[];
  /** Custom claude binary path (from config.claudeBin). */
  claudeBin?: string;
  /**
   * PR-D attachment-lease handoff. When present, the workflow has already
   * called `claimAttachment` and the child process should boot and invoke
   * `startV2Lifecycle(workflowId, attachmentId)` to renew (rather than fresh-claim)
   * the lease using the pre-assigned id. See design §8.2 step 5.
   */
  attachmentId?: string;
  /** Pinned runId returned by `claimAttachment`; passed to the adapter for handle pinning. */
  attachmentRunId?: string;
  /** Resolved adapter descriptor id (e.g. 'claude-code', 'copilot'); mirrors SessionMetadata.adapterId. */
  adapterId?: string;
}

export interface PerformEncoreInput {
  ensemble: string;
  targetPlayerId: string;
  fromPlayerId: string;
  contextMessageCount?: number;
}

export interface EncoreResult {
  /** Successful encore — attachment claimed on target and spawn enqueued there. */
  success: true;
  /** Attachment token issued by the target for the new adapter. */
  attachmentId: string;
  /** Target workflow's outbox spawn-entry id — for logging / tests. */
  spawnEntryId: string;
}

// ── Activity result type ──

export interface OutboxActivityResult {
  success: boolean;
  error?: string;
}

export interface RecruitResult extends OutboxActivityResult {
  /** Session UUID assigned at recruit time. */
  sessionId?: string;
}

// ── Activity interface ──

export interface OutboxActivities {
  deliverCue(input: DeliverCueInput): Promise<OutboxActivityResult>;
  deliverReport(input: DeliverReportInput): Promise<OutboxActivityResult>;
  terminateSession(input: TerminateSessionInput): Promise<OutboxActivityResult>;
  startRecruitedSession(input: StartRecruitedSessionInput): Promise<RecruitResult>;
  spawnProcess(input: SpawnProcessInput): Promise<OutboxActivityResult>;
  performEncore(input: PerformEncoreInput): Promise<EncoreResult>;
  releasePlayer(input: ReleasePlayerInput): Promise<OutboxActivityResult>;
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
      try {
        const conductorId = conductorWorkflowId(ensemble);
        const handle = client.workflow.getHandle(conductorId);
        await handle.describe(); // throws if conductor workflow is not running
        await handle.signal('playerReport', { playerId: fromPlayerId, text, type: reportType });
        return { success: true };
      } catch (err) {
        if (err instanceof ApplicationFailure) throw err;
        throw ApplicationFailure.nonRetryable(
          `Failed to deliver report to conductor: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },

    async terminateSession(input: TerminateSessionInput): Promise<OutboxActivityResult> {
      const { ensemble, targetPlayerId, terminatedBy } = input;
      const handle = await resolveSession(client, ensemble, targetPlayerId);
      if (!handle) {
        throw ApplicationFailure.nonRetryable(`No active session found for "${targetPlayerId}"`);
      }
      // PR-C commit 4: use the V2 `destroy` update — explicit operator termination
      // per §2.5 (abandon in-flight, phase=gone, COMPLETE). The former
      // `updateMetadata({ status: 'terminated' })` signal path was retired.
      await handle.executeUpdate('destroy', {
        args: [{ reason: 'stop via tool', terminatedBy }],
      });

      // Notify conductor about the termination (best effort)
      try {
        const conductorId = conductorWorkflowId(ensemble);
        const conductorHandle = client.workflow.getHandle(conductorId);
        await conductorHandle.signal('receiveMessage', {
          from: 'system',
          text: `Session "${targetPlayerId}" was terminated by ${terminatedBy}.`,
          responseRequested: false,
        });
      } catch {
        // Conductor may not exist — that's fine
      }

      return { success: true };
    },

    async startRecruitedSession(input: StartRecruitedSessionInput): Promise<RecruitResult> {
      const { ensemble, targetName, workDir, isConductor, initialMessage, fromPlayerId, agent, systemPrompt, taskQueue, agentDefinition, agentDefinitionDescription, held } = input;
      try {
        const workflowId = isConductor
          ? conductorWorkflowId(ensemble)
          : sessionWorkflowId(ensemble, targetName);

        const { gitRoot, gitBranch } = getGitInfo(workDir);

        // Generate a UUID for the session — used for deterministic --resume on encore
        const sessionId = crypto.randomUUID();

        // Warm hold: process will spawn and go active, but outbox is locked and
        // the initial message is deferred. A standby message is sent instead.
        const standbyMessage = held
          ? 'You are on standby. Your ensemble is loading — other players are still connecting. Wait for your task assignment. Do not start work or send messages yet.'
          : undefined;

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
            // PR-B (v0.25 step 2/7): populate adapterId on fresh recruits so the
            // session workflow and dispatch path can resolve the adapter descriptor
            // from the registry without falling back to the legacy agentType field.
            adapterId: registry.resolveFromAgentType(agent),
            status: 'pending',
            sessionId,
            ...(agentDefinition ? { playerType: agentDefinition } : {}),
            ...(agentDefinitionDescription ? { playerTypeDescription: agentDefinitionDescription } : {}),
            recruitedBy: fromPlayerId,
          },
          autoSummary: `Session in ${path.basename(workDir)}`,
          disableStaleDetection: true,
          // When held: store the initial message for delivery on release, inject standby message instead
          ...(held ? { outboxLocked: true, heldMessage: initialMessage } : {}),
          messages: held
            ? [{
                id: crypto.randomUUID(),
                from: 'system',
                text: standbyMessage!,
                timestamp: new Date().toISOString(),
                delivered: false,
              }]
            : (initialMessage ? [{
                id: crypto.randomUUID(),
                from: fromPlayerId,
                text: initialMessage,
                timestamp: new Date().toISOString(),
                delivered: false,
              }] : undefined),
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

        log(`Pre-created workflow ${workflowId} for recruit "${targetName}" (sessionId=${sessionId}, held=${!!held})`);
        return { success: true, sessionId };
      } catch (err) {
        throw ApplicationFailure.nonRetryable(
          `Failed to start recruited session "${targetName}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },

    async spawnProcess(input: SpawnProcessInput): Promise<OutboxActivityResult> {
      const { targetName, workDir, isConductor, agent, systemPrompt, ensemble, temporalAddress, temporalNamespace, agentDefinition, agentDefinitionPath, nativeResolvable, resume, sessionId, allowedTools, claudeBin, attachmentId, attachmentRunId, adapterId } = input;
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
            sessionId,
            attachmentId,
            attachmentRunId,
            adapterId,
          });
          log(`Spawned copilot-bridge (pid ${pid}) in ${workDir} as "${targetName}"${attachmentId ? ` (attachmentId=${attachmentId})` : ''}`);
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
            ? ['--resume', sessionId || targetName]
            : ['-n', targetName, ...(sessionId ? ['--session-id', sessionId] : [])];

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
          // PR-D: forward pre-claimed attachment so the adapter renews rather than fresh-claims.
          if (attachmentId) envVars[ENV.ATTACHMENT_ID] = attachmentId;
          if (attachmentRunId) envVars[ENV.ATTACHMENT_RUN_ID] = attachmentRunId;
          if (adapterId) envVars[ENV.ADAPTER_ID] = adapterId;
          const { pid } = spawnInTerminal(spawnArgs, workDir, envVars, { claudeBin });
          log(`Spawned claude process (pid ${pid}) in ${workDir} as "${targetName}" (resume=${!!resume}${attachmentId ? `, attachmentId=${attachmentId}` : ''})`);
        }

        return { success: true };
      } catch (err) {
        throw ApplicationFailure.nonRetryable(
          `Failed to spawn process for "${targetName}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },

    /**
     * PR-D: encore is the restart algorithm (§8.2) with a context-replay preamble.
     *
     * 1. Resolve the target session handle.
     * 2. Query attachmentInfo — bail if `phase === 'gone'` (destroyed; use recruit instead).
     * 3. If a previous attachment lingers (any non-`detached` phase), forceDetach it with
     *    `gracePeriodMs: 0`. Encore targets are typically `stale`, so nothing to drain.
     * 4. Query metadata + part + messages (for the context message).
     * 5. Claim a fresh attachment on the target's preferred/last host.
     * 6. Inject the context message via `receiveMessage`.
     * 7. Enqueue a spawn on the target's own outbox — the target's dispatch loop fires
     *    `spawnProcess` on its per-host task queue and §8.4 rollback handles spawn failures.
     *
     * Critically, the caller (`case 'encore':` in the source workflow) doesn't run the
     * spawn anymore — it just awaits this activity. The target owns the spawn + rollback.
     */
    async performEncore(input: PerformEncoreInput): Promise<EncoreResult> {
      const { ensemble, targetPlayerId, fromPlayerId, contextMessageCount = ENCORE_DEFAULT_CONTEXT_MESSAGES } = input;
      try {
        const handle = await resolveSession(client, ensemble, targetPlayerId);
        if (!handle) {
          throw ApplicationFailure.nonRetryable(`No session found for "${targetPlayerId}"`);
        }

        // Step 2 — inspect phase. `gone` means the workflow was destroyed; encore won't
        // revive it (recruit would create a new workflow ID, which is out of scope here).
        const info = await handle.query(attachmentInfoQuery) as AttachmentInfo;
        if (info.phase === 'gone') {
          throw ApplicationFailure.nonRetryable(
            `Cannot encore "${targetPlayerId}" — session is destroyed. Use recruit to start a fresh session.`,
          );
        }

        // Step 3 — reap any lingering attachment so `claimAttachment` below takes the
        // fresh-claim branch in §9.2 (not the conflict branch). Idempotent on `detached`.
        if (info.phase !== 'detached') {
          await handle.executeUpdate(forceDetachUpdate, {
            args: [{
              reason: 'restart',
              ...(info.currentAttachment ? { expectedAttachmentId: info.currentAttachment.attachmentId } : {}),
              gracePeriodMs: 0,
            }],
          });
        }

        // Step 4 — gather target metadata for the context message and spawn routing.
        const metadata = await handle.query(getMetadataQuery) as SessionMetadata;
        const part = await handle.query(getPartQuery) as string;
        const allMessages = await handle.query(allMessagesQuery) as Message[];

        const agentTypeRaw = (metadata.agentType as string) || 'claude';
        const agentType: AgentType = agentTypeRaw === 'copilot' ? 'copilot' : 'claude';
        const adapterId = metadata.adapterId || (agentType === 'copilot' ? 'copilot' : 'claude-code');
        const adapterClass: AdapterClass = agentType === 'copilot' ? 'sdk' : 'interactive';

        // Step 5 — claim a fresh attachment on the target's preferred host (or last-known).
        const targetHost = info.preferredHost ?? metadata.hostname;
        const token = await handle.executeUpdate(claimAttachmentUpdate, {
          args: [{
            host: targetHost,
            adapterId,
            adapterClass,
            leaseMs: 90_000,
          }],
        });

        // Step 6 — build and inject the context message.
        const recentMessages = allMessages.slice(-contextMessageCount);
        const msgSummary = recentMessages.length > 0
          ? recentMessages.map((m) => `[${m.from}] ${m.text.slice(0, PREVIEW_MAX_LENGTH)}`).join('\n')
          : '(no recent messages)';

        const contextMessage = [
          `🎵 **Encore** — you've been revived by ${fromPlayerId}.`,
          part ? `Your last status: ${part}` : '',
          `Recent messages (last ${recentMessages.length}):`,
          msgSummary,
          '',
          'Resume where you left off. Use `ensemble` to see who is active.',
        ].filter(Boolean).join('\n');

        await handle.signal(receiveMessageSignal, {
          from: fromPlayerId,
          text: contextMessage,
          responseRequested: false,
        });

        // Step 7 — enqueue the spawn on the target's own outbox. The target's `case 'spawn':`
        // dispatches the spawnProcess activity on the per-host task queue; its §8.4 catch
        // handles spawn failure by force-detaching the just-claimed attachment.
        const { spawnEntryId } = await handle.executeUpdate(enqueueSpawnUpdate, {
          args: [{
            host: targetHost,
            attachmentId: token.attachmentId,
            runId: token.runId,
            resume: true,
            ...(metadata.sessionId ? { sessionId: metadata.sessionId } : {}),
            adapterId,
          }],
        });

        log(`Encore prepared for "${targetPlayerId}" — attachmentId=${token.attachmentId}, spawnEntryId=${spawnEntryId}`);

        return {
          success: true,
          attachmentId: token.attachmentId,
          spawnEntryId,
        };
      } catch (err) {
        if (err instanceof ApplicationFailure) throw err;
        throw ApplicationFailure.nonRetryable(
          `Encore failed for "${targetPlayerId}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },

    async releasePlayer(input: ReleasePlayerInput): Promise<OutboxActivityResult> {
      const { ensemble, targetPlayerId } = input;
      try {
        const handle = await resolveSession(client, ensemble, targetPlayerId);
        if (!handle) {
          throw ApplicationFailure.nonRetryable(`No session found for "${targetPlayerId}"`);
        }

        // Check if the session is actually held (outbox locked)
        const isLocked = await handle.query('outboxLocked') as boolean;
        if (!isLocked) {
          throw ApplicationFailure.nonRetryable(
            `Cannot release "${targetPlayerId}" — session is not held (outbox not locked).`,
          );
        }

        // Signal the session to release — unlocks outbox and delivers held message
        await handle.signal('releaseHeld');

        log(`Released held session "${targetPlayerId}"`);
        return { success: true };
      } catch (err) {
        if (err instanceof ApplicationFailure) throw err;
        throw ApplicationFailure.nonRetryable(
          `Release failed for "${targetPlayerId}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  };
}
