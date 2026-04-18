import { Client, WorkflowIdConflictPolicy } from '@temporalio/client';
import { ApplicationFailure } from '@temporalio/activity';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { Config, conductorWorkflowId, sessionWorkflowId } from '../config';
import { AgentType, SessionInput, AdapterClass, AttachmentInfo, SessionMetadata, Message, DetachReason } from '../types';
import { PREVIEW_MAX_LENGTH } from '../utils/validation';
import { ENSEMBLE_SENTINEL_FLAG } from '../constants';
import { getGitInfo } from '../git-info';
import { spawnInTerminal, spawnCopilotBridge } from '../spawn';
import { ENV } from '../config';
import { resolveSession } from './resolve';
import { registry } from '../adapters';
import { hardTerminateAttachment, type HardTerminateInput, type HardTerminateResult } from './hard-terminate';
import {
  attachmentInfoQuery,
  requestDetachSignal,
  forceDetachUpdate,
  claimAttachmentUpdate,
  enqueueSpawnUpdate,
  destroyUpdate,
  getMetadataQuery,
  getPartQuery,
  allMessagesQuery,
  receiveMessageSignal,
  updateMetadataSignal,
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

export interface DeliverDetachInput {
  ensemble: string;
  targetPlayerId: string;
  reason?: DetachReason;
  deadlineMs?: number;
}

export interface DeliverDestroyInput {
  ensemble: string;
  targetPlayerId: string;
  reason?: string;
  terminatedBy: string;
  notifyConductor?: boolean;
}

export interface DeliverRestartInput {
  ensemble: string;
  targetPlayerId: string;
  invokerPlayerId: string;
  force?: boolean;
  host?: string;
  fresh?: boolean;
  contextMessages?: number;
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
  releasePlayer(input: ReleasePlayerInput): Promise<OutboxActivityResult>;
  deliverDetach(input: DeliverDetachInput): Promise<OutboxActivityResult>;
  deliverDestroy(input: DeliverDestroyInput): Promise<OutboxActivityResult>;
  deliverRestart(input: DeliverRestartInput): Promise<OutboxActivityResult>;
  /**
   * OS-level child-process-tree kill for the target session. Runs on the per-host
   * task queue (`claude-tempo-{hostname}`) so the kill happens where the process
   * actually lives. See `src/activities/hard-terminate.ts` and issue #159 Gap 2.
   */
  hardTerminateAttachment(input: HardTerminateInput): Promise<HardTerminateResult>;
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

          // ENSEMBLE_SENTINEL_FLAG carries the ensemble name into the spawned
          // claude.exe's CommandLine so hard-terminate can scope `destroy --all`
          // kills by ensemble (issue #180). See src/constants.ts for details.
          const spawnArgs = [
            '--dangerously-skip-permissions',
            '--dangerously-load-development-channels', 'server:claude-tempo',
            ENSEMBLE_SENTINEL_FLAG, ensemble,
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

    /**
     * PR-D `deliverDetach` — resolve target session and signal `requestDetach`.
     * Thin wrapper so the `detach` tool can enqueue through the outbox instead
     * of firing a signal directly from tool code (QA B1).
     */
    async deliverDetach(input: DeliverDetachInput): Promise<OutboxActivityResult> {
      const { ensemble, targetPlayerId, reason = 'user-stop', deadlineMs = 5_000 } = input;
      try {
        const handle = await resolveSession(client, ensemble, targetPlayerId);
        if (!handle) {
          throw ApplicationFailure.nonRetryable(`No session found for "${targetPlayerId}"`);
        }
        const info = await handle.query(attachmentInfoQuery) as AttachmentInfo;
        if (info.phase === 'detached') {
          log(`Detach skipped for "${targetPlayerId}" — already detached`);
          return { success: true };
        }
        if (info.phase === 'gone') {
          throw ApplicationFailure.nonRetryable(
            `Cannot detach "${targetPlayerId}" — session is destroyed`,
          );
        }
        await handle.signal(requestDetachSignal, { reason, deadlineMs });
        log(`Detach signaled for "${targetPlayerId}" (deadline=${deadlineMs}ms)`);
        return { success: true };
      } catch (err) {
        if (err instanceof ApplicationFailure) throw err;
        throw ApplicationFailure.nonRetryable(
          `Detach failed for "${targetPlayerId}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },

    /**
     * PR-D `deliverDestroy` — execute `destroyUpdate` on the target and
     * optionally notify the ensemble conductor via `receiveMessageSignal`
     * (typed constant, not a string literal per QA B2).
     */
    async deliverDestroy(input: DeliverDestroyInput): Promise<OutboxActivityResult> {
      const { ensemble, targetPlayerId, reason, terminatedBy, notifyConductor = true } = input;
      try {
        const handle = await resolveSession(client, ensemble, targetPlayerId);
        if (!handle) {
          throw ApplicationFailure.nonRetryable(`No session found for "${targetPlayerId}"`);
        }
        await handle.executeUpdate(destroyUpdate, {
          args: [{
            reason: reason ?? 'destroyed via destroy tool',
            terminatedBy,
          }],
        });
        log(`Destroyed "${targetPlayerId}"${reason ? ` (reason: ${reason})` : ''}`);

        if (notifyConductor) {
          try {
            const condId = conductorWorkflowId(ensemble);
            const condHandle = client.workflow.getHandle(condId);
            await condHandle.signal(receiveMessageSignal, {
              from: 'system',
              text: `Session "${targetPlayerId}" was destroyed by ${terminatedBy}${reason ? ` (reason: ${reason})` : ''}.`,
              responseRequested: false,
            });
          } catch {
            // Conductor may not exist — non-fatal.
          }
        }
        return { success: true };
      } catch (err) {
        if (err instanceof ApplicationFailure) throw err;
        throw ApplicationFailure.nonRetryable(
          `Destroy failed for "${targetPlayerId}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },

    /**
     * PR-D `deliverRestart` — owns the §8.2 restart algorithm on the target.
     * Graceful `requestDetach` → re-query phase → `forceDetach` (if --force
     * OR already was the TOCTOU case) → `claimAttachment` → optional context
     * replay via `receiveMessage` → `enqueueSpawn` on the target's outbox.
     *
     * Mid-algorithm failures surface as ApplicationFailures and retry per the
     * activity's policy. QA B3 — replaces the pre-PR-D tool-side
     * `performRestart` helper so no multi-step cross-workflow mutation happens
     * outside the outbox pattern.
     */
    async deliverRestart(input: DeliverRestartInput): Promise<OutboxActivityResult> {
      const { ensemble, targetPlayerId, invokerPlayerId, force = false, host, fresh = false, contextMessages = 10 } = input;
      try {
        const handle = await resolveSession(client, ensemble, targetPlayerId);
        if (!handle) {
          throw ApplicationFailure.nonRetryable(`No workflow for "${targetPlayerId}". Use recruit to start a fresh session.`);
        }

        // Step 1 — inspect phase. `gone` means the workflow COMPLETEd.
        const info = await handle.query(attachmentInfoQuery) as AttachmentInfo;
        if (info.phase === 'gone') {
          throw ApplicationFailure.nonRetryable(
            `"${targetPlayerId}" was destroyed. Use recruit to start a fresh session.`,
          );
        }

        // Step 2 — reap current attachment.
        if (info.phase !== 'detached' && info.phase !== 'booting') {
          if (info.phase === 'attached' || info.phase === 'awaiting' || info.phase === 'processing') {
            try {
              await handle.signal(requestDetachSignal, {
                reason: 'restart',
                deadlineMs: 5_000,
              });
            } catch {
              // Best-effort; force path handles it below.
            }
          }
          const info2 = await handle.query(attachmentInfoQuery) as AttachmentInfo;
          if (info2.phase !== 'detached' && info2.phase !== 'booting') {
            if (!force) {
              const holder = info2.currentAttachment?.hostname ?? 'unknown host';
              throw ApplicationFailure.nonRetryable(
                `"${targetPlayerId}" has a live attachment on ${holder} (phase: ${info2.phase}). ` +
                `Use force=true to steal the lease.`,
              );
            }
            // #159 Gap 2: OS-level kill is owned by the `forceDetachUpdate` handler itself
            // — it invokes `hardTerminateAttachment` on the reaped host's per-host queue
            // *before* flipping workflow state. That keeps the "kill first, then state"
            // ordering inside the durable workflow layer where it belongs; deliverRestart
            // just awaits the update and surfaces retryable errors to the caller.
            await handle.executeUpdate(forceDetachUpdate, {
              args: [{
                reason: 'restart',
                ...(info2.currentAttachment ? { expectedAttachmentId: info2.currentAttachment.attachmentId } : {}),
                gracePeriodMs: 0,
              }],
            });
          }
        }

        // Step 3 — metadata + adapter routing.
        const metadata = await handle.query(getMetadataQuery) as SessionMetadata;
        const agentType = (metadata.agentType as string) === 'copilot' ? 'copilot' : 'claude';
        const adapterId = metadata.adapterId || (agentType === 'copilot' ? 'copilot' : 'claude-code');
        const adapterClass: AdapterClass = agentType === 'copilot' ? 'sdk' : 'interactive';
        const targetHost = host ?? info.preferredHost ?? metadata.hostname;

        // Step 4 — claim fresh attachment.
        const token = await handle.executeUpdate(claimAttachmentUpdate, {
          args: [{
            host: targetHost,
            adapterId,
            adapterClass,
            leaseMs: 90_000,
          }],
        });

        // Step 5 — optional context replay.
        if (!fresh) {
          const [part, allMessages] = await Promise.all([
            handle.query(getPartQuery) as Promise<string>,
            handle.query(allMessagesQuery) as Promise<Message[]>,
          ]);
          const recent = allMessages.slice(-contextMessages);
          const summary = recent.length > 0
            ? recent.map((m) => `[${m.from}] ${m.text.slice(0, PREVIEW_MAX_LENGTH)}`).join('\n')
            : '(no recent messages)';
          const contextMessage = [
            `🎵 **Restart** — you've been revived by ${invokerPlayerId}.`,
            part ? `Your last status: ${part}` : '',
            `Recent messages (last ${recent.length}):`,
            summary,
            '',
            'Resume where you left off. Use `ensemble` to see who is active.',
          ].filter(Boolean).join('\n');
          await handle.signal(receiveMessageSignal, {
            from: invokerPlayerId,
            text: contextMessage,
            responseRequested: false,
          });
        }

        // Step 6 — enqueue the spawn.
        //
        // Issue #183: Claude Code rejects `--session-id <uuid>` when a transcript
        // already exists at `~/.claude/projects/<encoded-path>/<uuid>.jsonl`
        // ("Session ID already in use"). A prior failed spawn can leave that
        // file behind, wedging every subsequent `fresh` restart that reuses the
        // stored sessionId. Since `fresh` already skips `--resume`, we mint a
        // new UUID and persist it on the target's metadata so later non-fresh
        // restarts resume against the new transcript. Non-fresh restarts keep
        // the stored sessionId for deterministic `--resume`.
        let spawnSessionId = metadata.sessionId;
        if (fresh) {
          spawnSessionId = crypto.randomUUID();
          await handle.signal(updateMetadataSignal, { sessionId: spawnSessionId });
        }

        const { spawnEntryId } = await handle.executeUpdate(enqueueSpawnUpdate, {
          args: [{
            host: targetHost,
            attachmentId: token.attachmentId,
            runId: token.runId,
            resume: !fresh,
            ...(spawnSessionId ? { sessionId: spawnSessionId } : {}),
            adapterId,
          }],
        });

        log(`Restart prepared for "${targetPlayerId}" — attachmentId=${token.attachmentId}, spawnEntryId=${spawnEntryId}, host=${targetHost}${fresh ? ` (fresh sessionId=${spawnSessionId})` : ''}`);
        return { success: true };
      } catch (err) {
        if (err instanceof ApplicationFailure) throw err;
        throw ApplicationFailure.nonRetryable(
          `Restart failed for "${targetPlayerId}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },

    /**
     * #159 Gap 2 — OS-level process-tree kill. Registered on the per-host task queue so
     * it runs on the machine that actually hosts the child process. Never throws: the
     * returned `HardTerminateResult` tells the caller what happened (strategy, PIDs,
     * notes), which the workflow can log without blocking the state flip.
     */
    async hardTerminateAttachment(input: HardTerminateInput): Promise<HardTerminateResult> {
      return hardTerminateAttachment(input);
    },
  };
}
