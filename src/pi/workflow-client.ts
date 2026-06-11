/**
 * Thin CLIENT-SIDE Temporal wrapper for the Pi extension (D4 = (a)).
 *
 * The durable Temporal `Worker` stays in the daemon. This holds only a
 * `WorkflowClient` that signals/queries/updates the session workflow — it never
 * runs workflow code, so NOTHING here (or anywhere in src/pi/) is imported into
 * the V8 workflow sandbox. The determinism boundary is preserved.
 *
 * Reuses the existing wire surface verbatim:
 *   - `claimAttachment` / `heartbeat`        — lease lifecycle (drives `attached`)
 *   - `processingStart` / `processingEnd`    — drives `processing` / `awaiting`
 *   - `requestDetach` + `adapterExited`      — drives `draining` → `detached`
 *   - `submitOutbox`                         — report routing (outbox compliance)
 *   - `pendingMessages` + `markDelivered`    — cue intake + ack
 */
import { Client, QueryNotRegisteredError, type WorkflowHandle } from '@temporalio/client';
import { createTemporalConnection } from '../connection';
import { actionCountingInterceptors, withActionSource } from '../utils/action-counters';
import { MEMO_KEYS } from '../utils/search-attributes';
import { getConfig, sessionWorkflowId, type Config } from '../config';
import {
  claimAttachmentUpdate,
  heartbeatSignal,
  processingStartUpdate,
  processingEndUpdate,
  adapterExitedSignal,
  submitOutboxUpdate,
  pendingMessagesQuery,
  markDeliveredSignal,
  updateMetadataSignal,
  pendingResetQuery,
  ackResetSignal,
  pendingIntakeQuery,
  type PendingIntake,
} from '../workflows/signals';
import type {
  AttachmentToken,
  DetachReason,
  Message,
  OutboxEntryInput,
  PendingReset,
  SessionMetadata,
} from '../types';
import type { WorkflowAction } from './phase-driver';

/** Adapter identity advertised on claim. Pi interactive players are `interactive`-class. */
const PI_ADAPTER_ID = 'pi';
/**
 * MD-A liveness timings (Phase 2, maintainer-approved): 30s heartbeat / 90s
 * lease, holding the **lease = 3×heartbeat** invariant — a single (or even
 * second) missed beat never expires the lease, but a dead process is reaped
 * within ~one lease window. Parity with the other SDK adapters' `heartbeatMs`.
 * Overridable per-session via `PiWorkflowClientOptions.{leaseMs,heartbeatMs}`.
 * Exported so a guard test can assert the invariant doesn't silently drift.
 */
export const PI_HEARTBEAT_MS = 30_000;
export const PI_LEASE_MS = 90_000;

const log = (...args: unknown[]): void => {
  // eslint-disable-next-line no-console
  console.error('[agent-tempo:pi]', ...args);
};

/**
 * T0.3 (#750) — classify "this workflow doesn't serve that query" so
 * {@link PiWorkflowClient.fetchIntake} can fall back to the legacy two-query
 * pair against pre-#750 workflows. `instanceof` covers the SDK's typed
 * rejection; the message probes cover the same condition surfaced through
 * wrapper layers (mirrors the defensive style of `adapters/terminal-error.ts`).
 * Exported for unit testing.
 */
export function isQueryNotRegisteredError(err: unknown): boolean {
  if (err instanceof QueryNotRegisteredError) return true;
  const name = (err as Error)?.name ?? '';
  if (name === 'QueryNotRegisteredError') return true;
  const msg = (err as Error)?.message ?? '';
  return /unknown query|query handler.*not registered|not registered on this workflow/i.test(msg);
}

/** 3c Tier-1 — coarse activity sample piggybacked onto each heartbeat. */
export type CoarseSample = { currentTool: string | null; contextTokens?: number; contextPercent?: number };
/**
 * Supplies the latest coarse sample at heartbeat time. eng's inner-loop
 * publisher exposes exactly this via `getCoarseState()`; the extension wires it
 * in after constructing the publisher. Absent (default) → heartbeats carry no
 * coarse fields (backward-compatible with the 3a sender).
 */
export type CoarseProvider = () => CoarseSample | undefined;

export interface PiWorkflowClientOptions {
  client: Client;
  config: Config;
  metadata: SessionMetadata;
  leaseMs?: number;
  heartbeatMs?: number;
  /** 3c — optional coarse-activity provider (eng's `publisher.getCoarseState`). */
  coarseProvider?: CoarseProvider;
  /**
   * Restart/migrate handoff token (`AGENT_TEMPO_ATTACHMENT_ID`). When present,
   * `claim()` ADOPTS the pre-created attachment via the renewal branch instead of
   * racing a fresh claim — the clean anti-flap path the restart tool will use
   * (the read side of that spawn wiring is a tracked Phase 3 / restart carry-item;
   * this is the forward-compatible plumbing). Absent on a fresh recruit / manual
   * launch → fresh claim. Mirrors the existing adapters (`base.ts` startV2Lifecycle).
   */
  expectedAttachmentId?: string;
}

/**
 * One instance per attached Pi session — holds the session `WorkflowHandle`,
 * lease token, and heartbeat timer for one fixed-workflowId player. Tool
 * handlers reach this player's handle via the D11 lazy proxy (`get handle()`).
 */
export class PiWorkflowClient {
  private readonly client: Client;
  private readonly config: Config;
  private readonly metadata: SessionMetadata;
  private readonly leaseMs: number;
  private readonly heartbeatMs: number;
  private readonly expectedAttachmentId?: string;
  private coarseProvider?: CoarseProvider;

  private wfHandle: WorkflowHandle | null = null;
  private token: AttachmentToken | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: PiWorkflowClientOptions) {
    this.client = opts.client;
    this.config = opts.config;
    this.metadata = opts.metadata;
    this.leaseMs = opts.leaseMs ?? PI_LEASE_MS;
    this.heartbeatMs = opts.heartbeatMs ?? PI_HEARTBEAT_MS;
    this.expectedAttachmentId = opts.expectedAttachmentId;
    this.coarseProvider = opts.coarseProvider;
  }

  /**
   * 3c — wire the coarse-activity provider after construction (the inner-loop
   * publisher is created alongside, then handed in). Each heartbeat samples it.
   */
  setCoarseProvider(provider: CoarseProvider): void {
    this.coarseProvider = provider;
  }

  /** Build a client from config (connection-pooled; safe to share — see D12a). */
  static async connect(config: Config = getConfig()): Promise<Client> {
    const connection = await createTemporalConnection(config);
    return new Client({
      connection,
      namespace: config.temporalNamespace,
      interceptors: actionCountingInterceptors(),
    });
  }

  get attachmentId(): string | null {
    return this.token?.attachmentId ?? null;
  }

  /**
   * The live session `WorkflowHandle`, or `null` before {@link ensureSessionWorkflow}.
   * Exposed so the D11 lazy-proxy (src/pi/lazy-proxy.ts) can resolve the player's
   * OWN handle per tool call — tool handlers route through it (e.g. `submitOutbox`)
   * and never `.signal()` a peer workflow directly.
   */
  get handle(): WorkflowHandle | null {
    return this.wfHandle;
  }

  private get workflowId(): string {
    return sessionWorkflowId(this.metadata.ensemble, this.metadata.playerId);
  }

  /**
   * Ensure the session workflow exists and grab a handle. For a human-launched
   * `pi`, the workflow may not exist yet; `USE_EXISTING` makes this idempotent
   * when `agent-tempo up`/recruit already started it.
   */
  async ensureSessionWorkflow(): Promise<WorkflowHandle> {
    if (this.wfHandle) return this.wfHandle;
    this.wfHandle = await this.client.workflow.start('agentSessionWorkflow', {
      workflowId: this.workflowId,
      taskQueue: this.config.taskQueue,
      workflowIdConflictPolicy: 'USE_EXISTING',
      args: [{ metadata: this.metadata, phase: 'booting' }],
      // T0.5 (#747) / QA finding on #757 — seed the memo at birth like the
      // other workflow.start sites, so a brand-new session created by a
      // direct `pi -e` invocation is memo-readable in list results before
      // its first workflow task runs (which re-upserts the same fields).
      memo: {
        ...(this.metadata.gitRoot ? { [MEMO_KEYS.gitRoot]: this.metadata.gitRoot } : {}),
        ...(this.metadata.playerType ? { [MEMO_KEYS.playerType]: this.metadata.playerType } : {}),
        [MEMO_KEYS.isConductor]: this.metadata.isConductor === true,
        [MEMO_KEYS.workDir]: this.metadata.workDir,
        [MEMO_KEYS.agentType]: this.metadata.agentType || 'claude',
        ...(this.metadata.gitBranch ? { [MEMO_KEYS.gitBranch]: this.metadata.gitBranch } : {}),
      },
    });
    return this.wfHandle;
  }

  private requireHandle(): WorkflowHandle {
    if (!this.wfHandle) {
      throw new Error('PiWorkflowClient: call ensureSessionWorkflow() before lifecycle ops');
    }
    return this.wfHandle;
  }

  /**
   * Claim (or, with a handoff token, ADOPT) the attachment: phase
   * `booting → attached`. Fresh claim when `expectedAttachmentId` is absent;
   * renewal/adoption branch when the restart tool handed one in. Stores the token.
   */
  async claim(): Promise<AttachmentToken> {
    const handle = this.requireHandle();
    this.token = await handle.executeUpdate(claimAttachmentUpdate, {
      args: [
        {
          host: this.metadata.hostname,
          adapterId: PI_ADAPTER_ID,
          adapterClass: 'interactive',
          leaseMs: this.leaseMs,
          ...(this.expectedAttachmentId ? { expectedAttachmentId: this.expectedAttachmentId } : {}),
        },
      ],
    });
    log(
      `${this.expectedAttachmentId ? 'renewed' : 'claimed'} attachment ` +
      `${this.token.attachmentId} (lease ${this.leaseMs}ms)`,
    );
    return this.token;
  }

  /**
   * Liveness heartbeat — renews the lease. This is the ENTIRE reason an abrupt
   * Pi death is detectable: stop heart-beating and `expiresAt` lapses (see
   * src/pi/README.md "Abrupt-death finding" / MD-A).
   */
  async heartbeat(): Promise<void> {
    if (!this.token) return;
    const handle = this.requireHandle();
    // 3c Tier-1 — piggyback the latest coarse sample (currentTool + context).
    // Sampled per-beat; a throwing/absent provider degrades to a plain heartbeat.
    let coarse: CoarseSample | undefined;
    try { coarse = this.coarseProvider?.(); } catch { coarse = undefined; }
    // #753 — liveness-lease signals are metered as their own source.
    await withActionSource('heartbeat', () => handle.signal(heartbeatSignal, {
      attachmentId: this.token!.attachmentId,
      at: new Date().toISOString(),
      ...(coarse ? coarse : {}),
    }));
  }

  /** Start the heartbeat loop. The timer is `unref`'d so it never holds the process open. */
  startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      this.heartbeat().catch((err) => log('heartbeat failed:', err));
    }, this.heartbeatMs);
    if (typeof this.heartbeatTimer.unref === 'function') this.heartbeatTimer.unref();
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /** agent_start → phase `processing`. */
  async processingStart(messageId: string): Promise<void> {
    const handle = this.requireHandle();
    await handle.executeUpdate(processingStartUpdate, {
      args: [{ messageId, expectedAttachmentId: this.token?.attachmentId }],
    });
  }

  /** agent_end → phase `awaiting`. */
  async processingEnd(messageId: string): Promise<void> {
    const handle = this.requireHandle();
    await handle.executeUpdate(processingEndUpdate, {
      args: [{ messageId, expectedAttachmentId: this.token?.attachmentId }],
    });
  }

  /**
   * Graceful self-initiated detach: stopHeartbeat → adapterExited (→ detached).
   *
   * `adapterExited` ALONE collapses any live phase (attached/processing/awaiting/
   * draining) straight to `detached` — see the workflow handler at
   * `session.ts` adapterExitedSignal (returns early only on detached/gone). No
   * `requestDetach` is needed for a self-exit; that signal is the EXTERNAL ask to
   * drain a running adapter someone else controls. This matches the proven
   * `BaseAttachment.stopV2Lifecycle(graceful)` path. Idempotent-safe to call on
   * `session_shutdown` and from the headless exit sequence.
   */
  async detach(reason: DetachReason = 'agent-exited'): Promise<void> {
    if (!this.wfHandle || !this.token) return;
    this.stopHeartbeat();
    // Signal-DELIVERY (not a processing-ack) is sufficient by design, ruled won't-fix:
    // the session workflow runs in the DAEMON worker, not this Pi process, so once
    // signal() resolves the exit is durably in history and the worker transitions to
    // `detached` regardless of this process disposing/exiting. stopHeartbeat() above is
    // the independent backstop — a missed transition still reaps via lease expiry. No
    // caller reads phase synchronously at detach()-return, so an executeUpdate ack would
    // only add shutdown latency + drag determinism-sensitive workflow code into scope.
    // If a future synchronous re-claim/migrate ever needs an OBSERVED `detached`, poll the
    // existing attachmentInfoQuery client-side — never add an adapterExitedUpdate.
    await this.wfHandle.signal(adapterExitedSignal, {
      attachmentId: this.token.attachmentId,
      reason,
    });
    log(`detached (${reason})`);
  }

  /**
   * Stash the currently-active Pi SessionManager session id onto durable
   * workflow metadata (`metadata.sessionId`). This is the MUTABLE resume pointer
   * — SEPARATE from the fixed workflowId (identity). A later restart of this
   * player reads it to resume the same conversation via Pi `continueSession`
   * (reuses the #334 sessionId resume field). No-op when the id is absent.
   */
  async updateSessionId(sessionId: string | undefined): Promise<void> {
    if (!sessionId) return;
    const handle = this.requireHandle();
    await handle.signal(updateMetadataSignal, { sessionId });
  }

  // ── Outbox ──

  /** Route an outbox entry through the workflow outbox (player's own handle). */
  async submitOutbox(entry: OutboxEntryInput): Promise<string> {
    const handle = this.requireHandle();
    return handle.executeUpdate(submitOutboxUpdate, { args: [entry] });
  }

  // ── Cue intake ──

  /** Pull undelivered messages (cues) queued on the workflow. */
  async fetchPending(): Promise<Message[]> {
    const handle = this.requireHandle();
    return handle.query(pendingMessagesQuery);
  }

  /** Acknowledge delivered cue ids so the workflow stops re-serving them. */
  async ackDelivered(messageIds: string[]): Promise<void> {
    if (messageIds.length === 0) return;
    const handle = this.requireHandle();
    await handle.signal(markDeliveredSignal, messageIds);
  }

  // ── Combined intake (T0.3 of #747, #750) ──

  /**
   * `true` until a `pendingIntake` query is rejected as unregistered — i.e.
   * the session workflow predates #750. Cached so the pump pays the failed
   * probe ONCE, not every tick, then sticks to the legacy two-query path
   * for the lifetime of this client (a workflow only gains the handler via
   * code deploy + continueAsNew/restart, at which point the adapter process
   * is typically replaced too).
   */
  private combinedIntakeSupported = true;

  /**
   * One-query intake: undelivered cues + the pending reset together —
   * halves the pump's idle Temporal actions (2 → 1 query/tick). Falls back
   * to the legacy `pendingMessages` + `pendingReset` pair when the workflow
   * lacks the combined handler (pre-#750 build); genuine failures (timeouts,
   * connection errors) propagate to the pump's existing per-tick handling.
   */
  async fetchIntake(): Promise<PendingIntake> {
    if (this.combinedIntakeSupported) {
      const handle = this.requireHandle();
      try {
        const intake = await handle.query(pendingIntakeQuery);
        // Shape-guard: a real server either serves the query or rejects it
        // as unregistered, but belt-and-braces against converter quirks /
        // test doubles — a malformed result downgrades to the legacy pair
        // rather than crashing the pump tick.
        if (intake && Array.isArray(intake.messages)) return intake;
        this.combinedIntakeSupported = false;
        log('pendingIntake returned a malformed result — falling back to the legacy pair');
      } catch (err) {
        if (!isQueryNotRegisteredError(err)) throw err;
        this.combinedIntakeSupported = false;
        log(
          'pendingIntake query not registered on this workflow (pre-#750 build) — ' +
          'falling back to the legacy pendingMessages + pendingReset pair',
        );
      }
    }
    const [messages, pendingReset] = await Promise.all([
      this.fetchPending(),
      this.fetchPendingReset(),
    ]);
    return { messages, pendingReset };
  }

  // ── Reset intake (3d D14) ──

  /** Poll the workflow's single-slot pending reset (null = none). */
  async fetchPendingReset(): Promise<PendingReset | null> {
    const handle = this.requireHandle();
    return handle.query(pendingResetQuery);
  }

  /**
   * Ack a performed reset by id — the workflow clears the slot ONLY if the id
   * still matches (race-safe: a newer reset that landed mid-wipe is preserved).
   */
  async ackReset(resetId: string): Promise<void> {
    const handle = this.requireHandle();
    await handle.signal(ackResetSignal, resetId);
  }

  /**
   * Dispatch a {@link WorkflowAction} produced by {@link PhaseDriver}. Centralizes
   * the action→wire-call mapping so the extension wiring stays declarative.
   */
  async performAction(action: WorkflowAction): Promise<void> {
    switch (action.kind) {
      case 'claim':
        await this.claim();
        this.startHeartbeat();
        return;
      case 'processingStart':
        await this.processingStart(action.messageId);
        return;
      case 'processingEnd':
        await this.processingEnd(action.messageId);
        return;
      case 'detach':
        await this.detach();
        return;
      case 'none':
        return;
    }
  }
}
