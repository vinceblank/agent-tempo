import { Client, WorkflowIdConflictPolicy } from '@temporalio/client';
import { ApplicationFailure } from '@temporalio/activity';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { Config, conductorWorkflowId, sessionWorkflowId } from '../config';
import { AgentType, SessionInput, AdapterClass, AttachmentInfo, AttachmentPhase, MockMode, SessionMetadata, Message, DetachReason, GuardrailPolicy } from '../types';
import {
  PREVIEW_MAX_LENGTH,
  DEFAULT_RESTART_DETACH_DEADLINE_MS,
  DEFAULT_RESTART_LEASE_MS,
} from '../utils/validation';
import { ENSEMBLE_SENTINEL_FLAG } from '../constants';
import { getGitInfo } from '../git-info';
import { spawnInTerminal, spawnCopilotBridge, spawnClaudeApiAdapter, spawnOpenCodeAdapter, spawnClaudeCodeHeadlessAdapter, spawnPiHeadless } from '../spawn';
import type { ClaudeCodeHeadlessPermissionMode } from '../adapters/claude-code-headless/types';
import { ENV } from '../config';
import type { IngestTokenRegistry } from '../http/ingest-registry';
import { resolveSession } from './resolve';
import { resolveAgentType } from '../ensemble/agent-types';
import { defaultPart } from '../utils/default-part';
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
  playerStateQuery,
  setPendingResetSignal,
} from '../workflows/signals';
import { PLAYER_STATE_DEFAULT_KEY } from '../utils/validation';
import type { PlayerStateEntry } from '../types';

const log = (...args: unknown[]) => console.error('[agent-tempo:outbox]', ...args);

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
  /**
   * #357: Stable id shared across every fan-out target of one
   * `broadcast` invocation. Threaded through to the target's
   * `receiveMessage` signal so the stored Message carries it for
   * later TUI grouping. `undefined` for non-broadcast direct cues.
   */
  broadcastId?: string;
  /**
   * #318: Coat-check ticket referencing content stashed via
   * `coat_check_put`. Threaded through to the target's `receiveMessage`
   * signal so the stored `Message` carries it and the recipient can
   * pull the body via `coat_check_get`. `undefined` for cues without an
   * attachment.
   */
  attachmentTicket?: string;
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
  /**
   * #131 Phase C — model id for the claude-api adapter (e.g.
   * `claude-opus-4-7`). Persisted onto `SessionMetadata.model` so restart
   * can recover the original choice. Ignored when `agent !== 'claude-api'`.
   */
  model?: string;
  /**
   * #700 (P2 / G) — guardrail posture. Persisted onto
   * `SessionMetadata.guardrailPolicy` so restart recovers it. Ignored when
   * `agent !== 'pi'`. Absent ⇒ autonomous.
   */
  guardrailPolicy?: GuardrailPolicy;
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

export interface DeliverResetInput {
  ensemble: string;
  targetPlayerId: string;
  /** Correlation id (the originating outbox entry id) — the extension acks with it. */
  resetId: string;
  /** Clean-wipe (D14 default true). */
  fresh: boolean;
  reason?: string;
  /** Who requested the reset (audit). */
  requestedBy?: string;
}

export interface DeliverRestartInput {
  ensemble: string;
  targetPlayerId: string;
  invokerPlayerId: string;
  force?: boolean;
  host?: string;
  fresh?: boolean;
  contextMessages?: number;
  /** #334 PR-2 — see {@link RestartOutboxEntry.loadFromState}. */
  loadFromState?: boolean | string;
  /** #334 PR-2 — see {@link RestartOutboxEntry.transcript}. */
  transcript?: 'suppress' | 'replay';
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
  /**
   * Mock-adapter configuration (ADR 0014 §4.2). Only present when `agent === 'mock'`.
   * Forwarded into the spawned subprocess as `AGENT_TEMPO_MOCK_MODE` /
   * `AGENT_TEMPO_MOCK_SCENARIO` env vars. Chaos mode also reads
   * `AGENT_TEMPO_MOCK_CHAOS_*` from the daemon's env (inherited via spawn).
   */
  mockMode?: MockMode;
  mockScenario?: string;
  /**
   * #131 / #449 Phase C — model id for the headless adapters.
   *   - `claude-api`: bare Anthropic id (e.g. `claude-opus-4-7`); forwarded
   *     as `AGENT_TEMPO_API_MODEL`.
   *   - `opencode`: combined provider/model (e.g. `anthropic/claude-opus-4-7`,
   *     `openai/gpt-4o`); forwarded as `AGENT_TEMPO_OPENCODE_MODEL`.
   * The spawn dispatcher inspects `agent` to pick the right env var. Only
   * meaningful for those two adapters; ignored otherwise. Falls back inside
   * the adapter to its respective env var → constants-pinned default.
   */
  model?: string;
  /**
   * #520 — claude-code-headless permission mode. Forwarded as
   * `AGENT_TEMPO_PERMISSION_MODE` to the spawned adapter; the adapter
   * passes it through to per-turn `claude -p --permission-mode <mode>`.
   * Only meaningful when `agent === 'claude-code-headless'`. Mutually
   * exclusive with {@link dangerouslySkipPermissions}. Type imported from
   * the canonical {@link ClaudeCodeHeadlessPermissionMode} tuple.
   */
  permissionMode?: ClaudeCodeHeadlessPermissionMode;
  /**
   * #520 — claude-code-headless dangerous-skip-permissions opt-in.
   * Forwarded as `AGENT_TEMPO_DANGEROUSLY_SKIP_PERMISSIONS=1`. Only
   * meaningful when `agent === 'claude-code-headless'`. Mutually
   * exclusive with {@link permissionMode}.
   */
  dangerouslySkipPermissions?: boolean;
  /**
   * Phase 3a / MD-C — headless Pi tool-class policy. Forwarded as
   * `AGENT_TEMPO_TOOL_ACCESS`. Only meaningful when `agent === 'pi'`. One of
   * `'restricted'` (default; Bash hard-blocked) | `'standard'` | `'full'`.
   * Inline literal — kept off the workflow-sandbox import path (see the
   * RecruitOutboxEntry note in src/types.ts).
   */
  toolAccess?: 'restricted' | 'standard' | 'full';
  /**
   * #700 (P2 / G) — headless Pi guardrail posture. Forwarded as
   * `AGENT_TEMPO_GUARDRAIL_POLICY`. Sourced from durable
   * `SessionMetadata.guardrailPolicy` on (re)spawn. Only meaningful when
   * `agent === 'pi'`. Absent ⇒ autonomous (the extension default).
   */
  guardrailPolicy?: GuardrailPolicy;
}

// ── Activity result type ──

export interface OutboxActivityResult {
  success: boolean;
  error?: string;
  /**
   * Human-readable note for a non-failure outcome the caller may surface — e.g.
   * #676 FIX-3's "skipped duplicate spawn" no-op. Floor today is the daemon log;
   * structured here so a future workflow-side relay can surface it to the operator.
   */
  note?: string;
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
  deliverReset(input: DeliverResetInput): Promise<OutboxActivityResult>;
  /**
   * OS-level child-process-tree kill for the target session. Runs on the per-host
   * task queue (`agent-tempo-{hostname}`) so the kill happens where the process
   * actually lives. See `src/activities/hard-terminate.ts` and issue #159 Gap 2.
   */
  hardTerminateAttachment(input: HardTerminateInput): Promise<HardTerminateResult>;
}

/**
 * Create outbox delivery activities bound to a Temporal client and config.
 * The returned object is registered with the worker as activities.
 *
 * @param ingestTokens 3c Tier-2 ingest-auth registry (daemon-owned singleton,
 *   shared with the HTTP `/inner/ingest` + `/inner/presence` validators). The pi
 *   spawn branch MINTS a per-player token here (single-token-per-workflowId —
 *   re-mint REPLACES, so a restart naturally revokes the stale token); the
 *   destroy path REVOKES it. Optional: undefined disables ingest-token minting
 *   (e.g. the dev test harness that constructs activities without the daemon).
 */
/**
 * #676 FIX-3 — should spawnProcess SKIP as a duplicate dispatch? TRUE iff this is
 * a FRESH recruit (no `attachmentId` handoff) AND a live adapter is already
 * attached. A restart/migrate carries `attachmentId` (the handoff to its fresh
 * claim — phase is legitimately live) → never skipped. Pure + exported for tests.
 */
export function shouldSkipDuplicateSpawn(
  attachmentId: string | undefined,
  phase: AttachmentPhase,
): boolean {
  if (attachmentId) return false; // restart/migrate handoff — must spawn
  return phase === 'attached' || phase === 'processing' || phase === 'awaiting';
}

export function createOutboxActivities(
  client: Client,
  config: Config,
  ingestTokens?: IngestTokenRegistry,
): OutboxActivities {
  return {
    async deliverCue(input: DeliverCueInput): Promise<OutboxActivityResult> {
      const { ensemble, fromPlayerId, targetPlayerId, message, broadcastId, attachmentTicket } = input;
      try {
        const handle = await resolveSession(client, ensemble, targetPlayerId);
        if (!handle) {
          throw ApplicationFailure.nonRetryable(`No active session found for "${targetPlayerId}"`);
        }
        // #357 + #318: thread broadcastId / attachmentTicket onto the
        // receiver's `receiveMessage` signal payload. Both fields are
        // additive optionals — direct cues omit one or both.
        await handle.signal('receiveMessage', {
          from: fromPlayerId,
          text: message,
          ...(broadcastId !== undefined ? { broadcastId } : {}),
          ...(attachmentTicket !== undefined ? { attachmentTicket } : {}),
        });
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
      const { ensemble, targetName, workDir, isConductor, initialMessage, fromPlayerId, agent, systemPrompt, taskQueue, agentDefinition, agentDefinitionDescription, held, model, guardrailPolicy } = input;
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
            // #131 / #449 Phase C — persist the claude-api / opencode model
            // on durable metadata so restart can recover the original choice
            // across CAN. Both adapters use the same `model` metadata field
            // (different value shapes — bare vs `provider/model`) — the spawn
            // path inspects `metadata.agentType` to know which env var to set.
            ...((agent === 'claude-api' || agent === 'opencode' || agent === 'pi') && model ? { model } : {}),
            // #700 (P2 / G) — persist the guardrail posture on DURABLE metadata so
            // arm-at-boot reads the real posture on every (re)attach; a restart
            // can't silently downgrade a supervised player. Only when explicitly
            // set (absent ⇒ autonomous). Pi-only for P2.
            ...(agent === 'pi' && guardrailPolicy ? { guardrailPolicy } : {}),
            ...(agentDefinition ? { playerType: agentDefinition } : {}),
            ...(agentDefinitionDescription ? { playerTypeDescription: agentDefinitionDescription } : {}),
            recruitedBy: fromPlayerId,
          },
          // Issue #450 — derive default `part` from the recruited
          // player type so a freshly recruited session reads as e.g.
          // `'Engineer session'` instead of the role-agnostic
          // `'Session in <basename>'` placeholder.
          autoSummary: defaultPart({
            playerType: agentDefinition,
            isConductor,
            workDir,
            adapterType: agent,
          }),
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

        await client.workflow.start('agentSessionWorkflow', {
          workflowId,
          taskQueue,
          args: [sessionInput],
          workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
          searchAttributes: {
            ...(gitRoot ? { AgentTempoGitRoot: [gitRoot] } : {}),
            AgentTempoHostname: [os.hostname()],
            AgentTempoEnsemble: [ensemble],
            AgentTempoPlayerId: [targetName],
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
      const { targetName, workDir, isConductor, agent, systemPrompt, ensemble, temporalAddress, temporalNamespace, agentDefinition, agentDefinitionPath, nativeResolvable, resume, sessionId, allowedTools, claudeBin, attachmentId, attachmentRunId, adapterId, mockMode, mockScenario, model, permissionMode, dangerouslySkipPermissions, toolAccess, guardrailPolicy } = input;
      // Read secrets from the worker's config closure — never from workflow state
      const { temporalApiKey, temporalTlsCertPath, temporalTlsKeyPath } = config;

      // #676 FIX-3 — double-dispatch backstop (ACTIVITY-level; no workflow/bundle
      // touch). A FRESH recruit (NO attachmentId) of a name that ALREADY has a live
      // adapter is a duplicate dispatch → skip the spawn so we don't race a second
      // adapter for the lease. attachmentId PRESENT = a restart/migrate HANDOFF to a
      // fresh claim (phase is legitimately {attached|processing|awaiting} from that
      // claim) → MUST NOT skip, or restart attaches to a non-existent adapter.
      // Guard ABOVE the agent switch so it covers every agent. TOCTOU best-effort —
      // claimAttachment's expectedAttachmentId arbitrates the rare race.
      if (!attachmentId) {
        const checkWorkflowId = isConductor ? conductorWorkflowId(ensemble) : sessionWorkflowId(ensemble, targetName);
        try {
          const info = await client.workflow.getHandle(checkWorkflowId).query(attachmentInfoQuery) as AttachmentInfo;
          if (shouldSkipDuplicateSpawn(attachmentId, info.phase)) {
            // Corrected message (architect): force does NOT bypass this skip under
            // FIX-3(a), so do NOT tell the operator to pass force. Replace-a-live-
            // adapter is restart/migrate's lane; a stale session self-heals in ~90s.
            const note =
              `recruit skipped: player "${targetName}" is already attached (phase=${info.phase}) — ` +
              `spawning now would create a duplicate adapter racing the live session. To replace it, ` +
              `use \`restart\` (same host) or \`migrate\` (other host). If the session is actually stale, ` +
              `its lease expires and it's reaped within ~90s, after which recruit spawns normally.`;
            log(`[#676 FIX-3] ${note}`);
            return { success: true, note };
          }
        } catch (err) {
          // Not-queryable-yet / transient → fall through to spawn (best-effort guard).
          log(`FIX-3 attachment pre-check inconclusive for "${targetName}" — proceeding to spawn: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      try {
        if (agent === 'mock') {
          // ADR 0014 PR-2 — mock adapter spawns headless. No terminal,
          // no Claude binary, no MCP server child. Talks to Temporal
          // directly and posts every action through the standard outbox.
          const { spawnMockAdapter } = await import('../spawn');
          const { pid } = spawnMockAdapter({
            name: targetName,
            ensemble,
            temporalAddress,
            temporalNamespace,
            temporalApiKey,
            temporalTlsCertPath,
            temporalTlsKeyPath,
            isConductor,
            workDir,
            mockMode,
            mockScenario,
            attachmentId,
            attachmentRunId,
            adapterId,
          });
          log(`Spawned mock adapter (pid ${pid}) in ${workDir} as "${targetName}" (mode=${mockMode ?? 'echo'}${attachmentId ? `, attachmentId=${attachmentId}` : ''})`);
        } else if (agent === 'copilot') {
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
        } else if (agent === 'claude-api') {
          // #131 Phase C — headless Anthropic Messages API adapter. No
          // terminal, no Claude binary, no MCP-server child process. The
          // adapter boots an in-process MCP server + paired client and
          // talks to Anthropic via @anthropic-ai/sdk. Tool surface is
          // MCP-only in v1; file-edit/shell/web tools deferred to Phase 2.
          if (allowedTools && allowedTools.length > 0) {
            log(`Warning: allowedTools [${allowedTools.join(', ')}] specified for claude-api agent "${targetName}" — claude-api adapter does not gate tools per recruit, skipping`);
          }
          const { pid } = spawnClaudeApiAdapter({
            name: targetName,
            ensemble,
            temporalAddress,
            temporalNamespace,
            temporalApiKey,
            temporalTlsCertPath,
            temporalTlsKeyPath,
            isConductor,
            workDir,
            model,
            attachmentId,
            attachmentRunId,
            adapterId,
          });
          log(`Spawned claude-api adapter (pid ${pid}) in ${workDir} as "${targetName}"${model ? ` (model=${model})` : ''}${attachmentId ? ` (attachmentId=${attachmentId})` : ''}`);
        } else if (agent === 'opencode') {
          // #449 Phase C — headless multi-provider adapter via OpenCode.
          // No terminal, no Claude binary. The adapter manages its own
          // `opencode serve` subprocess (probed-free port, hardcoded
          // loopback bind); tools dispatch via OpenCode's MCP-native config
          // block (it spawns dist/server.js as its own MCP child). Per-tool
          // allowlists don't apply — opencode players have full file/shell/
          // web access via OpenCode's built-in tool registry.
          if (allowedTools && allowedTools.length > 0) {
            log(`Warning: allowedTools [${allowedTools.join(', ')}] specified for opencode agent "${targetName}" — opencode adapter does not gate tools per recruit, skipping`);
          }
          const { pid } = spawnOpenCodeAdapter({
            name: targetName,
            ensemble,
            temporalAddress,
            temporalNamespace,
            temporalApiKey,
            temporalTlsCertPath,
            temporalTlsKeyPath,
            isConductor,
            workDir,
            model,
            attachmentId,
            attachmentRunId,
            adapterId,
          });
          log(`Spawned opencode adapter (pid ${pid}) in ${workDir} as "${targetName}"${model ? ` (model=${model})` : ''}${attachmentId ? ` (attachmentId=${attachmentId})` : ''}`);
        } else if (agent === 'claude-code-headless') {
          // #520 — headless Claude Code adapter. Spawns the host's `claude` CLI
          // as a per-turn subprocess; uses the operator's existing OAuth login
          // so turns bill against subscription extra-usage credits. The adapter
          // process itself is a Node subprocess (this branch); the per-turn
          // `claude -p` invocations happen inside the adapter's invokeSdk loop
          // (PR-3). Per-tool allowlists don't apply — claude-code-headless
          // players inherit the full Claude Code tool surface.
          if (allowedTools && allowedTools.length > 0) {
            log(`Warning: allowedTools [${allowedTools.join(', ')}] specified for claude-code-headless agent "${targetName}" — claude-code-headless adapter does not gate tools per recruit, skipping`);
          }
          const { pid } = spawnClaudeCodeHeadlessAdapter({
            name: targetName,
            ensemble,
            temporalAddress,
            temporalNamespace,
            temporalApiKey,
            temporalTlsCertPath,
            temporalTlsKeyPath,
            isConductor,
            workDir,
            permissionMode,
            dangerouslySkipPermissions,
            attachmentId,
            attachmentRunId,
            adapterId,
          });
          log(`Spawned claude-code-headless adapter (pid ${pid}) in ${workDir} as "${targetName}"${permissionMode ? ` (permissionMode=${permissionMode})` : ''}${dangerouslySkipPermissions ? ' (dangerouslySkipPermissions=true)' : ''}${attachmentId ? ` (attachmentId=${attachmentId})` : ''}`);
        } else if (agent === 'pi') {
          // Phase 3a — headless Pi runtime. Injects the src/pi extension into
          // Pi's createAgentSession; the module-scope singleton owns the
          // lifecycle (claim/heartbeat/tools/cue-pump). Tool access is governed
          // by the MD-C `toolAccess` policy (restricted hard-blocks Bash via the
          // extension's tool_call gate), NOT per-tool allowlists.
          if (allowedTools && allowedTools.length > 0) {
            log(`Warning: allowedTools [${allowedTools.join(', ')}] specified for pi agent "${targetName}" — Pi tool access is governed by toolAccess (MD-C), skipping allowedTools`);
          }
          // 3c Tier-2 — mint a per-player ingest token scoped to this player's
          // session workflowId so the headless Pi subprocess can authenticate its
          // `POST /inner/ingest` frames. Single-token-per-workflowId (mint
          // REPLACES) means a restart re-mints and naturally revokes the stale
          // token. Injected into the subprocess env as AGENT_TEMPO_INGEST_TOKEN.
          const ingestToken = ingestTokens?.mint(sessionWorkflowId(ensemble, targetName));
          const { pid } = spawnPiHeadless({
            name: targetName,
            ensemble,
            temporalAddress,
            temporalNamespace,
            temporalApiKey,
            temporalTlsCertPath,
            temporalTlsKeyPath,
            isConductor,
            workDir,
            model,
            // Restart-resume: continue the prior Pi conversation only on a
            // restart (resume=true); a fresh recruit starts a new Pi session.
            continueSessionId: resume ? sessionId : undefined,
            toolAccess,
            guardrailPolicy,
            attachmentId,
            attachmentRunId,
            adapterId,
            ingestToken,
          });
          log(`Spawned pi headless adapter (pid ${pid}) in ${workDir} as "${targetName}" (toolAccess=${toolAccess ?? 'restricted'})${guardrailPolicy ? ` (guardrailPolicy=${guardrailPolicy})` : ''}${model ? ` (model=${model})` : ''}${resume && sessionId ? ` (continue=${sessionId})` : ''}${attachmentId ? ` (attachmentId=${attachmentId})` : ''}`);
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
            '--dangerously-load-development-channels', 'server:agent-tempo',
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
        // 3c Tier-2 — revoke the player's ingest token on detach so a dead
        // holder's loopback POST /inner/ingest can no longer authenticate once
        // the player goes away. Mirrors the destroy-side revoke; idempotent and a
        // no-op for non-Pi players (they never minted one). Re-attach re-mints.
        ingestTokens?.revoke(sessionWorkflowId(ensemble, targetPlayerId));
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

        // 3c Tier-2 — revoke the player's ingest token on destroy so a dead
        // holder's loopback POST /inner/ingest can no longer authenticate.
        // Idempotent; a no-op for non-Pi players (they never minted one).
        // NOTE (security cond. 2): the ingest endpoint authenticates on TOKEN
        // ALONE — it does not inspect workflow phase (neither rejects nor
        // buffers detached-phase players). So the residual surface is bounded
        // not by phase-checking but by (a) this destroy-revoke and (b) the
        // single-token-per-workflowId replacement on re-attach/restart.
        // TODO(Phase 4): wire aggregate player-gone detection →
        // revokeIngestToken(workflowId) on detach — deferred; residual surface
        // negligible (dead holder + loopback-only + single-token replacement).
        ingestTokens?.revoke(sessionWorkflowId(ensemble, targetPlayerId));

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
     * D14 `deliverReset` — set a `pendingReset` flag on the target via
     * `setPendingResetSignal` (a signal, like deliverCue — NOT a direct
     * subprocess call). The Pi extension polls `pendingResetQuery`, performs the
     * clean-wipe (`newSession`), then clears it via `ackResetSignal(resetId)`.
     */
    async deliverReset(input: DeliverResetInput): Promise<OutboxActivityResult> {
      const { ensemble, targetPlayerId, resetId, fresh, reason, requestedBy } = input;
      try {
        const handle = await resolveSession(client, ensemble, targetPlayerId);
        if (!handle) {
          throw ApplicationFailure.nonRetryable(`No session found for "${targetPlayerId}"`);
        }
        await handle.signal(setPendingResetSignal, {
          resetId,
          fresh,
          ...(reason !== undefined ? { reason } : {}),
          ...(requestedBy !== undefined ? { requestedBy } : {}),
        });
        log(`Reset queued for "${targetPlayerId}"${reason ? ` (reason: ${reason})` : ''}`);
        return { success: true };
      } catch (err) {
        classifyAndRethrow(err, `Reset failed for "${targetPlayerId}"`);
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
      const { ensemble, targetPlayerId, invokerPlayerId, force = false, host, fresh = false, contextMessages = 10, loadFromState, transcript } = input;
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
        // ADR 0014 PR-2 — mock adapter restart path. `mock` is dev-mode only;
        // a metadata.agentType='mock' here implies the dev daemon previously
        // spawned this player and is now restarting it (encore / migrate).
        // Prod restart never lands here for `mock` because gate 3 in
        // src/tools/recruit.ts rejected the original recruit.
        const rawAgent = metadata.agentType as string | undefined;
        // #131 / #449 Phase C — claude-api / opencode join copilot / mock
        // as recognized sdk-class agents here so restart/encore/migrate of
        // a headless player resolves to the right adapterId + class. Without
        // this branch, restart falls through to 'claude' → 'interactive'
        // and the spawn path picks the terminal Claude Code path.
        const agentType: AgentType = rawAgent === 'copilot'
          ? 'copilot'
          : rawAgent === 'mock'
            ? 'mock'
            : rawAgent === 'claude-api'
              ? 'claude-api'
              : rawAgent === 'opencode'
                ? 'opencode'
                : rawAgent === 'claude-code-headless'
                  ? 'claude-code-headless'
                  : 'claude';
        const adapterId = metadata.adapterId
          || (agentType === 'copilot'
            ? 'copilot'
            : agentType === 'mock'
              ? 'mock'
              : agentType === 'claude-api'
                ? 'claude-api'
                : agentType === 'opencode'
                  ? 'opencode'
                  : agentType === 'claude-code-headless'
                    ? 'claude-code-headless'
                    : 'claude-code');
        const adapterClass: AdapterClass = agentType === 'claude' ? 'interactive' : 'sdk';
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

        // Step 5 — context seed (saved state and/or transcript replay).
        //
        // #334 PR-2: `loadFromState` lets the player choose to seed the new
        // session from a curated state slot instead of (or alongside) the
        // existing transcript replay. The semantics matrix (design §4.4):
        //
        //   loadFromState set      → seed from saved state, suppress replay by default
        //   loadFromState + 'replay' → stack: saved state first, then transcript
        //   loadFromState set, slot empty → graceful fallback to transcript replay
        //   loadFromState absent   → existing behaviour (replay governed by `fresh`)
        //
        // Backward compat is structural (no `patched()` marker — see ADR 0011
        // §Consequences and design §7.3): old outbox entries omit
        // `loadFromState`, `wantsState` evaluates falsy, and execution falls
        // through to the original transcript-replay block bit-for-bit.
        const wantsState = loadFromState !== undefined;
        const wantsTranscriptByFlag = transcript === 'replay';
        let saved: PlayerStateEntry | null = null;

        if (wantsState) {
          const stateKey = typeof loadFromState === 'string' ? loadFromState : PLAYER_STATE_DEFAULT_KEY;
          saved = await handle.query(playerStateQuery, { key: stateKey }) as PlayerStateEntry | null;
          if (saved) {
            await handle.signal(receiveMessageSignal, {
              from: 'self-restart',
              text: `🎵 **Restored state — "${stateKey}"** (saved ${saved.savedAt} by ${saved.savedBy})\n\n${saved.content}`,
              responseRequested: false,
            });
          } else {
            log(`Restart loadFromState requested for slot "${stateKey}" but slot is empty — falling back to transcript replay`);
            // UX-friendly fallback per design §4.4: replay the transcript as
            // if the caller had not passed `loadFromState`. The fall-through
            // below picks this up via `wantsState && !saved`.
          }
        }

        // Replay the transcript when (a) loadFromState was not requested, OR
        // (b) caller opted into stacking via `transcript: 'replay'`, OR
        // (c) loadFromState was requested but the slot was empty (fallback).
        // The pre-existing `fresh` flag still wins — `fresh: true` skips
        // replay regardless of state-seeding outcome.
        const wantsTranscript = !wantsState || wantsTranscriptByFlag || (wantsState && !saved);
        if (!fresh && wantsTranscript) {
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
        // stored sessionId.
        //
        // #306: `/restart` ALWAYS spawns a fresh Claude Code process — never
        // `--resume <id>`. The transcript `.jsonl` for the prior `spawnSessionId`
        // is NOT guaranteed to have been flushed to disk before the prior
        // adapter was hard-terminated (Windows `taskkill /T /F` is synchronous
        // and unconditional). Claude Code then errors out with "No conversation
        // found with session ID" and the new terminal drops to shell.
        //
        // Context preservation is already handled by the Step 5 replay above —
        // we re-send recent messages to the fresh session. That's authoritative;
        // the session-id `--resume` path was only ever a bonus on top. So we
        // mint a new UUID on every restart, persist it to metadata, and never
        // pass `resume: true` to the spawn.
        const spawnSessionId = crypto.randomUUID();
        await handle.signal(updateMetadataSignal, { sessionId: spawnSessionId });

        // Issue #184: re-resolve on the invoker host against the session's
        // workDir (NOT the daemon's process.cwd — daemon runs elsewhere than
        // the session's project, so the project-tier lookup needs the session's
        // own cwd). `nativeResolvable` means the target can `--agent <name>`
        // from its own tier lookup; the path fallback is shipped-relative so
        // it exists on any host with agent-tempo installed — safe cross-host.
        const resolved = metadata.playerType
          ? resolveAgentType(metadata.playerType, metadata.workDir)
          : null;

        const { spawnEntryId } = await handle.executeUpdate(enqueueSpawnUpdate, {
          args: [{
            host: targetHost,
            attachmentId: token.attachmentId,
            runId: token.runId,
            // #306: `/restart` is always a fresh spawn (see comment above).
            resume: false,
            sessionId: spawnSessionId,
            adapterId,
            // #131 Phase C — claude-api adapter model carried across restart.
            // Read from durable session metadata so the restarted player runs
            // the same model the original recruit chose. Absent for non-claude-api
            // sessions and for legacy claude-api sessions recruited before the
            // metadata.model field landed (which fall back to the env / default
            // chain inside the adapter).
            ...(metadata.model !== undefined ? { model: metadata.model } : {}),
            // #700 (P2 / G) — guardrail posture carried across restart, read from
            // DURABLE SessionMetadata so the restarted player re-arms the SAME
            // posture (no silent downgrade). Absent ⇒ autonomous.
            ...(metadata.guardrailPolicy !== undefined ? { guardrailPolicy: metadata.guardrailPolicy } : {}),
            ...(resolved ? {
              agentDefinition: resolved.name,
              agentDefinitionPath: resolved.path,
              nativeResolvable: resolved.nativeResolvable,
            } : {}),
          }],
        });

        log(`Restart prepared for "${targetPlayerId}" — attachmentId=${token.attachmentId}, spawnEntryId=${spawnEntryId}, host=${targetHost}, fresh sessionId=${spawnSessionId}${fresh ? ' (context replay skipped)' : ''}`);
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
