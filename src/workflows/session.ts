import {
  setHandler,
  condition,
  continueAsNew,
  workflowInfo,
  allHandlersFinished,
  upsertSearchAttributes,
  upsertMemo,
  uuid4,
  proxyActivities,
  log as workflowLog,
} from '@temporalio/workflow';
import { MEMO_KEYS } from '../utils/search-attributes';
import { PROTOCOL_VERSION } from '../constants';
import { ApplicationFailure } from '@temporalio/common';

/**
 * Workflow-deterministic clock. The Temporal TS SDK intercepts `new Date()` at the
 * sandbox level to return replay-consistent time, so this wrapper is safe — the
 * name aligns with the project convention (CLAUDE.md: "no `Date.now()` in workflow
 * code, use `workflow.now()` instead") while using the SDK-intercepted constructor.
 */
function workflowNow(): Date {
  return new Date();
}

import type { OutboxActivities, OutboxActivityResult } from '../activities/outbox';
import type { HardTerminateResult } from '../activities/hard-terminate';
import { extendAttachmentForCAN } from './attachment-math';

import {
  SessionInput,
  Message,
  SentMessage,
  Command,
  PlayerReport,
  HistoryEntry,
  OutboxEntry,
  OutboxEntryInput,
  PendingReset,
  QualityGate,
  WorktreeEntry,
  receiveMessageSignal,
  setPartSignal,
  setNameSignal,
  markDeliveredSignal,
  updateMetadataSignal,
  setPendingResetSignal,
  ackResetSignal,
  pendingIntakeQuery,
  getPartQuery,
  getMetadataQuery,
  pendingMessagesQuery,
  allMessagesQuery,
  recordSentMessageSignal,
  allSentMessagesQuery,
  commandSignal,
  playerReportSignal,
  historyQuery,
  submitOutboxUpdate,
  outboxQuery,
  // #399 W2 — session wire extensions (Q5.2/Q5.5/Q5.6/Q5.7)
  getRunIdQuery,
  getMessagingStateQuery,
  getActivityStateQuery,
  getLeaseStateQuery,
  getCoarseActivityQuery,
  setQualityGateSignal,
  evaluateGateCriteriaSignal,
  qualityGatesQuery,
  setWorktreeSignal,
  removeWorktreeSignal,
  worktreesQuery,
  setStageSignal,
  cancelStageSignal,
  stagesQuery,
  StageEntry,
  releaseHeldSignal,
  outboxLockedQuery,
  setPausedSignal,
  pausedQuery,
  processingStartUpdate,
  processingEndUpdate,
  inFlightMessagesQuery,
  destroyUpdate,
  isDestroyedQuery,
  // v0.25 attachment lifecycle
  claimAttachmentUpdate,
  forceDetachUpdate,
  enqueueSpawnUpdate,
  setPreferredHostUpdate,
  heartbeatSignal,
  requestDetachSignal,
  adapterExitedSignal,
  attachmentInfoQuery,
  orphanSummaryQuery,
  // Test-only (#226 reconnect-after-CAN coverage)
  testForceContinueAsNewSignal,
  // Player saveable state (#334 PR-1)
  savePlayerStateUpdate,
  clearPlayerStateUpdate,
  playerStateQuery,
  playerStateKeysQuery,
} from './signals';
import {
  PLAYER_STATE_KEY_REGEX,
  PLAYER_STATE_KEY_MAX,
  PLAYER_STATE_CONTENT_MAX,
  PLAYER_STATE_SLOTS_MAX,
  PLAYER_STATE_DEFAULT_KEY,
  MAX_DETACH_DEADLINE_MS,
} from '../utils/validation';
import type {
  Attachment,
  AttachmentPhase,
  AttachmentToken,
  AttachmentInfo,
  AdapterClass,
  AgentType,
  DetachReason,
  PlayerStateEntry,
  OrphanSummary,
  SpawnOutboxEntry,
  SpawnRecord,
} from '../types';
// ── Outbox Activity Proxies ──

const { deliverCue, deliverReport, terminateSession, startRecruitedSession, releasePlayer, deliverDetach, deliverDestroy, deliverRestart, deliverReset } =
  proxyActivities<OutboxActivities>({
    startToCloseTimeout: '30 seconds',
    retry: { maximumAttempts: 3 },
  });

function getSpawnProxy(hostname: string) {
  return proxyActivities<Pick<OutboxActivities, 'spawnProcess'>>({
    taskQueue: `agent-tempo-${hostname}`,
    startToCloseTimeout: '2 minutes',
    retry: { maximumAttempts: 2 },
  }).spawnProcess;
}

/**
 * Host-routed proxy for the #159 Gap 2 hard-terminate activity. Runs on the target's
 * `agent-tempo-{hostname}` task queue so the kill happens where the child process
 * actually lives. Short timeout + low retry — this is a best-effort cleanup and the
 * workflow must not wedge if the host worker is down.
 */
function getHardTerminateProxy(hostname: string) {
  return proxyActivities<Pick<OutboxActivities, 'hardTerminateAttachment'>>({
    taskQueue: `agent-tempo-${hostname}`,
    startToCloseTimeout: '10 seconds',
    scheduleToCloseTimeout: '20 seconds',
    retry: { maximumAttempts: 1 },
  }).hardTerminateAttachment;
}

/**
 * Shorter-timeout proxy for destroyUpdate. Destroy is terminal/best-effort
 * (§2.5) — if the host worker is offline we don't want to block the workflow's
 * terminal transition for 20s waiting on a schedule-to-close timeout. Test
 * environments without a host worker fail fast in ~5s instead.
 */
function getHardTerminateProxyForDestroy(hostname: string) {
  return proxyActivities<Pick<OutboxActivities, 'hardTerminateAttachment'>>({
    taskQueue: `agent-tempo-${hostname}`,
    startToCloseTimeout: '5 seconds',
    scheduleToCloseTimeout: '5 seconds',
    retry: { maximumAttempts: 1 },
  }).hardTerminateAttachment;
}

export async function agentSessionWorkflow(input: SessionInput): Promise<void> {
  // ── v0.25 Attachment Lifecycle Timers (design §2.3, §9.5) ──
  // PR-C commit 6 (#119a): each attachment carries its own `leaseMs` (negotiated at
  // claim time). No workflow-side default constant — heartbeats extend `expiresAt`
  // by `currentAttachment.leaseMs`.
  /**
   * Default grace period for `draining → detached` transition after requestDetach. Used when a
   * `requestDetach` signal omits `deadlineMs`. Per-signal overrides are honored via the
   * `drainingDeadlineMs` state variable below (fix for #159 Gap 1a).
   */
  const DEFAULT_DRAINING_DEADLINE_MS = 5_000;
  /**
   * #809 — absolute hard ceiling on the `draining` phase. The per-detach
   * `drainingDeadlineMs` window governs a *graceful* drain, but draining must
   * ALWAYS escape regardless of how it was entered. Before #809 both the
   * `nextDeadlineMs()` candidate AND the §9.5.c reap were gated on
   * `drainingSince !== null` (and trusted an unclamped, caller-supplied
   * `drainingDeadlineMs`). A `draining` phase whose `drainingSince` was never
   * stamped — or whose window was set pathologically large — therefore had the
   * same unbounded "Infinity deadline" weakness as `booting` (#704): a silent,
   * indefinite wedge with no operator-visible escape. This ceiling caps the
   * effective window so a runaway `drainingDeadlineMs` can't stall the phase,
   * and the unconditional reap below force-exits a `drainingSince === null`
   * wedge immediately. `MAX_DETACH_DEADLINE_MS` (the documented max detach
   * window) is the natural ceiling — it never truncates a legitimate drain.
   */
  const DRAINING_DEADLINE_MS = MAX_DETACH_DEADLINE_MS;
  /** Max duration a messageId can stay in-flight before the safety timer ejects it. */
  const PROCESSING_DEADLINE_MS = 15 * 60 * 1000;
  /**
   * #704 — max duration a session may sit in `booting` (no attachment claimed)
   * before the watchdog fails the recruit. Default 180s (architect OQ-3: 120s
   * floor; 180s clears a cold launch + cross-host recruit handshake). Workflows
   * can't read process.env, so an operator/test override rides durable metadata
   * (`bootingDeadlineMs`, sourced from `AGENT_TEMPO_BOOTING_DEADLINE_MS` at
   * spawn). Only ARMED for headless adapters on a fresh (non-handoff) boot —
   * see `armBootingWatchdog` below.
   */
  const BOOTING_DEADLINE_MS =
    typeof input.metadata.bootingDeadlineMs === 'number' && input.metadata.bootingDeadlineMs > 0
      ? input.metadata.bootingDeadlineMs
      : 180_000;
  /**
   * #704 Item 2 — generous main-loop wake backstop (architect-ruled FINAL).
   * Every deadline-mutating handler now bumps `wakeEpoch`, so in steady state
   * the loop wakes on exactly `nextDeadlineMs()`. This backstop is defense-in-
   * depth for a FUTURE handler that mutates wake-relevant state but forgets the
   * bump: the loop still re-evaluates at least every `BACKSTOP_MS` instead of
   * sleeping forever (we deliberately do NOT add an `Infinity → no-timer` branch
   * — a silent indefinite sleep is the exact failure class #704 exists to kill).
   * A fallback-cap wake that finds actionable state emits a loud WARN (below) so
   * a missed bump is detectable, not masked. 30min is large enough that it never
   * fires in correct steady state yet bounds any regression.
   */
  const BACKSTOP_MS = 30 * 60 * 1000;

  // ── 2.0 clean-slate (#787) ──
  // The replay-only `patched()` markers that protected in-flight 1.x sessions
  // across rolling deploys are gone: 2.0 is a hard cutover (the #786 boot guard
  // refuses to replay any 1.x history), so there are no pre-patch histories left
  // to protect. The SA-diet (#747) and observation-field memo (#748) behavior is
  // now unconditional — the new path IS the only path.

  /**
   * T0.5 — the memo mirror of the migrated read-only metadata fields.
   * Shared by the run-start upsert and the updateMetadata handler so the
   * two write sites can't drift. Key names come from the shared
   * {@link MEMO_KEYS} registry (also used by the client-side
   * `workflow.start({ memo })` seeds and the memo readers).
   */
  const metaMemo = (): Record<string, unknown> => ({
    ...(input.metadata.gitRoot ? { [MEMO_KEYS.gitRoot]: input.metadata.gitRoot } : {}),
    ...(input.metadata.playerType ? { [MEMO_KEYS.playerType]: input.metadata.playerType } : {}),
    [MEMO_KEYS.isConductor]: input.metadata.isConductor === true,
    [MEMO_KEYS.workDir]: input.metadata.workDir,
    [MEMO_KEYS.agentType]: input.metadata.agentType || 'claude',
    ...(input.metadata.gitBranch ? { [MEMO_KEYS.gitBranch]: input.metadata.gitBranch } : {}),
  });

  // Ensure search attributes are always current — critical when reconnecting
  // via WorkflowIdConflictPolicy.USE_EXISTING, which skips the attributes
  // passed to client.workflow.start().
  upsertSearchAttributes({
    AgentTempoEnsemble: [input.metadata.ensemble],
    AgentTempoPlayerId: [input.metadata.playerId],
    AgentTempoHostname: [input.metadata.hostname],
    // v0.25 attachment search attributes — initial values for a fresh/restored workflow.
    // Updated on every phase transition below.
    AgentTempoAttachedHost: [input.currentAttachment?.hostname ?? ''],
    AgentTempoAttachmentState: [input.phase ?? 'booting'],
  });

  // #786 — 2.0 cutover protocol STAMP. Authoritative from the constant (this IS
  // the 2.0 bundle → always PROTOCOL_VERSION, regardless of `input.protocol`).
  // Re-upserted on EVERY run, incl. continueAsNew successors, so visibility
  // always shows the stamp for the daemon boot guard — no need to thread a memo
  // arg through the CAN payload. A 1.x run never executes this, so the guard
  // sees its memo as undefined → un-stamped → refuse. Unconditional (no
  // `patched()` marker): #786 is the first change on the 2.0 line, so there are
  // no pre-stamp v2 histories to protect from this new command.
  upsertMemo({ [MEMO_KEYS.protocol]: PROTOCOL_VERSION });

  // ── State (carried across continue-as-new) ──
  let part = input.part ?? input.autoSummary ?? 'No description set';

  // T0.5 (#747) — memo carrier for the migrated read-only fields + part.
  // Memo persists across continueAsNew and is returned in visibility list
  // results; start sites additionally seed it via client.workflow.start's
  // `memo` option so the fields are visible before the first workflow task
  // (and on standard-visibility servers whose list results may lag memo
  // upserts — see PR #747 T0.5 notes). Low-churn fields ONLY.
  upsertMemo({ ...metaMemo(), [MEMO_KEYS.part]: part });

  const messages: Message[] = input.messages ?? [];
  const sentMessages: SentMessage[] = input.sentMessages ?? [];
  const outbox: OutboxEntry[] = input.outbox ?? [];

  // ── #910 — at-least-once delivery dedup ──
  // Outbox dispatch delivers `cue`/`report` at-least-once: a continueAsNew (or
  // worker crash) landing in the window AFTER the delivery signal applies
  // server-side but BEFORE the entry's `delivered` status commits to history
  // re-drives the entry on the successor run; an activity retry (transient RPC
  // after a successful server-side signal) fires a second signal within a run.
  // Either way the receiver would apply the same cue/report twice. We dedup on
  // the originating outbox entry `id` (minted in `submitOutboxUpdate`, stable
  // across CAN), threaded to the receiver as `deliveryId`. The seen-set is a
  // BOUNDED FIFO (NOT a growing Set) — constant-size across CAN, so it adds
  // negligible history. A redelivery delayed past the cap evicts its id and can
  // slip a dup through; the cap is sized well above (max in-flight + CAN window).
  const SEEN_DELIVERY_IDS_CAP = 512;
  const seenDeliveryIds: string[] = input.seenDeliveryIds ?? [];

  // #897 (A) — durable spawn-identity record of the LAST process this session
  // spawned. Set from the `spawnProcess` activity RESULT in the dispatch loop
  // (host/pid/sessionId/spawnedAt), carried across CAN. Exists pre-attach so
  // reconcile/destroy tooling has a spawn identity even before an adapter claims.
  let spawnRecord: SpawnRecord | null = input.spawnRecord ?? null;
  /**
   * Record spawn identity from a `spawnProcess` RESULT. No-op when `spawnedAt`
   * is absent — that's the FIX-3 duplicate-skip path (no process launched), so
   * the prior `spawnRecord` is preserved rather than blanked.
   */
  function recordSpawn(result: OutboxActivityResult, host: string, sessionId: string | undefined): void {
    if (!result.spawnedAt) return;
    spawnRecord = {
      hostname: host,
      ...(result.pid !== undefined ? { pid: result.pid } : {}),
      ...(sessionId !== undefined ? { sessionId } : {}),
      spawnedAt: result.spawnedAt,
    };
  }
  /**
   * #897 (B2) — the sessionId to stamp on the close memo for the orphan-guard's
   * exact-identity match. Prefer the spawn identity (== the orphan process's own
   * `AGENT_TEMPO_SESSION_ID`); fall back to the adapter-set metadata sessionId.
   */
  const closeMemoSessionId = (): string | undefined =>
    spawnRecord?.sessionId ?? input.metadata.sessionId;
  /**
   * Record a `deliveryId` and report whether it is NEW (caller should apply) vs a
   * duplicate that must be dropped. `undefined` (un-threaded / legacy caller) is
   * always NEW — no dedup key, preserves pre-#910 behavior. Deterministic (pure
   * array ops on replay-restored state).
   */
  function recordDelivery(deliveryId: string | undefined): boolean {
    if (deliveryId === undefined) return true;
    if (seenDeliveryIds.includes(deliveryId)) return false;
    seenDeliveryIds.push(deliveryId);
    if (seenDeliveryIds.length > SEEN_DELIVERY_IDS_CAP) seenDeliveryIds.shift();
    return true;
  }
  // D14 — pending context-reset flag, polled + acked by the Pi extension. Single
  // slot, latest-wins; survives continue-as-new until the extension acks it.
  let pendingReset: PendingReset | null = input.pendingReset ?? null;
  let lastActivityTime = workflowNow().getTime();
  let lastOutboundTime = input.lastOutboundTime ?? workflowNow().getTime();
  let lastInboundRRTime = input.lastInboundRRTime ?? 0;

  // ── #399 W2 — wire-extension counters (carried across continueAsNew) ──
  // `activityCount` mirrors the ~20 `lastActivityTime` mutation sites;
  // `receivedCount` / `sentCount` track inbound cues + outbox submissions.
  // All three feed dashboard surfaces via the new `getActivityStateQuery`
  // and `getMessagingStateQuery` queries.
  let activityCount = input.activityCount ?? 0;
  let receivedCount = input.receivedCount ?? 0;
  let sentCount = input.sentCount ?? 0;

  // ── 3c Tier-1 — coarse activity (currentTool + context usage) ──
  // Refreshed by the heartbeat piggyback; surfaced by `getCoarseActivityQuery`.
  // Deliberately volatile/live — NOT carried across continueAsNew (no input
  // field), so a fresh run reports `{currentTool:null}` until the next ~30s
  // heartbeat repopulates it. Acceptable for coarse observability; the live,
  // fine-grained tail is the off-wire /inner side-channel.
  let coarseActivity: { currentTool: string | null; contextTokens?: number; contextPercent?: number } = { currentTool: null };

  // ── Warm Hold + Pause State ──
  let outboxLocked = input.outboxLocked ?? false;
  let heldMessage: string | undefined = input.heldMessage;
  let paused = input.paused ?? false;

  // ── Player Saveable State (#334 PR-1; ADR 0011) ──
  // Per-key opaque-string artifacts the player itself curates via `save_state`.
  // Carried via continueAsNew (only when populated). Sized at validation:
  // up to PLAYER_STATE_SLOTS_MAX × PLAYER_STATE_CONTENT_MAX.
  const playerState: Record<string, PlayerStateEntry> = { ...(input.playerState ?? {}) };

  // ── v0.25 Attachment Lifecycle State (design §2.2) ──
  /** Current attachment lease, or null when detached. */
  let currentAttachment: Attachment | null = input.currentAttachment ?? null;
  /** Current phase — authoritative source of lifecycle truth after #175. */
  let phase: AttachmentPhase = input.phase ?? (currentAttachment ? 'attached' : 'booting');
  /** Preferred host for daemon reconcile-on-boot auto-restore. */
  let preferredHost: string | undefined = input.preferredHost ?? currentAttachment?.hostname ?? input.metadata.hostname;
  /** ISO timestamp of when the current `draining` phase started. */
  let drainingSince: string | null = input.drainingSince ?? null;
  /**
   * Grace window (ms) for the current `draining` phase, if a `requestDetach` signal supplied one.
   * Fix for #159 Gap 1a: the pre-fix handler discarded `deadlineMs` and always used the 5s default,
   * so callers requesting a longer/shorter window were silently ignored. Reset to `null` whenever
   * `drainingSince` clears so it can't leak into the next detach cycle.
   */
  let drainingDeadlineMs: number | null = input.drainingDeadlineMs ?? null;
  /**
   * Monotonic counter bumped by signal/update handlers that *shorten* `nextDeadlineMs()` output
   * (e.g. `requestDetach` creates a new, sooner draining deadline; `forceDetach` nullifies the
   * current attachment expiry). The main-loop `condition(...)` includes `wakeEpoch` in its
   * predicate so state changes outside the existing wake conditions still punch through the
   * already-scheduled timeout — fix for #159 Gap 1b. Signal handlers that *extend* deadlines
   * (e.g. heartbeat) don't need to bump since the pre-existing, earlier deadline firing and
   * being re-checked is harmless.
   */
  let wakeEpoch = 0;
  /** Reason recorded when the last attachment detached (for orphanSummary query). */
  let lastDetachReason: DetachReason | undefined;
  /** Metadata about the last-known adapter (for orphanSummary query). */
  let lastAdapterMeta: { hostname: string; adapterId: string } | undefined = currentAttachment
    ? { hostname: currentAttachment.hostname, adapterId: currentAttachment.adapterId }
    : undefined;
  /** ISO timestamp of when the workflow most recently entered `detached`. */
  let detachedSince: string | null = null;

  // ── #704 — Booting attach-timeout watchdog ──
  // A session that starts FRESH in `booting` (no attachment handoff) and never
  // reaches `claimAttachment` within `BOOTING_DEADLINE_MS` is a failed recruit:
  // the adapter never launched, wedged on a launch dialog, or crashed pre-attach.
  // We ARM a deadline only when ALL THREE hold:
  //   1. `startedFresh` — no handoff. A restart/migrate carries `currentAttachment`
  //      (and a non-`booting` phase), so its successor must NEVER arm — it already
  //      has an adapter contract. Detached/other CAN successors are likewise skipped.
  //   2. `recruitedBy` present — this is an actual RECRUIT (a spawn is coming and is
  //      expected to attach). The watchdog is a failed-recruit detector — it even
  //      notifies `recruitedBy` ("recruit of <name> never attached"). Skeletons created
  //      WITHOUT a recruiter intentionally sit in `booting` awaiting a manual attach and
  //      must NOT be swept: from-upgrade re-attach skeletons (#786 — the designed
  //      await-per-player-restart behavior), conductor/`up`, manual self-bootstrap. A
  //      positive allowlist ("arm only real recruits") rather than a per-skeleton-path
  //      blocklist, so future adapterless-skeleton paths inherit the safe default.
  //   3. `canBlockOnDialog !== true` — the adapter can't park on a blocking
  //      launch-time dialog. Interactive `claude-code` (dev-channels dialog) sets
  //      this true and is DISARMED until #890 dissolves the dialog: an operator-away
  //      false-kill of a legitimately-waiting recruit is worse than the hang.
  // The structural `canBlockOnDialog` (resolved from the adapter descriptor at
  // spawn, threaded via metadata) is the contract — NOT an `agentType` hardcode.
  const startedFresh = !input.currentAttachment && (input.phase === undefined || input.phase === 'booting');
  const armBootingWatchdog =
    startedFresh && !!input.metadata.recruitedBy && input.metadata.canBlockOnDialog !== true;
  /**
   * ISO timestamp of when this run entered `booting`, or `null` when the watchdog
   * is disarmed (handoff / non-recruit skeleton / interactive / already attached).
   * Cleared on the first successful fresh claim. Only non-null ⟹ armed, so
   * `nextDeadlineMs()` and the main-loop reap can gate on `bootingSince !== null` alone.
   */
  let bootingSince: string | null = armBootingWatchdog ? workflowNow().toISOString() : null;
  if (startedFresh && input.metadata.recruitedBy && input.metadata.canBlockOnDialog === true) {
    // Visibility for the known, bounded gap (companion brief §1): interactive
    // claude-code RECRUITS keep today's indefinite-`booting` behavior until #890.
    // (Non-recruit skeletons are disarmed for a different reason — no recruiter —
    // and don't log this #890 notice.)
    workflowLog.info(
      'booting watchdog DISARMED for interactive claude-code recruit (canBlockOnDialog) — pending #890',
    );
  }

  // ── Processing Lifecycle State (fixes #99) ──
  // Tracks messages currently being processed by a blocking adapter. While non-empty,
  // stale detection is suppressed AND the phase refines to `processing`.
  const inFlightMessages = new Set<string>(input.inFlightMessageIds ?? []);
  // processingSince carried as ISO string in v0.25; normalize numeric legacy values.
  const _inputProcessingSince = input.processingSince;
  let processingSince: string | null =
    typeof _inputProcessingSince === 'string'
      ? _inputProcessingSince
      : typeof _inputProcessingSince === 'number'
        ? new Date(_inputProcessingSince).toISOString()
        : (inFlightMessages.size > 0 ? workflowNow().toISOString() : null);

  // ── Destroy State (fixes #102; §8.5 immediate-COMPLETE) ──
  // Once set, the workflow COMPLETES per §2.5 (abandon in-flight, no drain).
  // Adapter recovery code reads `isDestroyed` and exits.
  let destroyed = input.destroyed ?? false;
  let destroyRequested = destroyed;
  /** IDs of outbox entries abandoned by the last `destroy` — written to history event. */
  let destroyAbandonedIds: string[] = [];
  // PR-H (#132): the v0.25.1 `updateMetadata({ status: 'terminated' })` shim
  // path is gone. `destroyRequested` is set only by the `destroyUpdate` handler
  // below. Operator-initiated termination flows through the `destroy` verb +
  // its outbox path; adapter graceful exit fires `adapterExited`; MCP-server
  // SIGINT detaches without destroying. See
  // docs/design/session-lifecycle-rebuild-v2.md §2.5, §11.1.

  // ── Helpers ──

  /**
   * Reduce the outbox state list to a short status string for the
   * dashboard's `Messages` KV row (Q5.5 of #399 W2). Returns:
   *
   *   - `"empty"`               — no pending entries
   *   - `"N pending"`           — pending entries, oldest within `STALE_MS`
   *   - `"N pending (oldest 2m)"` — pending entries, oldest beyond
   *     the stale threshold; the magnitude (m / s) is human-rounded so
   *     the dashboard reads cleanly without further parsing.
   *
   * `STALE_MS = 30_000` per the brief — anything older than 30s pending
   * is the "outbox is backing up" signal we want to surface.
   */
  function outboxStatus(): string {
    const STALE_MS = 30_000;
    const nowMs = workflowNow().getTime();
    let count = 0;
    let oldestAge = 0;
    for (const e of outbox) {
      if (e.status !== 'pending') continue;
      count++;
      const age = nowMs - Date.parse(e.createdAt);
      if (age > oldestAge) oldestAge = age;
    }
    if (count === 0) return 'empty';
    if (oldestAge < STALE_MS) return `${count} pending`;
    const minutes = Math.floor(oldestAge / 60_000);
    const ageLabel = minutes >= 1 ? `${minutes}m` : `${Math.floor(oldestAge / 1000)}s`;
    return `${count} pending (oldest ${ageLabel})`;
  }

  /** Transition to a new phase, syncing the attachment search attribute. */
  function setPhase(next: AttachmentPhase): void {
    if (phase === next) return;
    phase = next;
    upsertSearchAttributes({ AgentTempoAttachmentState: [next] });
    lastActivityTime = workflowNow().getTime();
    activityCount++;
  }

  /** Build the token returned from `claimAttachment`. `leaseMs` is the value the caller
   *  supplied (or the default if they didn't), so the adapter knows when to heartbeat. */
  function attachmentTokenFrom(a: Attachment, leaseMs: number): AttachmentToken {
    return {
      attachmentId: a.attachmentId,
      runId: a.runId,
      expiresAt: a.expiresAt,
      leaseMs,
    };
  }

  /** Compute next time-based deadline for the main loop. Returns +Infinity when no deadline applies. */
  function nextDeadlineMs(): number {
    const nowMs = workflowNow().getTime();
    const candidates: number[] = [];
    // #704 — booting attach-timeout. `bootingSince` is non-null only while the
    // watchdog is armed AND the session is still booting (cleared on fresh claim).
    if (phase === 'booting' && bootingSince) {
      candidates.push(new Date(bootingSince).getTime() + BOOTING_DEADLINE_MS);
    }
    if (currentAttachment) {
      candidates.push(new Date(currentAttachment.expiresAt).getTime());
    }
    if (processingSince) {
      candidates.push(new Date(processingSince).getTime() + PROCESSING_DEADLINE_MS);
    }
    if (phase === 'draining') {
      // #809 — draining must ALWAYS yield a firing deadline so the main loop
      // re-wakes and the §9.5.c reap can fire. With `drainingSince` stamped, use
      // the per-detach window capped at the absolute ceiling; without it (the
      // wedge shape — Infinity deadline, same as booting/#704) fall back to
      // `nowMs` so the loop reaps on its very next pass instead of returning
      // POSITIVE_INFINITY below.
      const window = Math.min(
        drainingDeadlineMs ?? DEFAULT_DRAINING_DEADLINE_MS,
        DRAINING_DEADLINE_MS,
      );
      candidates.push(drainingSince ? new Date(drainingSince).getTime() + window : nowMs);
    }
    if (candidates.length === 0) return Number.POSITIVE_INFINITY;
    return Math.max(0, Math.min(...candidates) - nowMs);
  }

  // ── Outbox Update + Query Handlers ──

  setHandler(submitOutboxUpdate, (entryInput: OutboxEntryInput) => {
    const entry: OutboxEntry = {
      ...entryInput,
      id: uuid4(),
      createdAt: workflowNow().toISOString(),
      status: 'pending',
    } as OutboxEntry;
    outbox.push(entry);
    // #399 W2 — every outbox submission counts as outbound traffic.
    sentCount++;

    // Record in sentMessages for history continuity
    if (entry.type === 'cue') {
      // #357: forward broadcastId so the sender's view reflects the same
      // grouping the receiver sees.
      sentMessages.push({
        id: entry.id,
        to: entry.targetPlayerId,
        text: entry.message,
        timestamp: entry.createdAt,
        ...(entry.broadcastId !== undefined ? { broadcastId: entry.broadcastId } : {}),
      });
    } else if (entry.type === 'report') {
      sentMessages.push({ id: entry.id, to: 'conductor', text: `[${entry.reportType}] ${entry.text}`, timestamp: entry.createdAt });
    } else if (entry.type === 'stop') {
      sentMessages.push({ id: entry.id, to: entry.targetPlayerId, text: '[stop requested]', timestamp: entry.createdAt });
    } else if (entry.type === 'detach') {
      sentMessages.push({ id: entry.id, to: entry.targetPlayerId, text: '[detach requested]', timestamp: entry.createdAt });
    } else if (entry.type === 'destroy') {
      sentMessages.push({ id: entry.id, to: entry.targetPlayerId, text: '[destroy requested]', timestamp: entry.createdAt });
    } else if (entry.type === 'restart') {
      sentMessages.push({ id: entry.id, to: entry.targetPlayerId, text: '[restart requested]', timestamp: entry.createdAt });
    } else if (entry.type === 'release') {
      sentMessages.push({ id: entry.id, to: entry.targetPlayerId, text: '[release requested]', timestamp: entry.createdAt });
    } else if (entry.type === 'reset') {
      sentMessages.push({ id: entry.id, to: entry.targetPlayerId, text: '[reset requested]', timestamp: entry.createdAt });
    }

    lastActivityTime = workflowNow().getTime();
    activityCount++;
    lastOutboundTime = workflowNow().getTime();
    return entry.id;
  }, {
    validator: (entry: OutboxEntryInput) => {
      if (!entry.type) throw new ApplicationFailure('Outbox entry must have a type', 'InvalidOutboxEntry', true);
    },
  });

  setHandler(outboxQuery, () => outbox);

  // ── Player Signal Handlers ──

  setHandler(receiveMessageSignal, (msg) => {
    // #910 — at-least-once dedup: a redelivered cue (same originating outbox
    // entry id) is a true no-op — skip the append AND the counter/activity
    // bumps below so a CAN/crash mid-dispatch or activity retry can't
    // double-apply. Un-threaded callers (no deliveryId) are never deduped.
    if (!recordDelivery(msg.deliveryId)) return;
    messages.push({
      id: uuid4(),
      from: msg.from,
      text: msg.text,
      timestamp: workflowNow().toISOString(),
      delivered: false,
      isMaestro: msg.isMaestro,
      // #357: thread the broadcast id (if any) onto the stored Message
      // so subsequent `allMessages`/`fetchEnsembleChat` queries surface
      // it for TUI grouping.
      ...(msg.broadcastId !== undefined ? { broadcastId: msg.broadcastId } : {}),
      // #318: thread the coat-check ticket (if any) onto the stored
      // Message so `recall` / `fetchPlayerMessages` surface it and the
      // recipient knows to fetch via `coat_check_get`.
      ...(msg.attachmentTicket !== undefined ? { attachmentTicket: msg.attachmentTicket } : {}),
    });
    lastActivityTime = workflowNow().getTime();
    activityCount++;
    // #399 W2 — every inbound cue counts as received traffic.
    receivedCount++;
    // Track inbound messages that expect a response (default: true for backward compat)
    if (msg.responseRequested !== false) {
      lastInboundRRTime = workflowNow().getTime();
    }
  });

  setHandler(setPartSignal, (newPart) => {
    part = newPart;
    // T0.5 (#747) — mirror part to the memo so observers (maestro refresh,
    // daemon aggregate — T0.1) can read it from visibility list results
    // instead of a per-player getPart query. Low-churn by nature: part
    // changes when a player re-describes its work, not per message.
    upsertMemo({ [MEMO_KEYS.part]: newPart });
    lastActivityTime = workflowNow().getTime();
    activityCount++;
    lastOutboundTime = workflowNow().getTime();
  });

  setHandler(setNameSignal, (newName) => {
    input.metadata.playerId = newName;
    upsertSearchAttributes({ AgentTempoPlayerId: [newName] });
    lastActivityTime = workflowNow().getTime();
    activityCount++;
  });

  setHandler(markDeliveredSignal, (ids) => {
    for (const msg of messages) {
      if (ids.includes(msg.id)) {
        msg.delivered = true;
      }
    }
    // Any delivery proves the session is alive
    lastActivityTime = workflowNow().getTime();
    activityCount++;
  });

  // ── Reset (D14) — set by deliverReset, polled + acked by the Pi extension ──
  //
  // INVARIANT (#750): the reset path must never mutate `messages` — the Pi
  // pump prefetches cues ALONGSIDE the reset in one `pendingIntake` query;
  // a reset variant that drops/edits queued messages would break the
  // prefetch-before-wipe equivalence (the prefetched cue list would no
  // longer match post-wipe workflow state) and would require the pump to
  // re-fetch after the wipe. If you are adding e.g. a `dropQueued: true`
  // reset option, change the pump's intake ordering FIRST.
  setHandler(setPendingResetSignal, (r) => {
    // Latest-wins; stamp requestedAt deterministically (workflowNow, not the activity's clock).
    pendingReset = {
      resetId: r.resetId,
      fresh: r.fresh,
      ...(r.reason !== undefined ? { reason: r.reason } : {}),
      ...(r.requestedBy !== undefined ? { requestedBy: r.requestedBy } : {}),
      requestedAt: workflowNow().toISOString(),
    };
    lastActivityTime = workflowNow().getTime();
    activityCount++;
  });
  setHandler(ackResetSignal, (resetId) => {
    // Race-safe: only clear if the ack matches the current pending reset, so a
    // newer reset landing during the extension's wipe isn't silently dropped.
    if (pendingReset?.resetId === resetId) {
      pendingReset = null;
    }
    lastActivityTime = workflowNow().getTime();
    activityCount++;
  });

  setHandler(updateMetadataSignal, (update) => {
    if (update.hostname != null) input.metadata.hostname = update.hostname;
    if (update.gitBranch != null) input.metadata.gitBranch = update.gitBranch;
    if (update.gitRoot != null) input.metadata.gitRoot = update.gitRoot;
    if (update.playerType != null) input.metadata.playerType = update.playerType;
    if (update.playerTypeDescription != null) input.metadata.playerTypeDescription = update.playerTypeDescription;
    if (update.worktreePath != null) input.metadata.worktreePath = update.worktreePath;
    if (update.sessionId != null || (update as any).claudeSessionId != null) {
      input.metadata.sessionId = update.sessionId ?? (update as any).claudeSessionId;
    }
    // `update.enableStaleDetection` is silently dropped — attachment phase
    // (driven by the V2 wire surface: claimAttachment / adapterExited /
    // forceDetach / destroy) is authoritative for lifecycle state.
    upsertSearchAttributes({
      AgentTempoEnsemble: [input.metadata.ensemble],
      AgentTempoPlayerId: [input.metadata.playerId],
      AgentTempoHostname: [input.metadata.hostname],
    });
    // T0.5 — keep the memo mirror current (low-churn: metadata updates are
    // rare lifecycle events, not per-message traffic).
    upsertMemo(metaMemo());
    lastActivityTime = workflowNow().getTime();
    activityCount++;
  });

  setHandler(recordSentMessageSignal, (msg) => {
    sentMessages.push({
      id: uuid4(),
      to: msg.to,
      text: msg.text,
      timestamp: workflowNow().toISOString(),
      // #357: mirror Message.broadcastId on the sender side so the
      // TUI's local-side projection sees the same fold key.
      ...(msg.broadcastId !== undefined ? { broadcastId: msg.broadcastId } : {}),
    });
  });

  // ── Player Query Handlers ──

  setHandler(getPartQuery, () => part);
  setHandler(getMetadataQuery, () => input.metadata);
  setHandler(pendingMessagesQuery, () => messages.filter((m) => !m.delivered));
  // T0.3 (#750) — combined intake: the SAME two read expressions as
  // `pendingMessages` (above) and `pendingReset` (reset section) in one
  // query, so the Pi pump pays 1 billable action/tick instead of 2. Keep
  // all three handlers serving — old pumps query the legacy pair.
  setHandler(pendingIntakeQuery, () => ({
    messages: messages.filter((m) => !m.delivered),
    pendingReset,
  }));
  setHandler(allMessagesQuery, () => messages);
  setHandler(allSentMessagesQuery, () => sentMessages);

  // ── #399 W2 — Wire extension queries (Q5.2 / Q5.5 / Q5.6 / Q5.7) ──

  setHandler(getRunIdQuery, () => workflowInfo().runId);

  setHandler(getMessagingStateQuery, () => ({
    received: receivedCount,
    sent: sentCount,
    outbox: outboxStatus(),
  }));

  setHandler(getActivityStateQuery, () => ({
    activityCount,
    lastActivityAt: new Date(lastActivityTime).toISOString(),
  }));

  setHandler(getLeaseStateQuery, () => {
    if (!currentAttachment) return { expiresAt: null, leaseMs: null };
    return {
      expiresAt: Date.parse(currentAttachment.expiresAt),
      leaseMs: currentAttachment.leaseMs,
    };
  });

  // 3c Tier-1 — surface the latest coarse activity for the snapshot fan-out.
  setHandler(getCoarseActivityQuery, () => ({ ...coarseActivity }));

  // ── Hold / Release Handlers ──

  setHandler(releaseHeldSignal, () => {
    if (heldMessage) {
      // Deliver the stored initial message now that the hold is released
      messages.push({
        id: uuid4(),
        from: input.metadata.recruitedBy || 'system',
        text: heldMessage,
        timestamp: workflowNow().toISOString(),
        delivered: false,
      });
      heldMessage = undefined;
    }
    outboxLocked = false;
  });

  setHandler(outboxLockedQuery, () => outboxLocked);

  // ── Pause / Resume Handlers ──

  setHandler(setPausedSignal, (value: boolean) => {
    paused = value;
  });

  setHandler(pausedQuery, () => paused);

  // ── Processing Lifecycle Handlers (fixes #99; v0.25 phase-aware) ──

  setHandler(processingStartUpdate, ({ messageId, expectedAttachmentId }) => {
    // `expectedAttachmentId` is optional for shim compatibility; when provided, only operate
    // if it matches the current attachment (prevents late updates from a superseded adapter).
    if (expectedAttachmentId && currentAttachment?.attachmentId !== expectedAttachmentId) {
      throw ApplicationFailure.nonRetryable(
        `Attachment ${expectedAttachmentId} does not match current ${currentAttachment?.attachmentId ?? 'none'}`,
        'AttachmentMismatch',
      );
    }
    const wasEmpty = inFlightMessages.size === 0;
    inFlightMessages.add(messageId);
    if (wasEmpty) {
      processingSince = workflowNow().toISOString();
      // Phase refinement: if we're attached (or awaiting), move to `processing`.
      if (phase === 'attached' || phase === 'awaiting') setPhase('processing');
      // #704 Item 2 — setting `processingSince` adds a new `PROCESSING_DEADLINE_MS`
      // deadline; bump `wakeEpoch` so the main loop arms it immediately rather than
      // relying on the backstop cap (the historical reason for the 5-min cap).
      wakeEpoch++;
    }
    lastActivityTime = workflowNow().getTime();
    activityCount++;
    return { inFlightCount: inFlightMessages.size };
  }, {
    validator: ({ messageId }) => {
      if (!messageId || typeof messageId !== 'string') {
        throw ApplicationFailure.nonRetryable(
          'processingStart requires a non-empty messageId',
          'InvalidMessageId',
        );
      }
      if (phase === 'gone') {
        throw ApplicationFailure.nonRetryable(
          'Cannot start processing on destroyed session',
          'WorkflowGone',
        );
      }
    },
  });

  setHandler(processingEndUpdate, ({ messageId, expectedAttachmentId }) => {
    if (expectedAttachmentId && currentAttachment?.attachmentId !== expectedAttachmentId) {
      throw ApplicationFailure.nonRetryable(
        `Attachment ${expectedAttachmentId} does not match current ${currentAttachment?.attachmentId ?? 'none'}`,
        'AttachmentMismatch',
      );
    }
    inFlightMessages.delete(messageId);
    if (inFlightMessages.size === 0) {
      processingSince = null;
      // Phase refinement (§2.2, §2.4; fixes #117): when in-flight drops to 0, move
      // back out of `processing`. If the outbox has nothing left to dispatch, land
      // directly in `awaiting` (idle refinement of attached). Otherwise `attached`,
      // and the main-loop outbox-dispatch drain will refine to `awaiting` once the
      // outbox clears.
      if (phase === 'processing') {
        const outboxIdle = !outbox.some(
          (e) => e.status === 'pending' || e.status === 'processing',
        );
        setPhase(outboxIdle ? 'awaiting' : 'attached');
      }
      // #704 Item 2 — clearing `processingSince` removes the processing deadline;
      // bump `wakeEpoch` so the main loop re-evaluates (and dispatches any pending
      // outbox) immediately rather than waiting on the backstop cap.
      wakeEpoch++;
    }
    lastActivityTime = workflowNow().getTime();
    activityCount++;
    return { inFlightCount: inFlightMessages.size };
  }, {
    validator: ({ messageId }) => {
      if (!messageId || typeof messageId !== 'string') {
        throw ApplicationFailure.nonRetryable(
          'processingEnd requires a non-empty messageId',
          'InvalidMessageId',
        );
      }
    },
  });

  setHandler(inFlightMessagesQuery, () => [...inFlightMessages]);

  // ── Destroy Handler (fixes #102; design §8.5) ──
  // Terminal: set phase = gone, revoke attachment, emit audit event with abandoned outbox
  // IDs, return from main loop → workflow COMPLETES. Per §2.5: abandon in-flight outbox
  // (no drain wait) — destroy is an explicit operator action; delivery is best-effort.
  //
  // #164: the handler is `async` because it also fires `hardTerminateAttachment` on the
  // host's per-host task queue before the state flip, to prevent an orphaned claude.exe
  // when destroy is invoked while an attachment is live. Unlike `forceDetachUpdate` this
  // is wrapped best-effort — a failure there MUST NOT wedge the workflow, because destroy
  // is terminal by contract. See issue #164 for the orphan repro.

  setHandler(destroyUpdate, async ({ reason, terminatedBy }) => {
    if (phase === 'gone') return; // idempotent
    // Record abandoned outbox entries for the history/audit event.
    destroyAbandonedIds = outbox
      .filter((e) => e.status === 'pending' || e.status === 'processing')
      .map((e) => e.id);
    if (destroyAbandonedIds.length > 0) {
      workflowLog.warn(
        `destroy abandoning ${destroyAbandonedIds.length} outbox entr${destroyAbandonedIds.length === 1 ? 'y' : 'ies'}: ${destroyAbandonedIds.join(', ')}` +
        `${reason ? ` (reason: ${reason})` : ''}`,
      );
    } else if (reason) {
      workflowLog.info(`destroy requested (reason: ${reason})`);
    }
    // #164: await hardTerminate BEFORE flipping `destroyRequested` / `phase`. Must
    // await (fire-and-forget is dropped because the workflow's main loop exits as
    // soon as destroyRequested=true, before the activity has a chance to dispatch).
    // Best-effort: 5s timeout, log-and-continue on failure. `destroyRequested` flips
    // AFTER the activity so the main loop stays alive to dispatch it.
    //
    // #227: the original (#164) guard was `if (currentAttachment)` — correct for the
    // `phase=attached` case but silently skipped the kill when `phase=detached`, leaking
    // `claude.exe` + terminal tab when a destroy ran on a session whose lease had been
    // reaped. The ensemble cascade exposed by #226/#201 made this a reliable orphan
    // generator: destroy → workflow COMPLETES, process survives. Fix: pick the best
    // host we have from workflow state and fire the kill whenever *any* host is known.
    //
    // `hardTerminateAttachment` is already safe to run speculatively — it does image-
    // name PID-reuse guards + command-line matching on `-n <playerName>` AND
    // `--remote-control-session-name-prefix <ensemble>`, so a stale state that no
    // longer corresponds to a live process returns `strategy: 'none'` with a clean
    // log line. No new PID / attach-time wire-protocol fields needed.
    //
    // Host-pick priority (aligns with the reap path's provenance tracking):
    //   1. `currentAttachment.hostname`  — `phase=attached` / `processing` / `awaiting`
    //   2. `lastAdapterMeta.hostname`    — `phase=detached` (set by forceDetach / reap)
    //   3. `preferredHost`               — post-CAN restore before any adapter landed
    //   4. `input.metadata.hostname`     — recruit-time fallback (booting path)
    const killHost =
      currentAttachment?.hostname ??
      lastAdapterMeta?.hostname ??
      preferredHost ??
      input.metadata.hostname;
    if (killHost) {
      try {
        const killResult: HardTerminateResult = await getHardTerminateProxyForDestroy(killHost)({
          ensemble: input.metadata.ensemble,
          playerName: input.metadata.playerId,
          agent: (input.metadata.agentType ?? 'claude') as AgentType,
          workDir: input.metadata.workDir,
        });
        workflowLog.info(
          `destroy hard-terminate on ${killHost} (phase=${phase}): strategy=${killResult.strategy}, ` +
          `killedPids=[${killResult.killedPids.join(',')}]`,
        );
      } catch (err) {
        workflowLog.warn(
          `destroy hard-terminate failed on ${killHost} (continuing, best-effort): ` +
          `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    // Flip destroyRequested AFTER the kill so the main loop stays alive for activity
    // dispatch. Any concurrent claimAttachment / processingStart that arrives during
    // the 5s kill window will still hit the phase!=='gone' guard until we setPhase
    // below; on rare kill-in-progress races, the new work is abandoned by setPhase('gone').
    destroyRequested = true;
    // Revoke attachment (if any) — record metadata for orphanSummary/audit.
    if (currentAttachment) {
      lastAdapterMeta = { hostname: currentAttachment.hostname, adapterId: currentAttachment.adapterId };
      lastDetachReason = 'destroy';
      currentAttachment = null;
    }
    upsertSearchAttributes({
      AgentTempoAttachedHost: [''],
    });
    // #704 Item 1b — stamp the typed close-reason MEMO on this terminal
    // completion. The bootstrap orphan-guard (`server.ts`) reads it via
    // `describe().memo` to self-tombstone a late-launching orphan process whose
    // run was destroyed and never recreated (no running run + this reason).
    // #897 (B2) — co-stamp the session's sessionId so the orphan-guard matches by
    // EXACT identity (closed run's sessionId == the booting process's own) instead
    // of a wall-clock TTL. Source: the spawn identity, falling back to metadata.
    upsertMemo({
      [MEMO_KEYS.closeReason]: 'destroyed',
      ...(closeMemoSessionId() ? { [MEMO_KEYS.sessionId]: closeMemoSessionId() } : {}),
    });
    setPhase('gone');
    // Inject a final audit message so the old adapter-completion path has something to show.
    messages.push({
      id: uuid4(),
      from: terminatedBy || 'system',
      text: `Session destroyed${reason ? `: ${reason}` : ''}.`,
      timestamp: workflowNow().toISOString(),
      delivered: false,
    });
    lastActivityTime = workflowNow().getTime();
    activityCount++;
    // #704 Item 2 — `destroyRequested` (set above) is in the main-loop predicate,
    // but bump `wakeEpoch` too so a loop asleep on a far deadline wakes promptly
    // to run the terminal exit path.
    wakeEpoch++;
  });

  setHandler(isDestroyedQuery, () => destroyed || destroyRequested);

  // ── Test-only CAN trigger (#226) ──
  // Force the next main-loop iteration into the `continueAsNew` branch without
  // waiting for the server's history-size threshold. Production code never sends
  // this; the adapter reconnect test uses it to exercise the CAN-boundary path
  // in <1s instead of emitting ~10k filler events. One-shot: the flag is cleared
  // when the main loop acts on it, so repeated signals require repeated sends.
  //
  // The `wakeEpoch` bump is essential — the main loop's `condition()` predicate
  // (see §9.5 loop body below) only wakes on outbox activity, phase changes,
  // destroy, or `wakeEpoch` drift. Without the bump, an idle session would sit
  // asleep until its lease-expiry deadline and the test would time out.
  let forceContinueAsNew = false;
  setHandler(testForceContinueAsNewSignal, () => {
    forceContinueAsNew = true;
    wakeEpoch++;
    lastActivityTime = workflowNow().getTime();
    activityCount++;
  });

  // ── v0.25 Attachment Lifecycle Handlers (design §§8, §9.2, §9.5) ──

  /**
   * `claimAttachment` — transactional claim / renewal of the attachment lease.
   * Pseudocode and behavior per design §9.2.
   */
  setHandler(claimAttachmentUpdate, ({ host, adapterId, adapterClass, leaseMs, expectedAttachmentId }) => {
    if (phase === 'gone') {
      throw ApplicationFailure.nonRetryable(
        `Cannot attach to ${workflowInfo().workflowId}: workflow is terminated`,
        'WorkflowGone',
      );
    }
    const now = workflowNow();
    const nowMs = now.getTime();

    // Renewal path: caller provides a valid expectedAttachmentId matching the current
    // attachment, and the lease hasn't expired yet.
    if (
      currentAttachment &&
      currentAttachment.attachmentId === expectedAttachmentId &&
      new Date(currentAttachment.expiresAt).getTime() > nowMs
    ) {
      currentAttachment.lastHeartbeatAt = now.toISOString();
      currentAttachment.expiresAt = new Date(nowMs + leaseMs).toISOString();
      // Honour the caller's renewal-time leaseMs so subsequent heartbeats extend
      // the lease by the current negotiated value (not the claim-time value).
      currentAttachment.leaseMs = leaseMs;
      lastActivityTime = nowMs;
      activityCount++;
      // #704 Item 2 — this mutates `expiresAt` (a `nextDeadlineMs()` input); bump
      // `wakeEpoch` so the main loop re-evaluates the new lease deadline instead
      // of relying on the backstop cap.
      wakeEpoch++;
      return attachmentTokenFrom(currentAttachment, leaseMs);
    }

    // Conflict: active lease held by someone else.
    if (currentAttachment && new Date(currentAttachment.expiresAt).getTime() > nowMs) {
      throw ApplicationFailure.nonRetryable(
        `Attached on ${currentAttachment.hostname} until ${currentAttachment.expiresAt}`,
        'AttachmentConflict',
      );
    }

    // Free or expired — claim fresh.
    const newAttachment: Attachment = {
      attachmentId: uuid4(),
      hostname: host,
      adapterId,
      adapterClass,
      claimedAt: now.toISOString(),
      lastHeartbeatAt: now.toISOString(),
      expiresAt: new Date(nowMs + leaseMs).toISOString(),
      leaseMs,
      runId: workflowInfo().runId,
    };
    currentAttachment = newAttachment;
    lastAdapterMeta = { hostname: newAttachment.hostname, adapterId: newAttachment.adapterId };
    preferredHost = host;
    // Fresh claim abandons any residual in-flight messageIds from the previous adapter.
    inFlightMessages.clear();
    processingSince = null;
    // A fresh claim always supersedes an in-flight drain; clear its window so a later
    // `requestDetach` starts from the default and doesn't inherit a stale value.
    drainingSince = null;
    drainingDeadlineMs = null;
    detachedSince = null;
    // #704 Item 1a — first successful claim: disarm the booting watchdog so
    // `nextDeadlineMs()` drops the booting deadline (the lease deadline takes over).
    bootingSince = null;
    setPhase('attached');
    upsertSearchAttributes({
      AgentTempoAttachedHost: [host],
    });
    lastActivityTime = nowMs;
    activityCount++;
    // #704 Item 2 — a fresh claim moves a `booting`/`detached` session to a
    // finite lease deadline (often from `+Infinity`); bump `wakeEpoch` so the
    // main loop picks up the new deadline immediately.
    wakeEpoch++;
    return attachmentTokenFrom(newAttachment, leaseMs);
  }, {
    validator: ({ host, leaseMs, protocolVersion, sessionId }) => {
      // #786 — cross-host cutover safety, checked FIRST (pure, synchronous, no
      // IO, no history event — rejects pre-admission). A v1 adapter omits
      // `protocolVersion` (→ undefined); any value other than PROTOCOL_VERSION is
      // a stale/foreign adapter that must not claim this 2.0 workflow. Actionable
      // error names the host + the fix.
      if (protocolVersion !== PROTOCOL_VERSION) {
        throw ApplicationFailure.nonRetryable(
          `claimAttachment rejected on ${workflowInfo().workflowId}: adapter on host ` +
          `'${host}' speaks protocol ${protocolVersion ?? '(v1/unset)'}, but this is a ` +
          `protocol-${PROTOCOL_VERSION} (2.0) workflow. Upgrade the agent-tempo install on ` +
          `that host to 2.0 (it cannot drive a 2.0 session).`,
          'ProtocolMismatch',
        );
      }
      // #897 (B1) — spawn-identity discriminator. Reject ONLY a DEFINITE
      // mismatch: both the claimant's `sessionId` AND the workflow's current
      // `metadata.sessionId` are present and differ → a stale orphan adapter
      // (its run was superseded by a re-spawn with a fresh sessionId). Unset on
      // either side → allow (legacy adapters; fresh claims that land before
      // `metadata.sessionId` is populated). Pure/pre-admission like the protocol
      // check — a rejected stale claim records no history event.
      if (
        sessionId !== undefined &&
        input.metadata.sessionId !== undefined &&
        sessionId !== input.metadata.sessionId
      ) {
        throw ApplicationFailure.nonRetryable(
          `claimAttachment rejected on ${workflowInfo().workflowId}: claimant sessionId ` +
          `'${sessionId}' does not match this session's '${input.metadata.sessionId}' — ` +
          `a stale orphan adapter whose run was superseded. The live adapter holds the session.`,
          'SessionIdMismatch',
        );
      }
      if (!Number.isInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 600_000) {
        throw ApplicationFailure.nonRetryable(
          `leaseMs must be between 1000 and 600000, got ${leaseMs}`,
          'InvalidLease',
        );
      }
    },
  });

  /**
   * `forceDetach` — revoke the current attachment. `expectedAttachmentId` guards against TOCTOU.
   * `gracePeriodMs` is reserved for future use (§8.3); v0.25 PR-A ignores it and detaches
   * immediately — PR-D's `restart` flow passes `gracePeriodMs: 0`.
   *
   * #159 Gap 2: this handler is the canonical "kill then flip" point. Before we null out
   * the attachment and transition to `detached`, we invoke `hardTerminateAttachment` on the
   * reaped host's per-host task queue so the child process tree is actually torn down at
   * the OS level. If the activity throws, the update itself throws and the caller
   * (`deliverRestart`, operator tooling) retries — we DON'T silently flip state while the
   * orphan is still alive, because that produces exactly the bug reported in #159.
   */
  setHandler(forceDetachUpdate, async ({ reason, expectedAttachmentId }) => {
    if (phase === 'gone') {
      throw ApplicationFailure.nonRetryable('Workflow is terminated', 'WorkflowGone');
    }
    if (!currentAttachment) {
      return { reaped: false };
    }
    if (expectedAttachmentId && currentAttachment.attachmentId !== expectedAttachmentId) {
      // TOCTOU — the expected attachment is already gone; don't reap a fresh one.
      return { reaped: false };
    }
    const reaped = currentAttachment;
    const previousId = reaped.attachmentId;

    // Kill OS process tree on the host where the adapter is actually running. In
    // production `reaped.hostname === input.metadata.hostname` — both are the machine
    // that spawned the child — but `metadata.hostname` is the more stable routing key
    // (attachments can come and go during cross-host restart flows, and test harnesses
    // sometimes set the two fields independently). Failure aborts the update so the
    // workflow state stays in sync with what actually happened on the host.
    const killHost = input.metadata.hostname;
    try {
      const killResult: HardTerminateResult = await getHardTerminateProxy(killHost)({
        ensemble: input.metadata.ensemble,
        playerName: input.metadata.playerId,
        agent: (input.metadata.agentType ?? 'claude') as AgentType,
        workDir: input.metadata.workDir,
      });
      workflowLog.info(
        `forceDetach hard-terminate on ${killHost}: strategy=${killResult.strategy}, ` +
        `killedPids=[${killResult.killedPids.join(',')}]`,
      );
    } catch (err) {
      // Turn into an ApplicationFailure so the caller sees a clean retry signal rather
      // than a raw activity timeout / cancelation.
      throw ApplicationFailure.nonRetryable(
        `forceDetach hard-terminate failed on ${killHost}: ` +
        `${err instanceof Error ? err.message : String(err)}. ` +
        `Refusing to flip phase to detached while the OS process may still be live.`,
        'HardTerminateFailed',
      );
    }

    // #798 — post-await re-check (V2 of the #782 audit): this update is
    // async and non-atomic across the kill-await. If the OLD attachment was
    // reaped while we awaited hardTerminate (lease expiry → main loop) and a
    // FRESH claim landed, the unconditional null-out below would clobber the
    // new attachment — and the kill we just ran may have hit the new
    // adapter's process too (same host + player match; that half self-heals
    // via the phase watcher → re-claim). Returning { reaped: false } keeps
    // workflow state consistent with the surviving claim. The pre-await
    // TOCTOU guard above cannot cover this window.
    //
    // The null case is covered too: currentAttachment === null here means
    // the main-loop reaper already detached (and recorded its own
    // lastAdapterMeta / lastDetachReason / detachedSince) while we awaited
    // — skipping the block below intentionally preserves the reaper's
    // metadata rather than re-running the detach idempotently.
    //
    // Marker (#798, architect-ruled on #782): the skipped branch contains
    // upsertSearchAttributes COMMANDS, so an ungated skip would replay-
    // mismatch any history that recorded the race — conservative tiebreak.
    // Evaluated lazily (the v0.26-can-lease-from-attachment single-use
    // precedent): only histories that hit forceDetach record the marker.
    if (currentAttachment?.attachmentId !== reaped.attachmentId) {
      workflowLog.info(
        `forceDetach: attachment changed during hard-terminate await ` +
        `(expected ${reaped.attachmentId}, now ${currentAttachment?.attachmentId ?? 'none'}) — ` +
        `not clobbering the fresh claim`,
      );
      return { reaped: false };
    }
    lastAdapterMeta = { hostname: reaped.hostname, adapterId: reaped.adapterId };
    lastDetachReason = reason;
    currentAttachment = null;
    inFlightMessages.clear();
    processingSince = null;
    drainingSince = null;
    drainingDeadlineMs = null;
    detachedSince = workflowNow().toISOString();
    setPhase('detached');
    upsertSearchAttributes({
      AgentTempoAttachedHost: [''],
    });
    // #159 Gap 1b: wake the main loop — `phase === 'detached'` isn't in the predicate
    // and the condition would otherwise sleep on the now-stale lease-expiry deadline.
    wakeEpoch++;
    return { reaped: true, previousAttachmentId: previousId };
  });

  /**
   * Enqueue a spawn outbox entry carrying the claim token. PR-C commit 6 (#118)
   * replaced the double-cast `type: 'recruit'` workaround with a dedicated
   * `SpawnOutboxEntry` discriminated-union variant. The dispatch branch
   * (`case 'spawn':` below) routes through `startRecruitedSession` today and
   * will be extended by PR-D to forward `attachmentId`/`runId`/`resume`/
   * `sessionId`/`adapterId` into the activity signature so the adapter boots
   * into the pre-claimed attachment.
   */
  setHandler(enqueueSpawnUpdate, ({ host, attachmentId, runId, resume, sessionId, adapterId, agentDefinition, agentDefinitionPath, nativeResolvable, model }) => {
    const spawnEntryId = uuid4();
    const entry: SpawnOutboxEntry = {
      id: spawnEntryId,
      type: 'spawn',
      targetName: input.metadata.playerId,
      workDir: input.metadata.workDir,
      isConductor: input.metadata.isConductor,
      agent: (input.metadata.agentType ?? 'claude') as AgentType,
      targetHostname: host,
      attachmentId,
      attachmentRunId: runId,
      resumeAttachment: resume,
      sessionId,
      adapterId,
      agentDefinition,
      agentDefinitionPath,
      nativeResolvable,
      // #131 Phase C — claude-api model id carried across restart.
      ...(model !== undefined ? { model } : {}),
      createdAt: workflowNow().toISOString(),
      status: 'pending',
    };
    outbox.push(entry);
    lastActivityTime = workflowNow().getTime();
    activityCount++;
    lastOutboundTime = workflowNow().getTime();
    return { spawnEntryId };
  });

  /** Record a preferred host. Used by `reconcileOnBoot` (§10) in later PRs. */
  setHandler(setPreferredHostUpdate, ({ host }) => {
    preferredHost = host;
    lastActivityTime = workflowNow().getTime();
    activityCount++;
  });

  /**
   * `heartbeat` signal — extend the lease. Last-write-wins via the `attachmentId` guard;
   * heartbeats for superseded attachments are ignored.
   */
  setHandler(heartbeatSignal, ({ attachmentId, currentTool, contextTokens, contextPercent }) => {
    if (!currentAttachment || currentAttachment.attachmentId !== attachmentId) return;
    const now = workflowNow();
    currentAttachment.lastHeartbeatAt = now.toISOString();
    // #119a: extend by the caller-negotiated `leaseMs` stored on the attachment at
    // claim time, not a workflow-side default. Adapters with non-default lease windows
    // (e.g. test harnesses running accelerated clocks) get the lease duration they asked for.
    currentAttachment.expiresAt = new Date(now.getTime() + currentAttachment.leaseMs).toISOString();
    lastActivityTime = now.getTime();
    activityCount++;
    // 3c Tier-1 — refresh coarse activity from the heartbeat piggyback. Field-wise
    // merge: only fields the sender included are updated. `currentTool` can be a
    // legitimate `null` (idle), so `!== undefined` distinguishes "sent null" from
    // "not sent" (a non-reporting sender leaves prior coarse intact).
    if (currentTool !== undefined) coarseActivity.currentTool = currentTool;
    if (contextTokens !== undefined) coarseActivity.contextTokens = contextTokens;
    if (contextPercent !== undefined) coarseActivity.contextPercent = contextPercent;
  });

  /**
   * `requestDetach` signal — adapter-initiated graceful detach. Transitions to `draining`;
   * main loop reaps to `detached` when outbox is drained OR `drainingDeadline` elapses.
   *
   * Fix for #159 Gap 1a: previously this handler destructured only `reason` and threw away
   * `deadlineMs`, so the workflow always used `DEFAULT_DRAINING_DEADLINE_MS` regardless of
   * what the caller requested. We now store the caller's window in `drainingDeadlineMs` so
   * `nextDeadlineMs()` and the §9.5.c reap block honor it.
   *
   * Fix for #159 Gap 1b: bumping `wakeEpoch` causes the main-loop `condition(...)` predicate
   * to flip, waking it from its pre-existing (longer) timer so it re-computes `nextDeadlineMs()`
   * with the fresh, sooner drainingDeadline. Without this, the signal lands while the loop is
   * asleep on a lease-expiry timer and the phase stays in `draining` until that far-away
   * timer fires — exactly the smoke-test repro in #159.
   */
  setHandler(requestDetachSignal, ({ reason, deadlineMs }) => {
    if (!currentAttachment || phase === 'gone') return;
    if (phase === 'draining' || phase === 'detached') return; // idempotent
    drainingSince = workflowNow().toISOString();
    drainingDeadlineMs =
      typeof deadlineMs === 'number' && Number.isFinite(deadlineMs) && deadlineMs >= 0
        ? deadlineMs
        : DEFAULT_DRAINING_DEADLINE_MS;
    lastDetachReason = reason;
    setPhase('draining');
    lastActivityTime = workflowNow().getTime();
    activityCount++;
    wakeEpoch++;
  });

  /**
   * `adapterExited` signal — collapses `draining → detached` immediately if `attachmentId` matches.
   */
  setHandler(adapterExitedSignal, ({ attachmentId, reason }) => {
    if (phase === 'detached' || phase === 'gone') return;
    if (!currentAttachment || currentAttachment.attachmentId !== attachmentId) return;
    lastAdapterMeta = { hostname: currentAttachment.hostname, adapterId: currentAttachment.adapterId };
    lastDetachReason = reason;
    currentAttachment = null;
    inFlightMessages.clear();
    processingSince = null;
    drainingSince = null;
    drainingDeadlineMs = null;
    detachedSince = workflowNow().toISOString();
    setPhase('detached');
    upsertSearchAttributes({
      AgentTempoAttachedHost: [''],
    });
    lastActivityTime = workflowNow().getTime();
    activityCount++;
    // Wake main loop; the pre-existing condition timer was sized for the old lease
    // window which no longer applies.
    wakeEpoch++;
  });

  /** `attachmentInfo` query — current phase + attachment state snapshot. */
  setHandler(attachmentInfoQuery, (): AttachmentInfo => ({
    phase,
    ...(currentAttachment ? { currentAttachment } : {}),
    ...(preferredHost ? { preferredHost } : {}),
    inFlightCount: inFlightMessages.size,
    ...(processingSince ? { processingSince } : {}),
  }));

  /** `orphanSummary` query — daemon/CLI restore metadata when phase === 'detached'. */
  setHandler(orphanSummaryQuery, (): OrphanSummary => ({
    ensemble: input.metadata.ensemble,
    playerId: input.metadata.playerId,
    ...(detachedSince ? { detachedSince } : {}),
    ...(lastDetachReason ? { reason: lastDetachReason } : {}),
    ...(preferredHost ? { preferredHost } : {}),
    ...(lastAdapterMeta ? { lastAdapter: lastAdapterMeta } : {}),
    // #897 (A) — surface the durable spawn identity on the existing query
    // (rather than a new query) so restore/reconcile tooling sees host/pid/sessionId.
    ...(spawnRecord ? { spawnRecord } : {}),
  }));

  // ── Player Saveable State Handlers (#334 PR-1, ADR 0011) ──
  //
  // Validators run pre-handler so size/key/slot-cap rejections never commit
  // history events. Handler bodies trust their inputs and stay trivially
  // deterministic. `workflow.now()` is SDK-intercepted so `savedAt` is
  // replay-deterministic.

  const assertValidPlayerStateKey = (key: unknown): void => {
    if (typeof key !== 'string' || !PLAYER_STATE_KEY_REGEX.test(key) || key.length > PLAYER_STATE_KEY_MAX) {
      throw ApplicationFailure.nonRetryable(
        `Invalid playerState key "${key}" — must match ${PLAYER_STATE_KEY_REGEX} and be ≤ ${PLAYER_STATE_KEY_MAX} chars`,
        'PlayerStateInvalidKey',
      );
    }
  };

  setHandler(savePlayerStateUpdate, ({ key, content, savedBy }) => {
    playerState[key] = {
      content,
      savedAt: workflowNow().toISOString(),
      savedBy,
    };
    lastActivityTime = workflowNow().getTime();
    activityCount++;
    return { saved: true as const, savedAt: playerState[key].savedAt };
  }, {
    validator: ({ key, content }) => {
      assertValidPlayerStateKey(key);
      if (typeof content !== 'string') {
        throw ApplicationFailure.nonRetryable(
          'playerState content must be a string',
          'PlayerStateInvalidContent',
        );
      }
      // `TextEncoder` is replay-safe (pure string→bytes); `Buffer` is Node-only
      // and not available in the workflow sandbox.
      if (new TextEncoder().encode(content).length > PLAYER_STATE_CONTENT_MAX) {
        throw ApplicationFailure.nonRetryable(
          `playerState content exceeds ${PLAYER_STATE_CONTENT_MAX} bytes`,
          'PlayerStateContentTooLarge',
        );
      }
      if (!(key in playerState) && Object.keys(playerState).length >= PLAYER_STATE_SLOTS_MAX) {
        const existingKeys = Object.keys(playerState).sort().join(', ');
        throw ApplicationFailure.nonRetryable(
          `playerState slots full (${PLAYER_STATE_SLOTS_MAX}). Clear one before saving "${key}". Existing slots: ${existingKeys}`,
          'PlayerStateSlotsFull',
        );
      }
    },
  });

  setHandler(clearPlayerStateUpdate, ({ key }) => {
    if (!(key in playerState)) return { cleared: false };
    delete playerState[key];
    lastActivityTime = workflowNow().getTime();
    activityCount++;
    return { cleared: true };
  }, {
    validator: ({ key }) => assertValidPlayerStateKey(key),
  });

  setHandler(playerStateQuery, ({ key } = {}) => {
    const k = key ?? PLAYER_STATE_DEFAULT_KEY;
    return playerState[k] ?? null;
  });

  setHandler(playerStateKeysQuery, () => Object.keys(playerState).sort());

  // ── Conductor State ──

  const commandHistory: Command[] = input.commandHistory ?? [];
  const reportHistory: PlayerReport[] = input.reportHistory ?? [];
  const qualityGates: QualityGate[] = input.qualityGates ?? [];
  const worktrees: WorktreeEntry[] = input.worktrees ?? [];
  const stages: StageEntry[] = input.stages ?? [];

  // ── Conductor-specific Handlers ──

  if (input.metadata.isConductor) {

    setHandler(commandSignal, (cmd) => {
      commandHistory.push({
        ...cmd,
        timestamp: workflowNow().toISOString(),
      });
      // Deliver command as a message to self so the conductor's Claude session sees it
      messages.push({
        id: uuid4(),
        from: cmd.source,
        text: cmd.text,
        timestamp: workflowNow().toISOString(),
        delivered: false,
      });
      // Command processing counts as implicit outbound for blocked detection
      lastActivityTime = workflowNow().getTime();
      activityCount++;
      lastOutboundTime = workflowNow().getTime();
    });

    setHandler(playerReportSignal, (report) => {
      // #910 — at-least-once dedup: drop a redelivered report (same outbox entry
      // id) before any side effect (reportHistory, the self-message, stage
      // transitions below). Un-threaded callers are never deduped.
      if (!recordDelivery(report.deliveryId)) return;
      reportHistory.push({
        ...report,
        timestamp: workflowNow().toISOString(),
      });
      // Deliver report as a message to self
      messages.push({
        id: uuid4(),
        from: report.playerId,
        text: `[${report.type}] ${report.text}`,
        timestamp: workflowNow().toISOString(),
        delivered: false,
      });

      // ── Stage tracking: update player status in any active stage ──
      //
      // NOTE (#777): the transition + message logic below is FAITHFULLY
      // COPIED at the setStage handler's reconcile block — keep the two in
      // sync when editing either. Extraction is deferred to 2.0's P2, where
      // v0.27's marker deletion merges the sites for free (see #782).
      for (const stage of stages) {
        if (stage.status !== 'active') continue;

        const playerEntry = stage.players.find((p) => p.playerId === report.playerId);
        if (!playerEntry || playerEntry.status !== 'waiting') continue;

        const now = workflowNow().toISOString();

        if (report.type === 'result') {
          playerEntry.status = 'reported';
          playerEntry.reportType = 'result';
          playerEntry.reportText = report.text;
          playerEntry.reportedAt = now;
        } else if (report.type === 'blocker') {
          playerEntry.status = 'blocked';
          playerEntry.reportType = 'blocker';
          playerEntry.reportText = report.text;
          playerEntry.reportedAt = now;

          // Halt policy: fail stage immediately on any blocker
          if (stage.failurePolicy === 'halt') {
            stage.status = 'failed';
            stage.completedAt = now;
            messages.push({
              id: uuid4(),
              from: '_stage',
              text: `[stage failed] "${stage.name}" halted — ${report.playerId} reported blocker: ${report.text}`,
              timestamp: now,
              delivered: false,
            });
            continue; // Don't check completion for a failed stage
          }
        } else {
          // 'question' or 'update' — no stage effect, player is still working
          continue;
        }

        // Check if all players in the stage are done (reported or blocked)
        const allDone = stage.players.every((p) => p.status !== 'waiting');
        if (allDone) {
          const blocked = stage.players.filter((p) => p.status === 'blocked');
          if (blocked.length > 0) {
            // Some players blocked (continue policy — didn't halt above)
            stage.status = 'failed';
            stage.completedAt = now;
            const blockerNames = blocked.map((p) => p.playerId).join(', ');
            messages.push({
              id: uuid4(),
              from: '_stage',
              text: `[stage failed] "${stage.name}" completed with ${blocked.length} blocker(s): ${blockerNames}`,
              timestamp: now,
              delivered: false,
            });
          } else {
            // All players reported successfully
            stage.status = 'complete';
            stage.completedAt = now;
            messages.push({
              id: uuid4(),
              from: '_stage',
              text: `[stage complete] "${stage.name}" — all ${stage.players.length} players reported successfully.`,
              timestamp: now,
              delivered: false,
            });
          }
        }
      }
    });

    setHandler(historyQuery, (): HistoryEntry[] => {
      const entries: HistoryEntry[] = [
        ...commandHistory.map((c): HistoryEntry => ({
          type: 'command',
          timestamp: c.timestamp,
          data: c,
        })),
        ...reportHistory.map((r): HistoryEntry => ({
          type: 'report',
          timestamp: r.timestamp,
          data: r,
        })),
      ];
      return entries.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    });

    // ── Quality Gate Handlers ──

    /** Derive aggregate gate status from individual criteria. */
    function deriveGateStatus(gate: QualityGate): 'open' | 'passed' | 'failed' {
      if (gate.criteria.length === 0) return 'open';
      if (gate.criteria.some((c) => c.status === 'failed')) return 'failed';
      if (gate.criteria.every((c) => c.status === 'passed')) return 'passed';
      return 'open';
    }

    // REGISTRATION-ORDER FENCE (#797 / #782 S3 — the highest-value fence):
    // setQualityGateSignal MUST register BEFORE evaluateGateCriteriaSignal.
    // Buffered signals drain in registration order on a fresh/CAN'd run's
    // first workflow task; consumer-first would silently drop evaluations
    // against an empty `qualityGates` ('if (!gate) return') — a #777 repeat.
    // Pinned by tests/conformance/registration-order-fence.test.ts.
    setHandler(setQualityGateSignal, ({ task, criteria, createdBy }) => {
      const existing = qualityGates.findIndex((g) => g.task === task);
      const gate: QualityGate = {
        task,
        criteria: criteria.map((text) => ({ text, status: 'pending' as const })),
        createdBy,
        createdAt: workflowNow().toISOString(),
        status: 'open',
      };
      if (existing >= 0) {
        qualityGates[existing] = gate;
      } else {
        qualityGates.push(gate);
      }
    });

    // REGISTRATION-ORDER FENCE (#797 / #782 S3): consumer half — must stay
    // registered AFTER setQualityGateSignal (see the producer's fence above).
    setHandler(evaluateGateCriteriaSignal, ({ task, evaluations, evaluatedBy }) => {
      const gate = qualityGates.find((g) => g.task === task);
      if (!gate) return;
      const now = workflowNow().toISOString();
      for (const ev of evaluations) {
        if (ev.index >= 0 && ev.index < gate.criteria.length) {
          gate.criteria[ev.index].status = ev.status;
          gate.criteria[ev.index].evaluatedBy = evaluatedBy;
          gate.criteria[ev.index].evaluatedAt = now;
          if (ev.notes) gate.criteria[ev.index].notes = ev.notes;
        }
      }
      gate.status = deriveGateStatus(gate);
    });

    setHandler(qualityGatesQuery, () => qualityGates);

    // ── Worktree Handlers ──

    // REGISTRATION-ORDER FENCE (#797 / #782 S4): setWorktreeSignal MUST
    // register BEFORE removeWorktreeSignal — inverted buffered drain would
    // no-op the removal and resurrect the entry. Pinned by
    // tests/conformance/registration-order-fence.test.ts.
    setHandler(setWorktreeSignal, (entry: WorktreeEntry) => {
      const existing = worktrees.findIndex((w) => w.player === entry.player);
      if (existing >= 0) {
        worktrees[existing] = entry;
      } else {
        worktrees.push(entry);
      }
    });

    // REGISTRATION-ORDER FENCE (#797 / #782 S4): consumer half — must stay
    // registered AFTER setWorktreeSignal.
    setHandler(removeWorktreeSignal, (playerName: string) => {
      const idx = worktrees.findIndex((w) => w.player === playerName);
      if (idx >= 0) {
        worktrees.splice(idx, 1);
      }
    });

    setHandler(worktreesQuery, () => worktrees);

    // ── Stage Handlers ──

    // #777 — staleness bound for stage-creation reconciliation (below).
    // Architect-ruled: 5 minutes covers the real ms-to-seconds races with
    // margin while blocking hours-old unrelated reports from falsely
    // completing/failing a fresh stage. Input override is a TEST KNOB only.
    const STAGE_RECONCILE_WINDOW_MS = input.stageReconcileWindowMs ?? 5 * 60_000;

    // REGISTRATION-ORDER FENCE (#797 / #782 S2): setStageSignal MUST register
    // BEFORE cancelStageSignal — inverted buffered drain would no-op the
    // cancel and land the stage `active` (lost cancellation). (The
    // playerReportSignal consumer above is the KNOWN exception: it registers
    // first and is protected by the #777 reconciliation instead.) Pinned by
    // tests/conformance/registration-order-fence.test.ts.
    setHandler(setStageSignal, ({ name, players, failurePolicy, createdBy }) => {
      const entry: StageEntry = {
        name,
        players: players.map((playerId) => ({
          playerId,
          status: 'waiting' as const,
        })),
        status: 'active',
        failurePolicy: failurePolicy || 'halt',
        createdAt: workflowNow().toISOString(),
        createdBy,
      };

      // ── #777 — commutative reconciliation against pre-stage reports ──
      //
      // Cross-dependent signal handlers must be commutative under buffered
      // delivery: the TS SDK drains pre-registration signal buffers in
      // HANDLER-REGISTRATION order, not arrival order — this handler
      // registers AFTER playerReportSignal's, so a report buffered alongside
      // this setStage is consumed FIRST, against an empty `stages`, and the
      // transition would be silently lost (the #777 wedge; proven by the
      // captured history in test/fixtures/777-wedge-history.txt). The same
      // loss occurs with zero buffering when a report simply ARRIVES just
      // before setStage in a running workflow. Fix: at creation, count each
      // player's most recent stage-relevant report.
      //
      // Semantics (architect-ruled, MOST-RECENT-WINS — deliberate divergence
      // from the live handler's first-report-wins): live handling is an
      // INTERRUPT semantic for an existing stage (a blocker halts in-flight
      // fan-out the moment it happens); reconciliation is a STATE-SUMMARY
      // semantic for a stage created after the fact — nothing is in flight
      // to interrupt, and the player's latest report IS their current
      // standing. Replaying a superseded [blocker→result] as a fresh halt
      // would act on stale information about a player who already
      // recovered; [result→blocker] symmetrically reconciles to 'blocked'
      // (halt at creation) — latest-state-wins is consistent in both
      // directions. question/update reports are stage-inert, mirroring the
      // live handler. Reconciled entries keep the ORIGINAL receipt time as
      // `reportedAt` and carry `reconciled: true`.
      //
      // Stage reconciliation — fold each player's latest result/blocker report
      // into stage status, then apply the stage's completion/failure transitions.
      // (2.0: was patched()-gated for 1.x replay determinism; now unconditional — #787.)
      {
        const nowMs = workflowNow().getTime();
        for (const playerEntry of entry.players) {
          // Most recent stage-relevant (result|blocker) report from this
          // player; question/update are inert and skipped, not blocking.
          for (let i = reportHistory.length - 1; i >= 0; i--) {
            const r = reportHistory[i];
            if (r.playerId !== playerEntry.playerId) continue;
            if (r.type !== 'result' && r.type !== 'blocker') continue;
            const ageMs = nowMs - new Date(r.timestamp).getTime();
            if (ageMs > STAGE_RECONCILE_WINDOW_MS) break; // stale — most recent is too old
            playerEntry.status = r.type === 'result' ? 'reported' : 'blocked';
            playerEntry.reportType = r.type;
            playerEntry.reportText = r.text;
            playerEntry.reportedAt = r.timestamp; // ORIGINAL receipt time
            playerEntry.reconciled = true;
            break; // only the most recent counts
          }
        }

        // Apply the same transitions the live handler would have produced
        // (deliberate faithful copy — the live handler stays untouched to
        // keep this change's replay surface minimal).
        const reconciledBlockers = entry.players.filter((p) => p.reconciled && p.status === 'blocked');
        const now = workflowNow().toISOString();
        if (entry.failurePolicy === 'halt' && reconciledBlockers.length > 0) {
          entry.status = 'failed';
          entry.completedAt = now;
          messages.push({
            id: uuid4(),
            from: '_stage',
            text: `[stage failed] "${entry.name}" halted — ${reconciledBlockers[0].playerId} reported blocker: ${reconciledBlockers[0].reportText ?? ''}`,
            timestamp: now,
            delivered: false,
          });
        } else if (entry.players.every((p) => p.status !== 'waiting')) {
          const blocked = entry.players.filter((p) => p.status === 'blocked');
          if (blocked.length > 0) {
            entry.status = 'failed';
            entry.completedAt = now;
            const blockerNames = blocked.map((p) => p.playerId).join(', ');
            messages.push({
              id: uuid4(),
              from: '_stage',
              text: `[stage failed] "${entry.name}" completed with ${blocked.length} blocker(s): ${blockerNames}`,
              timestamp: now,
              delivered: false,
            });
          } else {
            entry.status = 'complete';
            entry.completedAt = now;
            messages.push({
              id: uuid4(),
              from: '_stage',
              text: `[stage complete] "${entry.name}" — all ${entry.players.length} players reported successfully.`,
              timestamp: now,
              delivered: false,
            });
          }
        }
      }

      const existing = stages.findIndex((s) => s.name === name);
      if (existing >= 0) {
        stages[existing] = entry;
      } else {
        stages.push(entry);
      }
    });

    // REGISTRATION-ORDER FENCE (#797 / #782 S2): consumer half — must stay
    // registered AFTER setStageSignal.
    setHandler(cancelStageSignal, (name: string) => {
      const stage = stages.find((s) => s.name === name);
      if (stage && stage.status === 'active') {
        stage.status = 'cancelled';
        stage.completedAt = workflowNow().toISOString();
        // Notify conductor
        messages.push({
          id: uuid4(),
          from: '_stage',
          text: `[stage cancelled] "${name}" was cancelled.`,
          timestamp: workflowNow().toISOString(),
          delivered: false,
        });
      }
    });

    setHandler(stagesQuery, () => stages);
  }

  // ── Main Loop ──
  //
  // v0.25 design §9.5: the loop is a deadline-race. On each iteration we wait for
  //   - an outbox dispatch opportunity, OR
  //   - a phase transition condition wake, OR
  //   - the nearest time-based deadline (lease expiry, processingDeadline, drainingDeadline).
  // On wake, we handle time-based deadlines first (§9.5.a–c), then dispatch outbox entries,
  // then run the legacy stale/blocked heuristics (shim until PR-C), then check continueAsNew.
  //
  // The only exit from this loop is `destroyRequested === true` — the workflow never
  // COMPLETEs implicitly per design §2.2 invariant 2. `destroyRequested` is set
  // exclusively by the `destroyUpdate` handler (PR-H removed the
  // `updateMetadata({ status: 'terminated' })` compat shim that previously also
  // routed onto this flag).

  const hasPendingOutbox = () => outbox.some((e) => e.status === 'pending');
  /** Stop entries bypass pause — they must always be dispatched. */
  const hasPendingStop = () => outbox.some((e) => e.status === 'pending' && e.type === 'stop');
  const canDispatch = () => !outboxLocked && !paused && hasPendingOutbox();

  while (!destroyRequested) {
    // Deadline race: wake on outbox, phase change, destroy, or the nearest time deadline.
    //
    // #159 Gap 1b: `wakeEpoch` is captured here and included in the predicate so any handler
    // that mutates the deadline landscape (e.g. `requestDetach` setting a draining window)
    // can force re-entry to this loop *before* the pre-scheduled timeout fires. Without
    // this, a detach signal landing while the loop is asleep on a far-away lease-expiry
    // timer would leave the workflow in `draining` until that old timer fired.
    const epochAtWait = wakeEpoch;
    const deadlineMs = nextDeadlineMs();
    // #704 Item 2 — wake discipline. Every handler that mutates a `nextDeadlineMs()`
    // input now bumps `wakeEpoch` (claim renew+fresh, processingStart/End, the
    // draining/detach paths, destroy), so in steady state the loop wakes on exactly
    // `nextDeadlineMs()`. `BACKSTOP_MS` is defense-in-depth for a FUTURE handler that
    // mutates wake-relevant state but forgets the bump: the loop still re-evaluates
    // at least every 30 min instead of sleeping forever. We deliberately keep the
    // backstop even when `deadlineMs === Infinity` (idle booting-disarmed / detached)
    // — a silent indefinite sleep is the exact failure class #704 exists to kill, so
    // there is NO `Infinity → no-timer` branch. A backstop wake that finds actionable
    // state emits a loud WARN below so a missed bump is detectable, not masked.
    // Canary: `test/session-phase-processing.test.ts` ("attached → processing →
    // awaiting via processingStart/End") fails if a deadline-mutating handler drops
    // its bump.
    const wokeByPredicate = await condition(
      () =>
        destroyRequested ||
        canDispatch() ||
        hasPendingStop() ||
        phase === 'gone' ||
        wakeEpoch !== epochAtWait,
      Math.min(deadlineMs, BACKSTOP_MS),
    );

    // #704 Item 2 — missed-bump breadcrumb. If we woke on the backstop cap (NOT the
    // predicate) yet a deadline is already overdue or the predicate is now actionable,
    // a handler likely mutated wake-relevant state without bumping `wakeEpoch`.
    // Surface it loudly instead of letting the backstop silently mask the regression.
    if (!wokeByPredicate) {
      const overdue = nextDeadlineMs() <= 0;
      const actionable =
        destroyRequested || canDispatch() || hasPendingStop() || phase === 'gone';
      if (overdue || actionable) {
        workflowLog.warn(
          `main-loop woke via fallback backstop with actionable state — possible missed ` +
          `wakeEpoch bump (phase=${phase}, overdue=${overdue}, actionable=${actionable})`,
        );
      }
    }

    if (destroyRequested) break;

    // ── §9.5.a: Lease expiry — reap attachment and transition to `detached`. ──
    if (currentAttachment && new Date(currentAttachment.expiresAt).getTime() <= workflowNow().getTime()) {
      const reaped = currentAttachment;
      lastAdapterMeta = { hostname: reaped.hostname, adapterId: reaped.adapterId };
      lastDetachReason = 'heartbeat-timeout';
      currentAttachment = null;
      inFlightMessages.clear();
      processingSince = null;
      drainingSince = null;
      drainingDeadlineMs = null;
      detachedSince = workflowNow().toISOString();
      setPhase('detached');
      upsertSearchAttributes({
        AgentTempoAttachedHost: [''],
      });
      workflowLog.warn(`lease expired for attachment ${reaped.attachmentId} (host=${reaped.hostname})`);
    }

    // ── §9.5.a2: booting attach-timeout (#704). ──
    // A fresh, armed session that never reached `claimAttachment` within
    // `BOOTING_DEADLINE_MS` is a failed recruit (adapter never launched / wedged /
    // crashed pre-attach). Fail it LOUDLY: sweep any orphan process, notify the
    // recruiter, stamp the close-reason tombstone MEMO, and COMPLETE terminal
    // `gone`. `bootingSince !== null` ⟹ the watchdog is armed (headless adapter on
    // a fresh, non-handoff boot). The bootstrap orphan-guard backstops the case
    // where the swept process (or a never-swept one) re-launches later.
    if (
      phase === 'booting' &&
      bootingSince !== null &&
      workflowNow().getTime() - new Date(bootingSince).getTime() >= BOOTING_DEADLINE_MS
    ) {
      lastDetachReason = 'boot-timeout';
      workflowLog.warn(
        `boot-timeout: session never attached within ${Math.round(BOOTING_DEADLINE_MS / 1000)}s — failing recruit`,
      );
      // Best-effort orphan sweep. At the deadline the spawned process usually
      // EXISTS (still booting), so this command-line kill is MORE likely to land
      // than the destroy-time sweep. No-op if nothing launched.
      const killHost = preferredHost ?? input.metadata.hostname;
      if (killHost) {
        try {
          const killResult = await getHardTerminateProxyForDestroy(killHost)({
            ensemble: input.metadata.ensemble,
            playerName: input.metadata.playerId,
            agent: (input.metadata.agentType ?? 'claude') as AgentType,
            workDir: input.metadata.workDir,
          });
          workflowLog.info(
            `boot-timeout hard-terminate on ${killHost}: strategy=${killResult.strategy}, ` +
            `killedPids=[${killResult.killedPids.join(',')}]`,
          );
        } catch (err) {
          workflowLog.warn(
            `boot-timeout hard-terminate failed on ${killHost} (best-effort): ` +
            `${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      // Notify the recruiter (if any) — reuses the outbox `deliverCue` activity.
      const recruiter = input.metadata.recruitedBy;
      if (recruiter) {
        try {
          await deliverCue({
            ensemble: input.metadata.ensemble,
            fromPlayerId: input.metadata.playerId,
            targetPlayerId: recruiter,
            message:
              `Recruit of "${input.metadata.playerId}" never attached within ` +
              `${Math.round(BOOTING_DEADLINE_MS / 1000)}s — failed; the spawned process (if any) was swept.`,
          });
        } catch (err) {
          workflowLog.warn(
            `boot-timeout recruiter-notify failed (best-effort): ` +
            `${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      // Tombstone MEMO (shared with the orphan-guard) + terminal `gone`.
      // #897 (B2) — co-stamp the sessionId for exact-identity orphan matching.
      upsertMemo({
        [MEMO_KEYS.closeReason]: 'boot-timeout',
        ...(closeMemoSessionId() ? { [MEMO_KEYS.sessionId]: closeMemoSessionId() } : {}),
      });
      lastAdapterMeta = lastAdapterMeta ?? {
        hostname: killHost ?? input.metadata.hostname,
        adapterId: '',
      };
      bootingSince = null;
      setPhase('gone');
      upsertSearchAttributes({ AgentTempoAttachedHost: [''] });
      // Route through the terminal exit path (mirrors `destroy`): isDestroyed
      // queries read true, then the loop breaks to COMPLETE.
      destroyRequested = true;
      break;
    }

    // ── §9.5.b: processingDeadline — force exit from `processing` if a messageId is wedged. ──
    if (
      processingSince !== null &&
      workflowNow().getTime() - new Date(processingSince).getTime() > PROCESSING_DEADLINE_MS
    ) {
      const abandoned = [...inFlightMessages];
      workflowLog.warn(
        `processingDeadline exceeded (${Math.round(PROCESSING_DEADLINE_MS / 1000)}s); ` +
        `ejecting ${abandoned.length} in-flight message(s): ${abandoned.join(', ')}`,
      );
      inFlightMessages.clear();
      processingSince = null;
      if (phase === 'processing') setPhase('attached');
    }

    // ── §9.5.c: drainingDeadline — force exit from `draining` to `detached`. ──
    // #159 Gap 1a: use the caller-supplied `drainingDeadlineMs` when present; fall back to
    // `DEFAULT_DRAINING_DEADLINE_MS` otherwise. `nextDeadlineMs()` uses the same value, so
    // the condition wake timing and the reap threshold stay in sync.
    //
    // #809: this reap is now UNCONDITIONAL on `drainingSince`. Draining must ALWAYS
    // escape, regardless of how it was entered. Before #809 both this block AND the
    // `nextDeadlineMs()` candidate were gated on `drainingSince !== null`, so a `draining`
    // phase that ever lacked the stamp (or carried a pathologically large
    // `drainingDeadlineMs`) had the same unbounded "Infinity deadline" wedge as booting
    // (#704) — silent, indefinite, no operator-visible escape. Now: a `drainingSince ===
    // null` wedge is force-reaped on the next pass; otherwise we wait out the per-detach
    // window CAPPED at the `DRAINING_DEADLINE_MS` ceiling. Either way the session lands in
    // the recoverable terminal `detached` (restartable/restorable — NOT the destructive
    // `gone`), with a loud `from: 'system'` watchdog notice so the wedge isn't silent.
    //
    // #159 Gap 2: before flipping to `detached`, kill the OS child process on the host
    // where the adapter was running. If we skipped this step the workflow would happily
    // report `phase=detached` while an orphaned `claude.exe` kept holding the session
    // lock — and the next `recruit`/`restart` would collide with its own past self.
    // Best-effort: errors from the activity are logged but don't block the state flip
    // (the alternative is a workflow wedged in `draining` forever when the host worker
    // is down, which is worse than a lingering process that operators can clean up).
    if (phase === 'draining') {
      const window = Math.min(
        drainingDeadlineMs ?? DEFAULT_DRAINING_DEADLINE_MS,
        DRAINING_DEADLINE_MS,
      );
      // `drainingSince === null` is the wedge shape (entered `draining` with no stamp, or
      // a determinism-restore edge) → reap immediately; otherwise wait out the capped
      // window. `elapsedMs === null` flags the wedge for the watchdog notice below.
      const elapsedMs = drainingSince
        ? workflowNow().getTime() - new Date(drainingSince).getTime()
        : null;
      if (elapsedMs === null || elapsedMs > window) {
        const reaped = currentAttachment;
        if (reaped) {
          // Same routing consideration as in `forceDetachUpdate`: use `metadata.hostname`
          // as the stable key. Best-effort only — a failure here (e.g. host worker down)
          // would otherwise wedge the workflow in `draining` forever, which is worse than
          // a lingering OS process that operators can clean up by hand.
          const killHost = input.metadata.hostname;
          try {
            const killResult = await getHardTerminateProxy(killHost)({
              ensemble: input.metadata.ensemble,
              playerName: input.metadata.playerId,
              agent: (input.metadata.agentType ?? 'claude') as AgentType,
              workDir: input.metadata.workDir,
            });
            workflowLog.info(
              `drainingDeadline hard-terminate on ${killHost}: strategy=${killResult.strategy}, ` +
              `killedPids=[${killResult.killedPids.join(',')}]`,
            );
          } catch (err) {
            workflowLog.warn(
              `drainingDeadline hard-terminate failed for ${killHost} ` +
              `(continuing with state flip): ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
        lastDetachReason = lastDetachReason ?? 'force';
        currentAttachment = null;
        inFlightMessages.clear();
        processingSince = null;
        drainingSince = null;
        drainingDeadlineMs = null;
        detachedSince = workflowNow().toISOString();
        setPhase('detached');
        upsertSearchAttributes({
          AgentTempoAttachedHost: [''],
        });
        // #809 — loud, non-silent escape. Fires EXACTLY ONCE: the `setPhase('detached')`
        // above flips the phase in this same loop iteration, before any `continueAsNew`,
        // so the `phase === 'draining'` guard can't re-enter and re-inject the notice on a
        // later pass (or after a CAN mid-wedge). Surfaced to the next adapter on
        // attach/restore as a normal inbound message.
        const detail = elapsedMs === null
          ? `was wedged in 'draining' with no firing deadline`
          : `did not finish draining within ${Math.round(window / 1000)}s`;
        messages.push({
          id: uuid4(),
          from: 'system',
          text:
            `🛑 Attachment watchdog (#809): this session ${detail} and was force-detached. ` +
            `The previous adapter (if any) was swept; the session is now 'detached' and can be ` +
            `restarted or restored.`,
          timestamp: workflowNow().toISOString(),
          delivered: false,
        });
        workflowLog.warn(
          `drainingDeadline reap (#809): session ${detail}` +
          (reaped ? `; reaping attachment ${reaped.attachmentId}` : '; no attachment held'),
        );
      }
    }


    // ── Outbox Dispatch ──
    while (hasPendingOutbox() && !destroyRequested) {
      // When paused or locked, only dispatch stop entries (bypass)
      const nextEntry = (canDispatch())
        ? outbox.find((e) => e.status === 'pending')!
        : outbox.find((e) => e.status === 'pending' && e.type === 'stop') ?? null;
      if (!nextEntry) break;
      const entry = nextEntry;
      entry.status = 'processing';
      try {
        switch (entry.type) {
          case 'cue':
            await deliverCue({
              ensemble: input.metadata.ensemble,
              fromPlayerId: input.metadata.playerId,
              targetPlayerId: entry.targetPlayerId,
              message: entry.message,
              // #357: thread broadcast id so the target's `receiveMessage`
              // signal carries it onto the stored Message.
              ...(entry.broadcastId !== undefined ? { broadcastId: entry.broadcastId } : {}),
              // #318: thread coat-check ticket so the target can pull the
              // full content body via `coat_check_get`.
              ...(entry.attachmentTicket !== undefined ? { attachmentTicket: entry.attachmentTicket } : {}),
              // #910: the outbox entry id is the at-least-once dedup key — the
              // target drops a redelivery (CAN-redrive / activity retry).
              deliveryId: entry.id,
            });
            break;
          case 'report':
            await deliverReport({
              ensemble: input.metadata.ensemble,
              fromPlayerId: input.metadata.playerId,
              text: entry.text,
              reportType: entry.reportType,
              // #910: dedup key for at-least-once delivery to the conductor.
              deliveryId: entry.id,
            });
            break;
          case 'stop':
            await terminateSession({
              ensemble: input.metadata.ensemble,
              targetPlayerId: entry.targetPlayerId,
              terminatedBy: input.metadata.playerId,
            });
            break;
          case 'recruit': {
            const tc = input.temporalConfig;
            const recruitResult = await startRecruitedSession({
              ensemble: input.metadata.ensemble,
              targetName: entry.targetName,
              workDir: entry.workDir,
              isConductor: entry.isConductor,
              initialMessage: entry.initialMessage,
              fromPlayerId: input.metadata.playerId,
              agent: entry.agent,
              systemPrompt: entry.systemPrompt,
              taskQueue: tc?.taskQueue || 'agent-tempo',
              agentDefinition: entry.agentDefinition,
              agentDefinitionDescription: entry.agentDefinitionDescription,
              allowedTools: entry.allowedTools,
              claudeBin: entry.claudeBin,
              held: entry.held,
              // #131 Phase C — claude-api model id; activity persists it onto
              // SessionMetadata.model so restart/encore/migrate can recover it.
              ...(entry.model !== undefined ? { model: entry.model } : {}),
            });
            // Warm hold: process always spawns. When held, the workflow's outbox
            // is locked and the initial message is deferred until release.
            const targetHost = entry.targetHostname || input.metadata.hostname;
            const spawnFn = getSpawnProxy(targetHost);
            const recruitSpawnResult = await spawnFn({
              targetName: entry.targetName,
              workDir: entry.workDir,
              isConductor: entry.isConductor,
              agent: entry.agent,
              systemPrompt: entry.systemPrompt,
              ensemble: input.metadata.ensemble,
              temporalAddress: tc?.temporalAddress || 'localhost:7233',
              temporalNamespace: tc?.temporalNamespace || 'default',
              agentDefinition: entry.agentDefinition,
              agentDefinitionPath: entry.agentDefinitionPath,
              nativeResolvable: entry.nativeResolvable,
              sessionId: recruitResult.sessionId,
              allowedTools: entry.allowedTools,
              claudeBin: entry.claudeBin,
              mockMode: entry.mockMode,
              mockScenario: entry.mockScenario,
              // #131 Phase C — forward to spawnProcess so spawnClaudeApiAdapter
              // can plumb it into the subprocess env (AGENT_TEMPO_API_MODEL).
              ...(entry.model !== undefined ? { model: entry.model } : {}),
            });
            // #897 (A) — record the fresh-recruit spawn identity from the RESULT.
            recordSpawn(recruitSpawnResult, targetHost, recruitResult.sessionId);
            break;
          }
          case 'release': {
            // Warm hold release — signal the target to unlock outbox and deliver held message.
            // No spawning needed — the process is already running.
            await releasePlayer({
              ensemble: input.metadata.ensemble,
              targetPlayerId: entry.targetPlayerId,
            });
            break;
          }
          case 'detach': {
            // PR-D: route the `detach` verb through the outbox (QA B1). The
            // activity resolves the target and signals `requestDetachSignal`.
            await deliverDetach({
              ensemble: input.metadata.ensemble,
              targetPlayerId: entry.targetPlayerId,
              ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
              ...(entry.deadlineMs !== undefined ? { deadlineMs: entry.deadlineMs } : {}),
            });
            break;
          }
          case 'destroy': {
            // PR-D: route the `destroy` verb through the outbox (QA B2).
            await deliverDestroy({
              ensemble: input.metadata.ensemble,
              targetPlayerId: entry.targetPlayerId,
              terminatedBy: input.metadata.playerId,
              ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
              ...(entry.notifyConductor !== undefined ? { notifyConductor: entry.notifyConductor } : {}),
            });
            break;
          }
          case 'restart': {
            // PR-D: route the `restart`/`migrate` verbs through the outbox
            // (QA B3). The activity owns the §8.2 algorithm: graceful detach
            // → optional force → claim → context replay → enqueueSpawn.
            // #334 PR-2: forward `loadFromState` + `transcript` so the
            // activity can seed the restarted session from a saved-state slot.
            await deliverRestart({
              ensemble: input.metadata.ensemble,
              targetPlayerId: entry.targetPlayerId,
              invokerPlayerId: entry.invokerPlayerId ?? input.metadata.playerId,
              ...(entry.force !== undefined ? { force: entry.force } : {}),
              ...(entry.host !== undefined ? { host: entry.host } : {}),
              ...(entry.fresh !== undefined ? { fresh: entry.fresh } : {}),
              ...(entry.contextMessages !== undefined ? { contextMessages: entry.contextMessages } : {}),
              ...(entry.loadFromState !== undefined ? { loadFromState: entry.loadFromState } : {}),
              ...(entry.transcript !== undefined ? { transcript: entry.transcript } : {}),
            });
            break;
          }
          case 'reset': {
            // D14: operator/conductor CLEAN-WIPE. Sets a pendingReset flag the
            // Pi extension polls + acts on (newSession). POLL-delivery, not a
            // direct subprocess signal. resetId = this outbox entry id (the
            // extension acks with it). Does NOT route through the MD-G gate.
            await deliverReset({
              ensemble: input.metadata.ensemble,
              targetPlayerId: entry.targetPlayerId,
              resetId: entry.id,
              fresh: entry.fresh ?? true,
              ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
              requestedBy: entry.invokerPlayerId ?? input.metadata.playerId,
            });
            break;
          }
          case 'spawn': {
            // PR-D: forward the pre-claimed attachment token + pinned runId +
            // resolved adapterId to the spawn activity. The child process picks
            // these up from env in `BaseAttachment.startV2Lifecycle(workflowId,
            // expectedAttachmentId)` and renews the lease rather than claiming
            // fresh. Design §8.2 step 5.
            const spawnTc = input.temporalConfig;
            const spawnHost = entry.targetHostname;
            const spawnFn = getSpawnProxy(spawnHost);
            const spawnResult = await spawnFn({
              targetName: entry.targetName,
              workDir: entry.workDir,
              isConductor: entry.isConductor,
              agent: entry.agent,
              ensemble: input.metadata.ensemble,
              temporalAddress: spawnTc?.temporalAddress || 'localhost:7233',
              temporalNamespace: spawnTc?.temporalNamespace || 'default',
              sessionId: entry.sessionId,
              resume: entry.resumeAttachment,
              attachmentId: entry.attachmentId,
              attachmentRunId: entry.attachmentRunId,
              adapterId: entry.adapterId,
              agentDefinition: entry.agentDefinition,
              agentDefinitionPath: entry.agentDefinitionPath,
              nativeResolvable: entry.nativeResolvable,
              // #131 Phase C — claude-api model carried across restart via the
              // spawn outbox entry (sourced from durable SessionMetadata.model
              // by deliverRestart).
              ...(entry.model !== undefined ? { model: entry.model } : {}),
            });
            // #897 (A) — record spawn identity from the activity RESULT (real
            // wall-clock + helper pid), not a workflow-side clock. `spawnedAt`
            // is absent on the FIX-3 duplicate-skip path → no record update.
            recordSpawn(spawnResult, spawnHost, entry.sessionId);
            break;
          }
        }
        entry.status = 'delivered';
        entry.deliveredAt = workflowNow().toISOString();
      } catch (err) {
        entry.status = 'failed';
        entry.error = String(err);

        // PR-D §8.4: spawn-entry failure rollback. When `restart` or `migrate`
        // creates an attachment + enqueues a spawn, a subsequent spawn
        // activity failure leaves the session `attached` with no adapter — the
        // worst steady state. Force-detach the just-created attachment so the
        // session lands in `detached` and `restart` can be retried. Guard with
        // `expectedAttachmentId` (TOCTOU: another claim may have superseded).
        if (
          entry.type === 'spawn' &&
          entry.attachmentId &&
          currentAttachment?.attachmentId === entry.attachmentId
        ) {
          lastAdapterMeta = {
            hostname: currentAttachment.hostname,
            adapterId: currentAttachment.adapterId,
          };
          lastDetachReason = 'spawn-failed';
          // #704 Item 2 — no `wakeEpoch++` needed here despite clearing
          // `nextDeadlineMs()` inputs (currentAttachment/processingSince/draining):
          // this rollback runs INLINE in the main-loop body (outbox dispatch), not
          // in a signal/update handler, so the very next loop iteration recomputes
          // `nextDeadlineMs()` before the next `condition()` wait. (The bump
          // discipline is for HANDLERS that mutate these while the loop is parked.)
          currentAttachment = null;
          inFlightMessages.clear();
          processingSince = null;
          drainingSince = null;
          drainingDeadlineMs = null;
          detachedSince = workflowNow().toISOString();
          setPhase('detached');
          upsertSearchAttributes({
            AgentTempoAttachedHost: [''],
          });
          workflowLog.warn(
            `spawn failed for "${entry.targetName}"; rolled back attachment ${entry.attachmentId} → detached`,
          );
        }
      }
    }

    // ── §2.2 phase refinement: attached → awaiting when idle ──
    // Issue #117: after outbox drain completes, if the attachment is still held,
    // no messages are in flight, and no outbox entries are pending/processing,
    // the session is in its idle steady state. Transition to `awaiting` so
    // external observers (AgentTempoAttachmentState search attribute, TUI,
    // monitoring) see the correct phase. `processingStart` (line 502) already
    // guards for `awaiting`, so the next inbound message lifts us to `processing`.
    if (phase === 'attached' && inFlightMessages.size === 0) {
      const outboxIdle = !outbox.some(
        (e) => e.status === 'pending' || e.status === 'processing',
      );
      if (outboxIdle) setPhase('awaiting');
    }

    // Legacy stale/blocked detection + `_heartbeat`/`_ping` probe removed in #175.
    // The phase machine (lease expiry, `processingDeadline`, `adapterExited`) is now
    // the single source of liveness truth; see §§9.5.a/b above.

    // Prevent unbounded history growth — let the SDK decide when. The
    // `forceContinueAsNew` flag (#226 test-only) piggybacks on this branch so
    // the test fixture exercises the exact production CAN path, including the
    // §2.3 lease extension below.
    const info = workflowInfo();
    if (info.continueAsNewSuggested || forceContinueAsNew) {
      forceContinueAsNew = false;
      await condition(allHandlersFinished);

      // ── CAN-boundary lease extension (design §2.3) ──
      // The CAN transition is not instantaneous. If we write the old expiresAt into the
      // new execution and the transition takes ~100–500ms, the new execution's first main
      // loop check could reap a healthy attachment as expired. Extend the lease so a
      // normally-beating adapter has room to land its next heartbeat.
      //
      // #249 Bug 3: pre-fix this used a hardcoded 30s constant, but the claude-code
      // adapter's `heartbeatMs` is 60s → CAN would grant 30s of runway when the adapter
      // needed 60s minimum, so the first post-CAN main-loop tick reaped the healthy
      // attachment before its next heartbeat could land. Post-fix we use
      // `currentAttachment.leaseMs` (= 3 × heartbeatMs, negotiated at claim time) which
      // matches what the adapter signed up for and covers at least one full heartbeat
      // interval for every adapter class.
      //
      // Math lives in `./attachment-math.ts` for direct unit testability (#127).
      // (2.0: the v0.26-can-lease-from-attachment patched() gate is gone — #787 —
      // so CAN always extends by `currentAttachment.leaseMs` = 3 × heartbeatMs.)
      const extendedAttachment = currentAttachment
        ? extendAttachmentForCAN(
            currentAttachment,
            currentAttachment.leaseMs,
            workflowNow().getTime(),
          )
        : undefined;

      await continueAsNew<typeof agentSessionWorkflow>({
        ...input,
        part,
        messages: messages.filter((m) => !m.delivered),
        sentMessages: sentMessages.slice(-50),
        outbox: outbox.filter((e) => e.status === 'pending' || e.status === 'processing'),
        // D14 — carry an un-acked pending reset across CAN (omit when null).
        ...(pendingReset ? { pendingReset } : {}),
        lastInboundRRTime,
        lastOutboundTime,
        // #399 W2 — counters carried across continueAsNew so the
        // dashboard's "Messages" + "tempo" surfaces stay monotonic.
        receivedCount,
        sentCount,
        activityCount,
        outboxLocked,
        heldMessage,
        paused,
        inFlightMessageIds: [...inFlightMessages],
        processingSince: processingSince ?? undefined,
        destroyed: destroyed || destroyRequested,
        // v0.25 attachment state — each carried forward with the lease extension applied.
        ...(extendedAttachment ? { currentAttachment: extendedAttachment } : {}),
        ...(preferredHost ? { preferredHost } : {}),
        phase,
        ...(drainingSince ? { drainingSince } : {}),
        ...(drainingDeadlineMs !== null ? { drainingDeadlineMs } : {}),
        // #334 PR-1 — carry player saveable state only when populated.
        // Empty maps are omitted from the CAN payload to keep the wire
        // small for the common no-state case (same idiom as currentAttachment).
        ...(Object.keys(playerState).length > 0 ? { playerState } : {}),
        // #910 — carry the at-least-once dedup ring forward (omit when empty;
        // bounded so it stays constant-size across CAN).
        ...(seenDeliveryIds.length > 0 ? { seenDeliveryIds } : {}),
        // #897 (A) — carry the spawn-identity record across CAN (omit when null).
        ...(spawnRecord ? { spawnRecord } : {}),
        ...(input.metadata.isConductor ? { commandHistory, reportHistory, qualityGates, worktrees, stages } : {}),
      });
    }
  }

  // ── Exit path ──
  // Single terminal state: `destroyRequested` (from the `destroy` update OR from the
  // quarantined `updateMetadata({ status: 'terminated' })` test-compat shim — both
  // route through §2.5 abandon-in-flight semantics). PR-C commit 4 retired the
  // v0.24 legacy 2-min drain-wait branch; callers expecting drain semantics should
  // request it before destroy (e.g. via `requestDetach` + wait for phase=detached).
  await condition(allHandlersFinished);

  // Finalize `destroyed = true` so `isDestroyed` queries against the completed run return true.
  destroyed = true;
}
