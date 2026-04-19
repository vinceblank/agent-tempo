import { Client, WorkflowIdConflictPolicy } from '@temporalio/client';
import { ApplicationFailure } from '@temporalio/activity';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { Config, conductorWorkflowId, sessionWorkflowId } from '../config';
import { AgentType, SessionInput, AdapterClass, AttachmentInfo, SessionMetadata, Message, DetachReason } from '../types';
import {
  PREVIEW_MAX_LENGTH,
  DEFAULT_RESTART_DETACH_DEADLINE_MS,
  DEFAULT_RESTART_LEASE_MS,
} from '../utils/validation';
import { ENSEMBLE_SENTINEL_FLAG } from '../constants';
import { getGitInfo } from '../git-info';
import { spawnInTerminal, spawnCopilotBridge } from '../spawn';
import { ENV } from '../config';
import { resolveSession } from './resolve';
import { resolveAgentType } from '../ensemble/agent-types';
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

/**
 * Classify a Temporal client error raised by `handle.query` / `handle.signal`
 * / `handle.executeUpdate` as retryable (transient) vs permanent (#140).
 *
 * ## Contract
 * - Returns `true` → caller should **re-throw the underlying Error** so the
 *   activity's retry policy can back off and retry (per-worker config).
 * - Returns `false` → caller should wrap in `ApplicationFailure.nonRetryable`
 *   so the outbox surfaces a permanent failure and stops retrying.
 *
 * ## Safety posture
 * **Conservative default: unknown → non-retryable.** Over-classifying as
 * retryable causes infinite retry loops on genuinely permanent errors. The
 * activity will fail fast on unknown cases; a follow-up PR can whitelist more
 * transient signatures if we see false-permanent rates in the wild.
 *
 * ## Why name/message sniffing, not `instanceof`
 * Matches the established pattern in `src/adapters/terminal-error.ts`
 * `isTerminalWorkflowError`: the Temporal Node SDK surfaces slightly different
 * error shapes between `@temporalio/client`, the gRPC layer, and
 * `WorkflowUpdateFailedError` wrappers. Sniffing on name + message is resilient
 * across those shapes. Activity-side classification is kept separate here so
 * `src/activities/` has no adapter-module dependency.
 */
function isRetryableTemporalError(err: unknown): boolean {
  // ApplicationFailure instances have already been classified by the thrower
  // (nonRetryable=true/false). The calling code paths in this module only ask
  // about non-ApplicationFailure errors, but this guard makes the helper safe
  // to call unconditionally.
  if (err instanceof ApplicationFailure) return false;
  const e = err as { name?: string; message?: string } | undefined;
  const name = e?.name ?? '';
  const msg = e?.message ?? '';
  // ── Permanent: workflow is genuinely gone or validator rejected the op. ──
  if (
    name.includes('WorkflowNotFound') ||
    name.includes('WorkflowExecutionAlreadyCompleted') ||
    // Update rejected by the workflow-side validator (e.g. `WorkflowGone`
    // thrown from `claimAttachment`'s validator on a destroyed session).
    // A retry won't make the validator change its mind.
    name.includes('WorkflowUpdateFailed') ||
    msg.includes('WorkflowGone') ||
    msg.includes('workflow execution already completed')
  ) return false;
  // ── Transient: RPC / network / temporary SDK unavailability. ──
  if (
    name.includes('TransportError') ||
    name.includes('TimeoutError') ||
    msg.includes('DEADLINE_EXCEEDED') ||
    msg.includes('UNAVAILABLE') ||
    msg.includes('RESOURCE_EXHAUSTED') ||
    msg.includes('CANCELLED') ||
    /\bECONNRESET\b/.test(msg) ||
    /\bECONNREFUSED\b/.test(msg) ||
    /\bETIMEDOUT\b/.test(msg) ||
    /\bENOTFOUND\b/.test(msg) ||
    /\bEAI_AGAIN\b/.test(msg)
  ) return true;
  // Unknown shape — stay permanent (see "Safety posture" above).
  return false;
}

/**
 * Standard shape for the 3 §8.2 deliver activities' catch-all tail.
 * Centralises the branch so each activity body stays concise.
 *
 * - If `err` is already an `ApplicationFailure` (typed permanent — e.g. the
 *   explicit "not found" / "destroyed" throws), re-throw as-is.
 * - If `err` is retryable per {@link isRetryableTemporalError}, re-throw the
 *   original `Error` so the activity retry policy handles it.
 * - Otherwise wrap in `ApplicationFailure.nonRetryable` with a caller-supplied
 *   context prefix (e.g. `Detach failed for "alice"`).
 */
function classifyAndRethrow(err: unknown, contextPrefix: string): never {
  if (err instanceof ApplicationFailure) throw err;
  if (isRetryableTemporalError(err)) {
    // Re-throw the original so the activity retry policy backs off and retries.
    // Normalise non-Error throwables (extremely rare) into Error form.
    throw err instanceof Error ? err : new Error(String(err));
  }
  throw ApplicationFailure.nonRetryable(
    `${contextPrefix}: ${err instanceof Error ? err.message : String(err)}`,
  );
}

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
      try {
        const handle = await resolveSession(client, ensemble, targetPlayerId);
        if (!handle) {
          throw ApplicationFailure.nonRetryable(`No active session found for "${targetPlayerId}"`);
        }
        await handle.signal('receiveMessage', { from: fromPlayerId, text: message });
        return { success: true };
      } catch (err) {
        // #236: transient RPC errors (e.g. DEADLINE_EXCEEDED on the signal call)
        // retry per the activity policy; WorkflowNotFound / validator rejections
        // stay permanent. Unknown errors default to non-retryable.
        classifyAndRethrow(err, `Cue failed for "${targetPlayerId}"`);
      }
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
        // #236: describe() / signal() hitting a transient RPC error now retries;
        // WorkflowNotFound (conductor gone) stays permanent as before.
        classifyAndRethrow(err, 'Failed to deliver report to conductor');
      }
    },

    async terminateSession(input: TerminateSessionInput): Promise<OutboxActivityResult> {
      const { ensemble, targetPlayerId, terminatedBy } = input;
      try {
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
      } catch (err) {
        // #236: transient RPC on the destroy update now retries; validator rejection
        // (WorkflowGone, AttachmentMismatch) stays permanent.
        classifyAndRethrow(err, `Terminate failed for "${targetPlayerId}"`);
      }
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
        // #236: transient RPC during workflow.start (e.g. temporal server flap)
        // now retries; WorkflowNotFound / validation / auth failures stay permanent.
        // Note: this activity's pre-#236 catch was missing the ApplicationFailure
        // passthrough guard — `classifyAndRethrow` restores it for free.
        classifyAndRethrow(err, `Failed to start recruited session "${targetName}"`);
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
        // #236: spawnProcess throws predominantly OS-side errors (ENOENT/EACCES
        // on the claude binary, EAGAIN on process-table overflow). The classifier
        // is tuned for Temporal RPC; OS errors don't match its transient
        // signatures, so they still flow through as non-retryable — byte-for-byte
        // behavior preservation. The upside of going through the helper: if a
        // future OS error surfaces a transient shape we add to the classifier,
        // spawnProcess benefits automatically.
        classifyAndRethrow(err, `Failed to spawn process for "${targetName}"`);
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
        // #236: transient RPC on outboxLocked query / releaseHeld signal now
        // retries; WorkflowNotFound / not-held validation stay permanent.
        classifyAndRethrow(err, `Release failed for "${targetPlayerId}"`);
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
        // #140: re-throw transient RPC/network errors so the activity retry
        // policy handles them; permanent cases (validator rejection, workflow
        // gone, unknown) become `ApplicationFailure.nonRetryable`.
        classifyAndRethrow(err, `Detach failed for "${targetPlayerId}"`);
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
        // #140: transient errors (network, RPC timeout) become retryable;
        // permanent cases (WorkflowNotFound, validator rejection) stay
        // non-retryable. Unknown errors default to non-retryable.
        classifyAndRethrow(err, `Destroy failed for "${targetPlayerId}"`);
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
                deadlineMs: DEFAULT_RESTART_DETACH_DEADLINE_MS,
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
            leaseMs: DEFAULT_RESTART_LEASE_MS,
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

        // Issue #184: re-resolve on the invoker host against the session's
        // workDir (NOT the daemon's process.cwd — daemon runs elsewhere than
        // the session's project, so the project-tier lookup needs the session's
        // own cwd). `nativeResolvable` means the target can `--agent <name>`
        // from its own tier lookup; the path fallback is shipped-relative so
        // it exists on any host with claude-tempo installed — safe cross-host.
        const resolved = metadata.playerType
          ? resolveAgentType(metadata.playerType, metadata.workDir)
          : null;

        const { spawnEntryId } = await handle.executeUpdate(enqueueSpawnUpdate, {
          args: [{
            host: targetHost,
            attachmentId: token.attachmentId,
            runId: token.runId,
            resume: !fresh,
            ...(spawnSessionId ? { sessionId: spawnSessionId } : {}),
            adapterId,
            ...(resolved ? {
              agentDefinition: resolved.name,
              agentDefinitionPath: resolved.path,
              nativeResolvable: resolved.nativeResolvable,
            } : {}),
          }],
        });

        log(`Restart prepared for "${targetPlayerId}" — attachmentId=${token.attachmentId}, spawnEntryId=${spawnEntryId}, host=${targetHost}${fresh ? ` (fresh sessionId=${spawnSessionId})` : ''}`);
        return { success: true };
      } catch (err) {
        // #140: the §8.2 restart algorithm fires many RPCs; any of them may
        // hit a transient network/RPC error. Those get retried. Validator
        // rejections (e.g. claim race), workflow-gone, and unknown errors
        // stay permanent to avoid wedging the outbox on a dead target.
        classifyAndRethrow(err, `Restart failed for "${targetPlayerId}"`);
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
