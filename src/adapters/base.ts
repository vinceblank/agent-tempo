/**
 * Base adapter infrastructure.
 *
 * Skeleton landed in PR-B (v0.25 rebuild step 2/7). PR-C commit 2 extends this with
 * the V2 attachment lifecycle machinery — `claimAttachment`, heartbeat loop,
 * `attachmentInfo` phase watcher, `WorkflowNotFound` terminal handling, and
 * graceful-detach orchestration. The machinery is gated behind
 * `CLAUDE_TEMPO_LIFECYCLE_V2`; when the flag is off, adapters fall back to the
 * PR-A compat shim path (`updateMetadata({ status })`, legacy `startMessagePoller`)
 * and none of the V2 code runs.
 *
 * The `SdkAttachment` intermediate class (processing-signal pairing, split-brain
 * cancellation per §9.3) lands in commit 3 alongside the Copilot adapter migration.
 *
 * Design reference: docs/design/session-lifecycle-rebuild-v2.md §§3.2, 4.3, 9.1–9.5.
 */
import type { Client, WorkflowHandle } from '@temporalio/client';
import {
  claimAttachmentUpdate,
  heartbeatSignal,
  attachmentInfoQuery,
  adapterExitedSignal,
} from '../workflows/signals';
import type {
  AdapterClass,
  AdapterDescriptor,
  AttachmentToken,
  AttachmentInfo,
  AttachmentPhase,
  DetachReason,
} from '../types';
import { lifecycleV2Enabled } from '../config';

const log = (...args: unknown[]) => console.error('[claude-tempo:adapter]', ...args);

/** Backoff tuning for the heartbeat + phase-watcher loops on transient errors. */
const LOOP_BACKOFF_FACTOR = 1.5;
const LOOP_BACKOFF_MAX_MS = 30_000;

/** Options shared by every adapter extending `BaseAttachment`. */
export interface BaseAttachmentOptions {
  /** Temporal client — required for V2 path (claim + pin runId). Optional while legacy path is used. */
  client?: Client;
  /** Hostname to announce in `claimAttachment`. Defaults to `os.hostname()` when omitted. */
  host?: string;
  /** Override the `CLAUDE_TEMPO_LIFECYCLE_V2` flag read. Primarily for tests. */
  lifecycleV2?: boolean;
}

/**
 * Abstract base class for session adapters.
 *
 * Today concrete adapters (`InteractiveAttachment`, `CopilotSdkAttachment`) still own
 * their own top-level delivery loop. The V2 path this class now owns claims the
 * attachment, heartbeats on `descriptor.heartbeatMs`, and watches the workflow's
 * phase. Subclasses opt in to that machinery by calling `startV2Lifecycle()` before
 * their delivery loop and `stopV2Lifecycle()` on teardown.
 *
 * **Flag-at-the-boundary invariant.** `lifecycleV2` is read once at construction and
 * never re-evaluated. Subclasses branch on `this.lifecycleV2` at the top of `start()`
 * and commit to a single path for the lifetime of the attachment. Mixed V1/V2 state
 * (e.g. V2 heartbeat alongside a legacy poll-only subclass path) is a defect.
 */
export abstract class BaseAttachment {
  abstract readonly descriptor: AdapterDescriptor;

  protected readonly lifecycleV2: boolean;
  /** Populated at construction for InteractiveAttachment; lazily via `configureV2()` for subprocess adapters (Copilot bridge). */
  protected client?: Client;
  protected host?: string;

  /** V2 state — populated by `startV2Lifecycle()`, null on legacy path. */
  protected token: AttachmentToken | null = null;
  /** Handle pinned to the runId returned by `claimAttachment`. Never resolve by ID alone (§6.3). */
  protected pinnedHandle: WorkflowHandle | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private phaseWatcherTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatBackoff = 0;
  private phaseBackoff = 0;
  private stopped = false;
  private terminalFired = false;
  private knownPhase: AttachmentPhase | null = null;

  private readonly phaseChangeListeners: Array<(phase: AttachmentPhase) => void> = [];
  private readonly leaseRevokedListeners: Array<(reason: DetachReason) => void> = [];
  private readonly terminalListeners: Array<(reason: DetachReason) => void> = [];

  constructor(options: BaseAttachmentOptions = {}) {
    this.lifecycleV2 = options.lifecycleV2 ?? lifecycleV2Enabled();
    this.client = options.client;
    this.host = options.host;
  }

  /**
   * Lazily populate the V2-path dependencies (Temporal client, host). Used by
   * adapters whose subprocess constructs the client inside `run()` rather
   * than receiving it from the outer process (Copilot bridge). Must be called
   * BEFORE `startV2Lifecycle()`.
   *
   * C3 (PR-C dual-QA follow-up): rejects late reconfiguration — once a claim
   * token has been issued, swapping the client out silently would leave the
   * pinned handle pointing at the previous connection. Future adapters that
   * mis-order the calls fail loudly instead of drifting.
   */
  protected configureV2(client: Client, host: string): void {
    if (this.token) {
      throw new Error(
        'configureV2() called after startV2Lifecycle; configuration must happen before claim',
      );
    }
    this.client = client;
    this.host = host;
  }

  /** Subscribe to `attachmentInfo.phase` changes observed by the watcher. */
  onPhaseChange(listener: (phase: AttachmentPhase) => void): () => void {
    this.phaseChangeListeners.push(listener);
    return () => {
      const i = this.phaseChangeListeners.indexOf(listener);
      if (i >= 0) this.phaseChangeListeners.splice(i, 1);
    };
  }

  /** Subscribe to lease-revocation events (§9.3 split-brain resolution). */
  onLeaseRevoked(listener: (reason: DetachReason) => void): () => void {
    this.leaseRevokedListeners.push(listener);
    return () => {
      const i = this.leaseRevokedListeners.indexOf(listener);
      if (i >= 0) this.leaseRevokedListeners.splice(i, 1);
    };
  }

  /**
   * Subscribe to terminal events — `WorkflowNotFound` (§9.4) and phase `gone`.
   * Terminal fires at most once per instance. Subclasses stop delivery + exit.
   */
  onTerminal(listener: (reason: DetachReason) => void): () => void {
    this.terminalListeners.push(listener);
    return () => {
      const i = this.terminalListeners.indexOf(listener);
      if (i >= 0) this.terminalListeners.splice(i, 1);
    };
  }

  /**
   * V2 lifecycle entry point. Claims (or renews) the attachment, pins the handle by runId,
   * and starts the heartbeat + phase watcher loops.
   *
   * @param workflowId  Target session workflow id.
   * @param expectedAttachmentId
   *   PR-D renewal path. When present, the adapter was spawned by `restart` / `migrate` /
   *   `encore` — the workflow has already created an `Attachment` with this id and is
   *   expecting the new adapter to take over. Passing it through to `claimAttachment`
   *   selects the renewal branch in §9.2 (refresh lease in place, idempotent on retry)
   *   instead of the fresh-claim branch. Fresh spawn (first recruit) omits this arg.
   * @returns Pinned `WorkflowHandle` — subclass delivery loop MUST use this for every
   *          subsequent query/signal (never resolve by id alone).
   * @throws  Re-throws `claimAttachment` rejections (`AttachmentConflict`, `WorkflowGone`).
   */
  protected async startV2Lifecycle(
    workflowId: string,
    expectedAttachmentId?: string,
  ): Promise<WorkflowHandle> {
    if (!this.lifecycleV2) {
      throw new Error('startV2Lifecycle called with lifecycleV2=false — guard at subclass boundary');
    }
    if (!this.client) {
      throw new Error('BaseAttachment V2 path requires a Temporal client — pass via constructor options');
    }
    if (!this.host) {
      throw new Error('BaseAttachment V2 path requires a host — pass via constructor options');
    }

    const unpinned = this.client.workflow.getHandle(workflowId);
    this.token = await unpinned.executeUpdate(claimAttachmentUpdate, {
      args: [{
        host: this.host,
        adapterId: this.descriptor.adapterId,
        adapterClass: this.descriptor.adapterClass as AdapterClass,
        leaseMs: 3 * this.descriptor.heartbeatMs,
        ...(expectedAttachmentId ? { expectedAttachmentId } : {}),
      }],
    });

    this.pinnedHandle = this.client.workflow.getHandle(workflowId, this.token.runId);
    log(
      `${expectedAttachmentId ? 'renewed' : 'attached to'} ${workflowId} ` +
      `(attachmentId=${this.token.attachmentId}, runId=${this.token.runId})`,
    );

    this.scheduleHeartbeat();
    this.schedulePhaseWatcher();

    return this.pinnedHandle;
  }

  /**
   * Tear down V2 machinery. Idempotent. Called by subclass on stop, on terminal
   * events, and on graceful detach completion.
   *
   * When `graceful=true` (detach owner) we fire `adapterExited` so the workflow
   * collapses `draining → detached` immediately per §11.1.
   */
  protected async stopV2Lifecycle(reason: DetachReason = 'user-stop', graceful = false): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;

    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.phaseWatcherTimer) {
      clearTimeout(this.phaseWatcherTimer);
      this.phaseWatcherTimer = null;
    }

    if (graceful && this.pinnedHandle && this.token) {
      try {
        await this.pinnedHandle.signal(adapterExitedSignal, {
          attachmentId: this.token.attachmentId,
          reason,
        });
      } catch (err) {
        // Best-effort — workflow may already have reaped us. Don't fail shutdown.
        log(`adapterExited signal suppressed error: ${(err as Error)?.message ?? err}`);
      }
    }
  }

  private scheduleHeartbeat(): void {
    const delay = this.heartbeatBackoff || this.descriptor.heartbeatMs;
    this.heartbeatTimer = setTimeout(() => { void this.tickHeartbeat(); }, delay);
  }

  private async tickHeartbeat(): Promise<void> {
    if (this.stopped || !this.pinnedHandle || !this.token) return;
    try {
      await this.pinnedHandle.signal(heartbeatSignal, {
        attachmentId: this.token.attachmentId,
        at: new Date().toISOString(),
      });
      this.heartbeatBackoff = 0;
    } catch (err) {
      if (this.isWorkflowGone(err)) {
        // C1 (PR-C dual-QA follow-up): WorkflowNotFound means the session workflow
        // has COMPLETEd — that's the `destroy` terminal, not `agent-exited` (which
        // means our local process died). Matches the phase-watcher `phase === 'gone'
        // → fireTerminal('destroy')` branch below.
        this.fireTerminal('destroy');
        return;
      }
      this.heartbeatBackoff = Math.min(
        this.heartbeatBackoff ? this.heartbeatBackoff * LOOP_BACKOFF_FACTOR : this.descriptor.heartbeatMs,
        LOOP_BACKOFF_MAX_MS,
      );
      log(`heartbeat transient error (retry in ${Math.round(this.heartbeatBackoff)}ms):`, (err as Error)?.message ?? err);
    }
    if (!this.stopped) this.scheduleHeartbeat();
  }

  private schedulePhaseWatcher(): void {
    // §3.2 item 6: relaxed poll — once per 5 heartbeat intervals.
    const base = this.descriptor.heartbeatMs * 5;
    const delay = this.phaseBackoff || base;
    this.phaseWatcherTimer = setTimeout(() => { void this.tickPhaseWatcher(); }, delay);
  }

  private async tickPhaseWatcher(): Promise<void> {
    if (this.stopped || !this.pinnedHandle || !this.token) return;
    try {
      const info: AttachmentInfo = await this.pinnedHandle.query(attachmentInfoQuery);
      this.phaseBackoff = 0;

      if (this.knownPhase !== info.phase) {
        this.knownPhase = info.phase;
        for (const l of this.phaseChangeListeners) {
          try { l(info.phase); } catch (err) { log('phase listener threw:', err); }
        }
      }

      // Lease revocation — another claimant took over.
      if (
        info.currentAttachment &&
        info.currentAttachment.attachmentId !== this.token.attachmentId
      ) {
        log(`lease revoked: attachmentId ${info.currentAttachment.attachmentId} does not match ours ${this.token.attachmentId}`);
        for (const l of this.leaseRevokedListeners) {
          try { l('superseded'); } catch (err) { log('leaseRevoked listener threw:', err); }
        }
        this.fireTerminal('superseded');
        return;
      }

      // Phase `gone` is terminal — workflow destroyed.
      if (info.phase === 'gone') {
        this.fireTerminal('destroy');
        return;
      }
    } catch (err) {
      if (this.isWorkflowGone(err)) {
        // C1 (PR-C dual-QA follow-up): WorkflowNotFound on the phase-watcher query
        // has the same meaning as on the heartbeat signal — the workflow is gone,
        // so the terminal reason is `destroy`.
        this.fireTerminal('destroy');
        return;
      }
      this.phaseBackoff = Math.min(
        this.phaseBackoff ? this.phaseBackoff * LOOP_BACKOFF_FACTOR : this.descriptor.heartbeatMs,
        LOOP_BACKOFF_MAX_MS,
      );
      log(`phase watcher transient error (retry in ${Math.round(this.phaseBackoff)}ms):`, (err as Error)?.message ?? err);
    }
    if (!this.stopped) this.schedulePhaseWatcher();
  }

  /**
   * Classify an error as terminal (WorkflowNotFound / ExecutionAlreadyCompleted / phase gone).
   *
   * Uses name-sniffing rather than `instanceof` to avoid tight coupling to
   * `@temporalio/client` internals — errors surface through both the Client SDK
   * and the server's gRPC layer with slightly different shapes.
   */
  private isWorkflowGone(err: unknown): boolean {
    const e = err as { name?: string; message?: string } | undefined;
    const name = e?.name ?? '';
    const msg = e?.message ?? '';
    return (
      name.includes('WorkflowNotFound') ||
      name.includes('WorkflowExecutionAlreadyCompleted') ||
      msg.includes('WorkflowGone') ||
      msg.includes('NOT_FOUND')
    );
  }

  private fireTerminal(reason: DetachReason): void {
    if (this.terminalFired) return;
    this.terminalFired = true;
    this.stopped = true;
    if (this.heartbeatTimer) { clearTimeout(this.heartbeatTimer); this.heartbeatTimer = null; }
    if (this.phaseWatcherTimer) { clearTimeout(this.phaseWatcherTimer); this.phaseWatcherTimer = null; }
    for (const l of this.terminalListeners) {
      try { l(reason); } catch (err) { log('terminal listener threw:', err); }
    }
  }
}

/**
 * Registry of adapter descriptors keyed by `adapterId`.
 *
 * Look up the descriptor for a given session by `SessionMetadata.adapterId` (or
 * fall back to `'claude-code'` for pre-v0.25 sessions that have no adapterId set).
 * `src/adapters/index.ts` creates the singleton `registry` and registers all
 * shipped adapters at import time.
 */
export class AdapterRegistry {
  private readonly byId = new Map<string, AdapterDescriptor>();

  /** Register an adapter descriptor. Replaces any existing entry with the same id. */
  register(desc: AdapterDescriptor): void {
    this.byId.set(desc.adapterId, desc);
  }

  /**
   * Fetch the descriptor for `adapterId`. Throws if unregistered.
   *
   * Callers resolving from possibly-undefined metadata should coalesce first:
   * `registry.get(metadata.adapterId ?? 'claude-code')`.
   */
  get(adapterId: string): AdapterDescriptor {
    const desc = this.byId.get(adapterId);
    if (!desc) {
      const known = [...this.byId.keys()].join(', ') || '(none registered)';
      throw new Error(`Unknown adapter "${adapterId}". Registered: ${known}`);
    }
    return desc;
  }

  /** `true` if `adapterId` is registered. */
  has(adapterId: string): boolean {
    return this.byId.has(adapterId);
  }

  /** Snapshot of all registered descriptors. */
  all(): readonly AdapterDescriptor[] {
    return [...this.byId.values()];
  }

  /**
   * Resolve an `adapterId` from the legacy `agent` field on {@link SessionMetadata}.
   * Maps `'claude'` → `'claude-code'`, `'copilot'` → `'copilot'`.
   *
   * Used as a fallback when `adapterId` is not yet populated on the session metadata
   * (e.g. sessions started before PR-B landed). PR-D removes this mapping when the
   * legacy `AgentType` enum is retired.
   */
  resolveFromAgentType(agent: string | undefined): string {
    if (agent === 'copilot') return 'copilot';
    return 'claude-code';
  }
}

export type { AdapterClass, AdapterDescriptor };
