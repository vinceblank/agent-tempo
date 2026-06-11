/**
 * `TempoClientCore` — pure-RPC factory implementation.
 *
 * Every method here goes through the Temporal `Client`; none shell out to
 * a local terminal. Safe to instantiate from the daemon, MCP server,
 * future SSE event source, and any external SDK consumer that wants a
 * headless surface (no `child_process` dependency).
 *
 * The two spawn methods (`createEnsemble`, `spawnConductor`) and the
 * `runTempoCli` helper live in `./with-spawn.ts`, which composes this
 * factory and adds the TTY-bound surface.
 *
 * See `docs/adr/0007-tempoclient-core-withspawn-split.md` and
 * `docs/design/tempoclient-core-spawn-split.md`.
 */
import { hostname as osHostname } from 'os';
import { Client, WorkflowIdConflictPolicy } from '@temporalio/client';
import { maestroWorkflowId, schedulerWorkflowId, sessionWorkflowId, conductorWorkflowId, GLOBAL_MAESTRO_WORKFLOW_ID } from '../config';
import { recordAction } from '../utils/action-counters';
import type {
  AttachmentPhase,
  MaestroPlayerInfo,
  MaestroRelayMessage,
  HistoryEntry,
  Message,
  SentMessage,
  SessionMetadata,
  ScheduleEntry,
  QualityGate,
  StageEntry,
  WorktreeEntry,
  EnsembleChatResult,
  OutboxEntryInput,
  AnswerEntry,
  CoatCheckEntry,
} from '../types';
import {
  submitOutboxUpdate,
  attachmentInfoQuery,
  destroyUpdate,
  outboxLockedQuery,
  requestDetachSignal,
  releaseHeldSignal,
  setPausedSignal,
  getRunIdQuery,
  getMessagingStateQuery,
  getLeaseStateQuery,
  getCoarseActivityQuery,
} from '../workflows/signals';
import {
  maestroPausedQuery,
  getEnsembleDescriptionQuery,
  getEnsembleStartTimeQuery,
  getCurrentBpmQuery,
  getTempoSeriesQuery,
  maestroGetAnswerQuery,
  coatCheckPutUpdate,
  coatCheckGetUpdate,
} from '../workflows/maestro-signals';
import type {
  CoatCheckPutInput,
  CoatCheckPutResult,
  CoatCheckGetInput,
} from '../workflows/maestro-signals';
import { resolveSession, scanEnsembleSessions } from '../activities/resolve';
import { restoreOrphansOnce, type RestoreOrphansSummary } from '../reconcile/orphans';
import { queryHandleWithTimeout, DEFAULT_QUERY_TIMEOUT_MS } from '../utils/query-timeout';
import { iterateWithDeadline, isVisibilityTimeout } from '../utils/visibility-deadline';
import {
  pauseMaestroAndScheduler,
  unpauseMaestroAndScheduler,
  signalAllSessions,
} from '../utils/ensemble-ops';
import {
  getAttachmentPhase,
  getEnsembleName,
  getIsConductor,
  getPlayerType,
} from '../utils/search-attributes';
import type {
  TempoClientCore,
  EnsembleSummary,
  EnsembleShutdownDetail,
  EnsembleDestroySummary,
  ReleaseClientResult,
} from './interface';
import { createSubscribe, type SubscribeDeps } from './subscribe';

/**
 * Optional construction params shared by {@link createTempoClientCore}
 * and {@link createTempoClientWithSpawn}. `subscribeDeps` is forwarded to
 * the SSE wrapper at `src/client/subscribe.ts` — pass overrides for
 * `baseUrl`, `token`, `fetchImpl`, or `sleep` from tests / non-default
 * environments.
 *
 * `taskQueue` is the daemon's polling task queue name (e.g.
 * `agent-tempo` in prod, `agent-tempo-dev` in dev mode). It's used by
 * `listHosts` to discover daemons polling the right queue — without it,
 * `listHosts` defaults to `agent-tempo` and silently returns `[]` in dev
 * mode even though the dev daemon is healthy on `agent-tempo-dev` (#437).
 * Headless construction sites (daemon HTTP server, MCP server) MUST pass
 * `taskQueue: config.taskQueue` so dev/prod isolation flows through.
 */
export interface CreateTempoClientOpts {
  subscribeDeps?: SubscribeDeps;
  taskQueue?: string;
}

// ── Helpers (module-private; shared with `with-spawn.ts` if needed via re-export) ──

/** Escape a value for use in Temporal visibility query strings.
 *  Strips characters that could break or inject into the query. */
function sanitizeQueryValue(value: string): string {
  return value.replace(/["\\\n\r]/g, '');
}

/** Shared unknown-error → string helper for summary `error` fields. */
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── Factory ──

/**
 * Build a `TempoClientCore` over a configured Temporal `Client`. Headless
 * callers (daemon, MCP tools, SSE event source) use this directly; TTY
 * callers go through {@link createTempoClientWithSpawn} from
 * `./with-spawn.ts`.
 *
 * `opts.subscribeDeps` is forwarded to the SSE subscribe wrapper so
 * tests/non-default environments can override `baseUrl`, `token`,
 * `fetchImpl`, or `sleep` without monkey-patching globals.
 */
export function createTempoClientCore(
  client: Client,
  opts: CreateTempoClientOpts = {},
): TempoClientCore {
  const globalMaestroId = GLOBAL_MAESTRO_WORKFLOW_ID;
  const subscribe = createSubscribe(opts.subscribeDeps);
  // Closed over by `listHosts` below — see #437. Daemon HTTP/MCP/aggregate
  // construction sites must pass `taskQueue: config.taskQueue` for dev-mode
  // host discovery to find the right pollers.
  const taskQueue = opts.taskQueue;

  /** Helper: get a workflow handle by ID. */
  function handle(workflowId: string) {
    return client.workflow.getHandle(workflowId);
  }

  /**
   * Shared between `listEnsembles()` and `listEnsemblesBounded()` (#336/#529).
   * Given the per-ensemble aggregation map produced by the visibility-list
   * loop, fans out the per-ensemble maestro `maestroPaused` query and
   * builds the final `EnsembleSummary[]`.
   *
   * Kept as a closure so it inherits `handle` from the factory scope (and
   * the `queryHandleWithTimeout` + `maestroPausedQuery` bindings from
   * module scope) without threading them through as args.
   */
  async function finishEnsembleSummaries(
    byEnsemble: Map<string, {
      count: number;
      hasConductor: boolean;
      conductorStatus?: string;
      liveAdapterCount: number;
      hasDetached: boolean;
    }>,
  ): Promise<EnsembleSummary[]> {
    // Per-ensemble paused lookup: `/pause` and `/shutdown` both flip
    // `maestroSetPausedSignal` on the maestro hub workflow. The hub's
    // `maestroPaused` query is the authoritative "ensemble is paused"
    // signal — fall back to the phase heuristic when the hub doesn't
    // exist (bare ensemble before any conductor / TUI was attached).
    const pausedByEnsemble = new Map<string, boolean>();
    await Promise.all(
      [...byEnsemble.keys()].map(async (name) => {
        try {
          // Issue #433 — bound per-ensemble maestro query so a wedged
          // maestro can't hang `listEnsembles` (the snapshot existence
          // gate at snapshot.ts:144). Existing catch maps any failure
          // to "leave paused undefined" and the downstream phase
          // heuristic classifies the ensemble.
          const paused = await queryHandleWithTimeout(
            handle(maestroWorkflowId(name)),
            maestroPausedQuery,
          );
          pausedByEnsemble.set(name, !!paused);
        } catch {
          // Hub workflow not running, or worker wedged (#433) — leave
          // undefined so the phase heuristic below decides
          // classification.
        }
      }),
    );

    const out: EnsembleSummary[] = [];
    for (const [name, info] of byEnsemble) {
      // Skip ensembles with no non-gone sessions — they're either
      // terminating or fully destroyed.
      if (info.liveAdapterCount === 0 && !info.hasDetached) continue;
      const paused = pausedByEnsemble.get(name);
      // Three-state classification:
      //   online  — hub unpaused (or no hub + at least one live adapter).
      //   paused  — hub paused AND at least one live adapter remains
      //             (`/pause` semantics: resume in place via `/play`).
      //   offline — hub paused AND zero live adapters
      //             (`/shutdown` semantics: requires `/restore`).
      // When the hub didn't answer (no maestro yet), fall back to the
      // phase heuristic — a live adapter implies online.
      let state: 'online' | 'paused' | 'offline';
      if (paused === true) {
        state = info.liveAdapterCount > 0 ? 'paused' : 'offline';
      } else if (paused === false) {
        state = 'online';
      } else {
        state = info.liveAdapterCount > 0 ? 'online' : 'offline';
      }
      out.push({
        name,
        playerCount: info.count,
        hasConductor: info.hasConductor,
        conductorStatus: info.conductorStatus,
        state,
      });
    }
    return out;
  }

  // #753 — visibility scans don't flow through the workflow-client
  // interceptor; count one 'list' per scan at this seam. The
  // `listEnsemblesBounded` path keeps calling `client.workflow.list`
  // directly because `iterateWithDeadline` already counts it.
  const listWorkflows = (options: Parameters<Client['workflow']['list']>[0]) => {
    recordAction('list');
    return client.workflow.list(options);
  };

  return {
    subscribe,
    async discoverEnsembles(): Promise<EnsembleSummary[]> {
      // Strategy 1: Global Maestro playersByEnsemble query
      try {
        const h = handle(globalMaestroId);
        // #433: unbounded — justified because `discoverEnsembles` is not
        // reachable from `buildEnsembleSnapshot` (it's a CLI / TUI
        // discovery surface, separate from the snapshot existence gate
        // which uses `listEnsembles`). A hung global maestro here only
        // affects the CLI lister, which has its own user-facing
        // cancellability via Ctrl-C.
        const byEnsemble: Record<string, MaestroPlayerInfo[]> = await h.query('maestroPlayersByEnsemble');
        const results = Object.entries(byEnsemble).map(([name, players]) => {
          const conductor = players.find(p => p.isConductor);
          return {
            name,
            playerCount: players.length,
            hasConductor: !!conductor,
            // `conductorStatus` is a public TempoClient API field (EnsembleInfo);
            // its value now carries the attachment-phase string (post-#176 drift).
            conductorStatus: conductor?.phase,
          };
        });
        // Only trust Maestro if it has discovered ensembles; fall through to
        // Strategy 2 when empty — the Maestro may not have refreshed yet.
        if (results.length > 0) return results;
      } catch {
        // Global Maestro not available — fall through
      }

      // Strategy 2: Direct workflow list scan
      try {
        const query = 'WorkflowType = "agentSessionWorkflow" AND ExecutionStatus = "Running"';
        const ensembleMap = new Map<string, { count: number; hasConductor: boolean; conductorStatus?: string }>();

        for await (const wf of listWorkflows({ query })) {
          const name = getEnsembleName(wf);
          if (!name) continue;

          const entry = ensembleMap.get(name) || { count: 0, hasConductor: false };
          entry.count++;

          // Preferred: AgentTempoIsConductor search attribute (canonical, queryable).
          // Fallback: workflow ID convention — covers the brief window after a
          // conductor spawn before the search attribute is indexed.
          const isConductorFromSA = getIsConductor(wf) === true;
          const isConductorFromId = wf.workflowId?.endsWith('-conductor') ?? false;
          if (isConductorFromSA || isConductorFromId) {
            entry.hasConductor = true;
            // Post-#175 the workflow writes `AgentTempoAttachmentState` (phase) in
            // place of the removed `AgentTempoStatus` search attribute.
            entry.conductorStatus = getAttachmentPhase(wf);
          }

          ensembleMap.set(name, entry);
        }

        return [...ensembleMap.entries()].map(([name, info]) => ({
          name,
          playerCount: info.count,
          hasConductor: info.hasConductor,
          conductorStatus: info.conductorStatus,
        }));
      } catch {
        return [];
      }
    },

    async listEnsembles(): Promise<EnsembleSummary[]> {
      // Direct workflow-list scan — the Global Maestro index only tracks
      // live ensembles, so classifying paused/offline ensembles requires
      // reading the attachment-state search attribute per workflow.
      //
      // `liveAdapterCount` distinguishes `paused` (≥1 live adapter, can
      // resume in place via `/play`) from `offline` (zero live adapters,
      // requires `/restore`). The maestro session is excluded from this
      // count — it's the TUI's own dashboard attachment, never a peer
      // agent that user-facing `/play` should target.
      const LIVE_PHASES = new Set<AttachmentPhase>([
        'attached', 'processing', 'awaiting', 'booting', 'draining',
      ]);
      type Agg = {
        count: number;
        hasConductor: boolean;
        conductorStatus?: string;
        liveAdapterCount: number;
        hasDetached: boolean;
      };
      const byEnsemble = new Map<string, Agg>();
      try {
        const query = 'WorkflowType = "agentSessionWorkflow" AND ExecutionStatus = "Running"';
        for await (const wf of listWorkflows({ query })) {
          const name = getEnsembleName(wf);
          if (!name) continue;

          // Exclude the maestro session from the headline player count.
          // The maestro is the TUI's own dashboard attachment, not a peer
          // agent — counting it produced confusing "(2 players)" rows on
          // a fresh ensemble with one real player. Mirrors the
          // `filterRealPlayers` rule used in StatusBar (cf6becd). Detect
          // via the canonical `AgentTempoPlayerType` search attribute,
          // with a workflow-id-suffix fallback for the brief post-start
          // window before search attributes propagate.
          const playerType = getPlayerType(wf);
          const isMaestroSession = playerType === 'maestro'
            || (wf.workflowId?.endsWith('-maestro') ?? false);

          const phase = getAttachmentPhase(wf) as AttachmentPhase | undefined;
          const entry = byEnsemble.get(name) ?? {
            count: 0, hasConductor: false, liveAdapterCount: 0, hasDetached: false,
          };
          if (!isMaestroSession) entry.count++;
          if (phase === 'detached') entry.hasDetached = true;
          else if (phase && LIVE_PHASES.has(phase) && !isMaestroSession) {
            entry.liveAdapterCount++;
          }

          const isConductorFromSA = getIsConductor(wf) === true;
          const isConductorFromId = wf.workflowId?.endsWith('-conductor') ?? false;
          if (isConductorFromSA || isConductorFromId) {
            entry.hasConductor = true;
            if (phase) entry.conductorStatus = phase;
          }
          byEnsemble.set(name, entry);
        }
      } catch {
        return [];
      }

      return await finishEnsembleSummaries(byEnsemble);
    },

    async listEnsemblesBounded(deadlineMs: number): Promise<{
      items: EnsembleSummary[];
      timedOut: boolean;
      scanned: number;
    }> {
      // #336/#529 site 6 — bounded variant for `AggregateRunner.collect()`'s
      // 750ms poll. On deadline, propagates `timedOut: true` so the
      // collect tick can skip the entire diff round (preserving
      // `knownEnsembles` and avoiding phantom `ensemble.destroyed`
      // SSE events). Architect-approved invariant for this PR.
      const LIVE_PHASES = new Set<AttachmentPhase>([
        'attached', 'processing', 'awaiting', 'booting', 'draining',
      ]);
      type Agg = {
        count: number;
        hasConductor: boolean;
        conductorStatus?: string;
        liveAdapterCount: number;
        hasDetached: boolean;
      };
      const byEnsemble = new Map<string, Agg>();
      let scanned = 0;
      let timedOut = false;

      try {
        const query = 'WorkflowType = "agentSessionWorkflow" AND ExecutionStatus = "Running"';
        for await (const wf of iterateWithDeadline(
          client.workflow.list({ query }),
          deadlineMs,
          'listEnsemblesBounded',
        )) {
          scanned++;
          const name = getEnsembleName(wf);
          if (!name) continue;
          const playerType = getPlayerType(wf);
          const isMaestroSession = playerType === 'maestro'
            || (wf.workflowId?.endsWith('-maestro') ?? false);
          const phase = getAttachmentPhase(wf) as AttachmentPhase | undefined;
          const entry = byEnsemble.get(name) ?? {
            count: 0, hasConductor: false, liveAdapterCount: 0, hasDetached: false,
          };
          if (!isMaestroSession) entry.count++;
          if (phase === 'detached') entry.hasDetached = true;
          else if (phase && LIVE_PHASES.has(phase) && !isMaestroSession) {
            entry.liveAdapterCount++;
          }
          const isConductorFromSA = getIsConductor(wf) === true;
          const isConductorFromId = wf.workflowId?.endsWith('-conductor') ?? false;
          if (isConductorFromSA || isConductorFromId) {
            entry.hasConductor = true;
            if (phase) entry.conductorStatus = phase;
          }
          byEnsemble.set(name, entry);
        }
      } catch (err) {
        if (isVisibilityTimeout(err)) {
          timedOut = true;
          // Fall through: the caller (`AggregateRunner`) checks
          // `timedOut` and bails before applying any diff; we still
          // return whatever we managed to enumerate so test/diag
          // surfaces can inspect partial state if useful.
        } else {
          throw err; // catastrophic — propagate (no unbounded swallow).
        }
      }

      const items = await finishEnsembleSummaries(byEnsemble);
      return { items, timedOut, scanned };
    },

    async getPlayers(ensemble: string): Promise<MaestroPlayerInfo[]> {
      // Strategy 1: Global Maestro — filter by ensemble
      try {
        const h = handle(globalMaestroId);
        // Issue #433 — bound the global-maestro query so a wedged
        // global maestro can't hang `getPlayers` (called from the
        // snapshot fan-out and many other paths). Existing catch falls
        // through to Strategy 2 → Strategy 3 on any failure.
        const byEnsemble: Record<string, MaestroPlayerInfo[]> =
          await queryHandleWithTimeout(h, 'maestroPlayersByEnsemble');
        if (byEnsemble[ensemble]) return byEnsemble[ensemble];
      } catch {
        // Fall through
      }

      // Strategy 2: Per-ensemble Maestro
      try {
        const h = handle(maestroWorkflowId(ensemble));
        // Issue #433 — same reasoning, applied to the per-ensemble maestro.
        return await queryHandleWithTimeout<MaestroPlayerInfo[]>(h, 'maestroPlayers');
      } catch {
        // Fall through
      }

      // Strategy 3: Direct workflow list
      try {
        const query = `WorkflowType = "agentSessionWorkflow" AND ExecutionStatus = "Running" AND AgentTempoEnsemble = "${sanitizeQueryValue(ensemble)}"`;
        const players: MaestroPlayerInfo[] = [];
        for await (const wf of listWorkflows({ query })) {
          const sa = wf.searchAttributes || {};
          const playerId = Array.isArray(sa.AgentTempoPlayerId) ? String(sa.AgentTempoPlayerId[0]) : wf.workflowId;
          // Preferred: memo (v1.8 SA diet) with legacy-SA fallback via the
          // dual-read helper. Final fallback: workflow ID convention —
          // covers the brief window after a conductor spawn before
          // visibility propagates.
          const isConductorFromSA = getIsConductor(wf) === true;
          const isConductorFromId = wf.workflowId?.endsWith('-conductor') ?? false;
          players.push({
            playerId,
            ensemble,
            part: '',
            hostname: Array.isArray(sa.AgentTempoHostname) ? String(sa.AgentTempoHostname[0]) : '',
            workDir: '',
            isConductor: isConductorFromSA || isConductorFromId,
            agentType: 'claude',
            // Attachment phase from `AgentTempoAttachmentState` search attr.
            phase: Array.isArray(sa.AgentTempoAttachmentState)
              ? (String(sa.AgentTempoAttachmentState[0]) as AttachmentPhase)
              : undefined,
          });
        }
        return players;
      } catch {
        return [];
      }
    },

    async getEnsembleMeta(ensemble: string): Promise<{
      description: string;
      startedAt: string;
      currentBpm: number;
      tempoSeries: number[];
    }> {
      // Issue #399 W1 — fan-out four queries against the per-ensemble
      // maestro hub. Each query soft-fails to its sentinel default so
      // a single transient failure can't block the snapshot endpoint.
      const h = handle(maestroWorkflowId(ensemble));
      // Issue #433 — bound each per-maestro query so a wedged maestro
      // worker can't hang `getEnsembleMeta` (called from snapshot fan-out
      // on every `/v1/state/:ensemble` request and every aggregate tick).
      // Each query already soft-fails to its sentinel; `QueryTimeoutError`
      // falls into the same `.catch(() => sentinel)` path.
      const [description, startedAt, currentBpm, tempoSeries] = await Promise.all([
        queryHandleWithTimeout(h, getEnsembleDescriptionQuery).catch(() => '' as string),
        queryHandleWithTimeout(h, getEnsembleStartTimeQuery).catch(() => '' as string),
        queryHandleWithTimeout(h, getCurrentBpmQuery).catch(() => 0 as number),
        queryHandleWithTimeout(h, getTempoSeriesQuery).catch(() => [] as number[]),
      ]);
      return { description, startedAt, currentBpm, tempoSeries };
    },

    async getPlayerWireMeta(ensemble: string, playerId: string): Promise<{
      runId?: string;
      messaging?: { received: number; sent: number; outbox: string };
      lease?: { expiresAt: number | null; leaseMs: number | null };
      coarse?: { currentTool: string | null; contextTokens?: number; contextPercent?: number };
    } | null> {
      // Issue #399 W2 — fan-out three queries against the session
      // workflow. The handle is opened by workflow ID directly; if the
      // workflow can't be resolved (just-recruited, just-destroyed,
      // transient lookup failure) every query rejects together and
      // we return `null` so the caller's projection drops the whole
      // wire-meta block rather than emitting half-populated fields.
      const h = handle(sessionWorkflowId(ensemble, playerId));
      // Issue #433 — bound each per-session query. Without a timeout,
      // `Promise.allSettled` waits for the slowest query to settle (or
      // never, if the session worker is wedged), so a single hung session
      // would block the entire snapshot fan-out for `/v1/state/:ensemble`
      // and the AggregateRunner's 750ms poll loop. With timeouts, hung
      // queries reject as `QueryTimeoutError`, `Promise.allSettled` sees
      // three rejections and the existing all-rejected branch returns
      // `null` — caller treats this player's wireMeta as missing.
      const [runIdR, messagingR, leaseR, coarseR] = await Promise.allSettled([
        queryHandleWithTimeout(h, getRunIdQuery),
        queryHandleWithTimeout(h, getMessagingStateQuery),
        queryHandleWithTimeout(h, getLeaseStateQuery),
        // 3c Tier-1 — coarse activity (currentTool + context usage). Bounded like
        // the others; an older session workflow without the handler rejects and
        // is simply absent (additive/non-breaking).
        queryHandleWithTimeout(h, getCoarseActivityQuery),
      ]);
      // If every query rejected, treat this as "session unreachable" —
      // the caller renders no wire-meta rather than partial sentinels.
      if (
        runIdR.status === 'rejected' &&
        messagingR.status === 'rejected' &&
        leaseR.status === 'rejected' &&
        coarseR.status === 'rejected'
      ) {
        return null;
      }
      const out: {
        runId?: string;
        messaging?: { received: number; sent: number; outbox: string };
        lease?: { expiresAt: number | null; leaseMs: number | null };
        coarse?: { currentTool: string | null; contextTokens?: number; contextPercent?: number };
      } = {};
      if (runIdR.status === 'fulfilled') out.runId = runIdR.value;
      if (messagingR.status === 'fulfilled') out.messaging = messagingR.value;
      if (leaseR.status === 'fulfilled') out.lease = leaseR.value;
      if (coarseR.status === 'fulfilled') out.coarse = coarseR.value;
      return out;
    },

    async getMessages(ensemble: string, limit?: number): Promise<MaestroRelayMessage[]> {
      try {
        const h = handle(globalMaestroId);
        // #433: unbounded — justified, `getMessages` is not reachable from
        // `buildEnsembleSnapshot` (snapshot uses `getEnsembleChat`).
        // Called by the recall MCP tool / TUI on user demand; user can
        // Ctrl-C if it hangs.
        const all: MaestroRelayMessage[] = await h.query('maestroRecentMessages');
        const filtered = all.filter(m => m.ensemble === ensemble);
        return limit ? filtered.slice(-limit) : filtered;
      } catch {
        return [];
      }
    },

    async getConductorHistory(ensemble: string): Promise<HistoryEntry[]> {
      try {
        const h = handle(globalMaestroId);
        const result: { success: boolean; history: HistoryEntry[] } = await h.executeUpdate('maestroFetchConductorHistory', {
          args: [{ ensemble }],
        });
        if (result.success) return result.history;
        return [];
      } catch {
        return [];
      }
    },

    async getPlayerMessages(ensemble: string, playerId: string): Promise<Array<Message | (SentMessage & { direction: 'sent' })>> {
      try {
        const h = handle(globalMaestroId);
        return await h.executeUpdate('maestroFetchPlayerMessages', {
          args: [{ ensemble, playerId }],
        });
      } catch {
        return [];
      }
    },

    async getPlayerMetadata(ensemble: string, playerId: string): Promise<SessionMetadata | null> {
      try {
        // Query the player's workflow directly for metadata
        const query = `WorkflowType = "agentSessionWorkflow" AND ExecutionStatus = "Running" AND AgentTempoEnsemble = "${sanitizeQueryValue(ensemble)}" AND AgentTempoPlayerId = "${sanitizeQueryValue(playerId)}"`;
        for await (const wf of listWorkflows({ query })) {
          const h = handle(wf.workflowId);
          // #433: unbounded — justified, `getPlayerMetadata` is not
          // reachable from `buildEnsembleSnapshot` (snapshot reads
          // metadata via `getPlayers` → maestro fan-out, not per-player
          // direct query). Used by ad-hoc tools / debug surfaces on
          // user demand.
          return await h.query('getMetadata');
        }
        return null;
      } catch {
        return null;
      }
    },

    async sendCommand(ensemble: string, text: string, source: string): Promise<string> {
      // Route commands through Maestro hub → conductor's commandSignal
      let result: string;
      try {
        const h = handle(globalMaestroId);
        result = await h.executeUpdate('maestroGlobalSendCommand', {
          args: [{ ensemble, text, source }],
        });
      } catch {
        const h = handle(maestroWorkflowId(ensemble));
        result = await h.executeUpdate('maestroSendCommand', {
          args: [{ text, source }],
        });
      }
      // Record on maestro workflow for history persistence
      try {
        const maestroId = sessionWorkflowId(ensemble, 'maestro');
        const mh = handle(maestroId);
        await mh.signal('recordSentMessage', { to: 'conductor', text });
      } catch { /* best effort */ }
      return result;
    },

    async sendMessage(ensemble: string, to: string, text: string, source: string): Promise<string> {
      // Direct signal with isMaestro flag — matches web Maestro pattern
      const query = `WorkflowType = "agentSessionWorkflow" AND ExecutionStatus = "Running" AND AgentTempoEnsemble = "${sanitizeQueryValue(ensemble)}" AND AgentTempoPlayerId = "${sanitizeQueryValue(to)}"`;
      let sent = false;
      for await (const wf of listWorkflows({ query })) {
        const h = handle(wf.workflowId);
        await h.signal('receiveMessage', {
          from: source,
          text,
          isMaestro: true,
        });
        sent = true;
        break;
      }
      if (!sent) {
        // Fallback: try via Maestro hub if direct resolution fails
        try {
          const h = handle(globalMaestroId);
          await h.executeUpdate('maestroSendMessage', {
            args: [{ ensemble, to, text, source }],
          });
        } catch {
          throw new Error(`Player "${to}" not found in ensemble "${ensemble}"`);
        }
      }
      // Record on maestro workflow for history persistence
      try {
        const maestroId = sessionWorkflowId(ensemble, 'maestro');
        const mh = handle(maestroId);
        await mh.signal('recordSentMessage', { to, text });
      } catch { /* best effort */ }
      return `maestro-msg-${Date.now()}`;
    },

    async terminatePlayer(ensemble: string, playerId: string): Promise<void> {
      const query = `WorkflowType = "agentSessionWorkflow" AND ExecutionStatus = "Running" AND AgentTempoEnsemble = "${sanitizeQueryValue(ensemble)}" AND AgentTempoPlayerId = "${sanitizeQueryValue(playerId)}"`;
      for await (const wf of listWorkflows({ query })) {
        const h = handle(wf.workflowId);
        await h.terminate('terminated via TUI');
        return;
      }
      throw new Error(`Player "${playerId}" not found in ensemble "${ensemble}"`);
    },

    // ── PR-D verbs — enqueue on the TUI-owned maestro session's outbox.
    //   The dispatch loop runs `deliverDetach` / `deliverDestroy` /
    //   `deliverRestart` activities against the target (QA B1/B2/B3).

    async recruit(ensemble, opts) {
      // #306: Lazy-import the agent-type resolver so the TUI/CLI bundle
      // doesn't pull in the subagent YAML crawler at module-load time.
      // The `held` flow on the TUI side doesn't currently exercise this;
      // `playerType` is only resolved when supplied.
      let agentDefinition: string | undefined;
      let agentDefinitionPath: string | undefined;
      let agentDefinitionDescription: string | undefined;
      let nativeResolvable: boolean | undefined;
      let allowedTools: string[] | undefined;
      if (opts.playerType) {
        const { resolveAgentType } = await import('../ensemble/agent-types');
        const info = resolveAgentType(opts.playerType);
        if (!info) {
          throw new Error(`Unknown agent type "${opts.playerType}"`);
        }
        agentDefinition = info.name;
        agentDefinitionPath = info.path;
        agentDefinitionDescription = info.description;
        nativeResolvable = info.nativeResolvable;
        allowedTools = info.allowedTools;
      }

      const maestroId = sessionWorkflowId(ensemble, 'maestro');
      const h = handle(maestroId);
      // #306 fix: always set `targetHostname` on the entry. The TUI-owned
      // maestro session stores `hostname: 'dashboard'` in its metadata
      // (a placeholder, not a real host), so the session workflow's
      // fallback path — `entry.targetHostname || input.metadata.hostname`
      // — routes `spawnProcess` to task queue `agent-tempo-dashboard`,
      // which has no worker. The MCP `recruit` tool worked because the
      // conductor session that ran it had a real OS hostname in metadata.
      // Mirror that behavior here by defaulting to `osHostname()` when
      // the caller didn't pin a specific host.
      const targetHostname = opts.host ?? osHostname();
      const entry = {
        type: 'recruit' as const,
        targetName: opts.name,
        workDir: opts.workDir,
        isConductor: opts.isConductor === true,
        agent: opts.agent ?? 'claude',
        ...(opts.initialMessage !== undefined ? { initialMessage: opts.initialMessage } : {}),
        // If a player-type is provided, let the outbox activity supply the
        // agent definition bundle; otherwise fall back to an explicit
        // systemPrompt path (mirrors the recruit MCP tool's branching).
        ...(agentDefinition
          ? { agentDefinition, agentDefinitionPath, agentDefinitionDescription, nativeResolvable, allowedTools }
          : opts.systemPrompt !== undefined ? { systemPrompt: opts.systemPrompt } : {}),
        targetHostname,
        ...(opts.held === true ? { held: true } : {}),
      } satisfies OutboxEntryInput;
      const entryId = await h.executeUpdate(submitOutboxUpdate, { args: [entry] });
      return { playerId: opts.name, entryId };
    },

    async release(ensemble, playerId): Promise<ReleaseClientResult> {
      const maestroId = sessionWorkflowId(ensemble, 'maestro');
      const mh = handle(maestroId);
      const submitRelease = async (target: string): Promise<void> => {
        const entry: OutboxEntryInput = { type: 'release', targetPlayerId: target };
        await mh.executeUpdate(submitOutboxUpdate, { args: [entry] });
      };

      if (playerId) {
        // Single-player release — match the MCP tool: only submit when the
        // session's outbox is actually locked, so the caller sees a clean
        // error instead of a no-op success for already-running sessions.
        const target = await resolveSession(client, ensemble, playerId);
        if (!target) {
          throw new Error(`No session found with name "${playerId}" in ensemble "${ensemble}".`);
        }
        let isLocked = false;
        try {
          // #433: unbounded — justified, the single-player `release()`
          // path is an explicit MCP tool action triggered by the user
          // ("release X"), not the snapshot fan-out. `isAnySessionHeld`
          // (also called `outboxLockedQuery` per-session, but in the
          // snapshot path) IS wrapped — see line ~1020.
          isLocked = await target.query(outboxLockedQuery);
        } catch {
          // Query may fail for old workflows — treat as "not held" to avoid
          // false-positive release requests on pre-outboxLocked builds.
        }
        if (!isLocked) {
          throw new Error(`Session "${playerId}" is not held (outbox not locked).`);
        }
        await submitRelease(playerId);
        return { released: [playerId], errors: [] };
      }

      // Bulk release — scan + query + enqueue each held session. The scan
      // skips the TUI's own maestro session so we don't try to release
      // ourselves. Errors are returned as soft failures so the caller can
      // render a partial-success summary.
      const sessions = await scanEnsembleSessions(client, ensemble);
      const held: Array<{ playerId: string; workflowId: string }> = [];
      for (const s of sessions) {
        if (s.playerId === 'maestro') continue;
        try {
          const sh = handle(s.workflowId);
          // Issue #433 — bound the per-session query so a single wedged
          // worker doesn't block the rest of the bulk-release scan. The
          // existing catch already maps failures to "not held".
          const locked = await queryHandleWithTimeout(sh, outboxLockedQuery);
          if (locked) held.push(s);
        } catch {
          // Skip sessions where the query fails (old workflows, terminated,
          // or wedged-worker timeout per #433).
        }
      }

      const released: string[] = [];
      const errors: Array<{ playerId: string; error: string }> = [];
      for (const s of held) {
        try {
          await submitRelease(s.playerId);
          released.push(s.playerId);
        } catch (err) {
          errors.push({ playerId: s.playerId, error: errMsg(err) });
        }
      }
      return { released, errors };
    },

    async restart(ensemble, playerId, opts = {}) {
      const invokerPlayerId = opts.invokerPlayerId ?? 'cli';
      const maestroId = sessionWorkflowId(ensemble, 'maestro');
      const h = handle(maestroId);
      // #580 — `confirmStealFromHost` is a caller-side intent flag (§16.5
      // Option B). The outbox entry has no slot for it because the workflow
      // trusts the caller; the gate is enforced pre-submit by the TUI
      // handler and the shared MCP-tool guard. Accepting the field on
      // `RestartClientOpts` gives external SDK consumers and the TUI a
      // typed pipeline to forward the confirmed value.
      const entry: OutboxEntryInput = {
        type: 'restart',
        targetPlayerId: playerId,
        invokerPlayerId,
        ...(opts.host !== undefined ? { host: opts.host } : {}),
        ...(opts.fresh !== undefined ? { fresh: opts.fresh } : {}),
        ...(opts.force !== undefined ? { force: opts.force } : {}),
        ...(opts.contextMessages !== undefined ? { contextMessages: opts.contextMessages } : {}),
        ...(opts.loadFromState !== undefined ? { loadFromState: opts.loadFromState } : {}),
        ...(opts.transcript !== undefined ? { transcript: opts.transcript } : {}),
      };
      const entryId = await h.executeUpdate(submitOutboxUpdate, { args: [entry] });
      return {
        playerId,
        ...(opts.host !== undefined ? { host: opts.host } : {}),
        entryId,
      };
    },

    async reset(ensemble, playerId, reason) {
      // H5b: HTTP-route counterpart to the `reset` MCP tool (D14). Enqueues the
      // SAME `'reset'` outbox entry on the maestro outbox — no new wire. D14:
      // reset is clean-wipe only (always `fresh: true`); `invokerPlayerId:
      // 'maestro'` is the operator identity, surfaced to the wiped session as
      // `requestedBy`. The caller (HTTP handler) ensures the maestro exists.
      const maestroId = sessionWorkflowId(ensemble, 'maestro');
      const h = handle(maestroId);
      const entry: OutboxEntryInput = {
        type: 'reset',
        targetPlayerId: playerId,
        invokerPlayerId: 'maestro',
        fresh: true,
        ...(reason !== undefined ? { reason } : {}),
      };
      const entryId = await h.executeUpdate(submitOutboxUpdate, { args: [entry] });
      return { playerId, entryId };
    },

    async detach(ensemble, playerId, deadlineMs = 5_000) {
      const maestroId = sessionWorkflowId(ensemble, 'maestro');
      const h = handle(maestroId);
      const entry: OutboxEntryInput = {
        type: 'detach',
        targetPlayerId: playerId,
        reason: 'user-stop',
        deadlineMs,
      };
      await h.executeUpdate(submitOutboxUpdate, { args: [entry] });
    },

    async destroy(ensemble, playerId, reason) {
      // #287: ensemble-scope when `playerId` is omitted. Peer sessions in
      // parallel → scheduler + maestro terminate in parallel → conductor
      // last so it sees every peer teardown. Matches the destroy tool.
      if (playerId === undefined) {
        const destroyReason = reason ?? 'ensemble destroy via TempoClient';
        const conductorWfId = conductorWorkflowId(ensemble);
        const sessions = await scanEnsembleSessions(client, ensemble);

        const peers: typeof sessions = [];
        let conductorPresent = false;
        for (const s of sessions) {
          if (s.workflowId === conductorWfId) conductorPresent = true;
          else peers.push(s);
        }

        const summary: EnsembleDestroySummary = {
          destroyed: 0,
          terminated: 0,
          failed: 0,
          details: [],
        };
        const destroyArgs = { reason: destroyReason, terminatedBy: 'tempo-client' };

        // Peers in parallel.
        const peerResults = await Promise.allSettled(
          peers.map(async (s) => {
            try {
              await handle(s.workflowId).executeUpdate(destroyUpdate, { args: [destroyArgs] });
              return { session: s, outcome: 'destroyed' as const };
            } catch (err) {
              return { session: s, outcome: 'failed' as const, error: errMsg(err) };
            }
          }),
        );
        for (const r of peerResults) {
          if (r.status !== 'fulfilled') continue;
          const v = r.value;
          if (v.outcome === 'destroyed') {
            summary.details.push({ target: v.session.playerId, outcome: 'destroyed' });
            summary.destroyed++;
          } else {
            summary.details.push({ target: v.session.playerId, outcome: 'failed', error: v.error });
            summary.failed++;
          }
        }

        // Scheduler + maestro terminate in parallel. `terminate` rejects on
        // missing workflows; treat as "not present" (don't count as failure).
        const [schedRes, maestroRes] = await Promise.allSettled([
          handle(schedulerWorkflowId(ensemble)).terminate(destroyReason),
          handle(maestroWorkflowId(ensemble)).terminate(destroyReason),
        ]);
        if (schedRes.status === 'fulfilled') {
          summary.details.push({ target: 'scheduler', outcome: 'terminated' });
          summary.terminated++;
        }
        if (maestroRes.status === 'fulfilled') {
          summary.details.push({ target: 'maestro', outcome: 'terminated' });
          summary.terminated++;
        }

        // Conductor last.
        if (conductorPresent) {
          try {
            await handle(conductorWfId).executeUpdate(destroyUpdate, { args: [destroyArgs] });
            summary.details.push({ target: 'conductor', outcome: 'destroyed' });
            summary.destroyed++;
          } catch (err) {
            summary.details.push({ target: 'conductor', outcome: 'failed', error: errMsg(err) });
            summary.failed++;
          }
        }
        return summary;
      }

      const maestroId = sessionWorkflowId(ensemble, 'maestro');
      const h = handle(maestroId);
      const entry: OutboxEntryInput = {
        type: 'destroy',
        targetPlayerId: playerId,
        ...(reason !== undefined ? { reason } : {}),
        notifyConductor: true,
      };
      await h.executeUpdate(submitOutboxUpdate, { args: [entry] });
    },

    async pause(ensemble) {
      await Promise.all([
        pauseMaestroAndScheduler(client, ensemble),
        signalAllSessions(client, ensemble, setPausedSignal.name, true),
      ]);
    },

    async play(ensemble, opts = {}) {
      const [, unpaused] = await Promise.all([
        unpauseMaestroAndScheduler(client, ensemble),
        signalAllSessions(client, ensemble, setPausedSignal.name, false),
      ]);
      if (opts.release === true && unpaused.sent > 0) {
        // Fan out releaseHeld AFTER everyone is unpaused so no session
        // receives `releaseHeld` while still paused.
        await signalAllSessions(client, ensemble, releaseHeldSignal.name, undefined);
      }
    },

    async shutdown(ensemble, opts = {}) {
      const deadlineMs = opts.deadlineMs ?? 5_000;
      const [toggle, fanout] = await Promise.all([
        pauseMaestroAndScheduler(client, ensemble),
        signalAllSessions(client, ensemble, requestDetachSignal.name, { reason: 'user-stop', deadlineMs }),
      ]);
      return {
        detached: fanout.sent,
        skipped: fanout.skipped,
        failed: fanout.failed,
        maestroPaused: toggle.maestro,
        schedulerPaused: toggle.scheduler,
        // #299 sibling: TempoClient does not pass a `skip` predicate to
        // `signalAllSessions`, so `fanout.perSession[*].outcome` will never
        // be `'skipped'` here. The narrowed `EnsembleShutdownDetail.outcome`
        // reflects the actual public surface; the `'skipped'` branch is an
        // explicit no-op that emits nothing.
        details: fanout.perSession.flatMap((p): EnsembleShutdownDetail[] => {
          if (p.outcome === 'sent') {
            return [{ playerId: p.playerId, outcome: 'detaching' }];
          }
          if (p.outcome === 'failed') {
            return [{ playerId: p.playerId, outcome: 'failed', error: p.error }];
          }
          return []; // 'skipped' is unreachable in the TempoClient path
        }),
      };
    },

    async restore(ensemble): Promise<RestoreOrphansSummary> {
      // Scope the orphan scan to the requested ensemble (#298 — matches the
      // `ensemble?` filter the CLI/TUI pass through) and unpause maestro +
      // scheduler for the same ensemble in parallel.
      //
      // #306: narrow to `phases: ['detached']`. User-invoked `/restore`
      // revives a parked ensemble — a live attached/processing session is
      // NOT a restorable orphan and must not be flagged as one. The broad
      // live-phase default is reserved for daemon reconcile-on-boot + CLI
      // `up --resume`, which have no PID memory after a crash and must
      // treat every live phase as a presumed orphan. Without this narrowing
      // a healthy conductor gets deliverRestart → requestDetach and is
      // hard-terminated by `drainingDeadline`.
      //
      // Bug A: also fan out `setPaused=false` to every session. Without
      // this, sessions whose `paused` flag was flipped (via `/pause` or
      // any prior pause path) stay frozen — the conductor receives
      // messages but its outbox dispatcher is gated by `!paused`, so
      // typed messages get no reply. Mirrors the pattern in `play()`:
      // the maestro/scheduler hub toggle is not enough on its own.
      const [summary] = await Promise.all([
        restoreOrphansOnce(client, {
          hostname: osHostname(),
          invokerPlayerId: 'tempo-client',
          policy: 'auto',
          ensemble,
          phases: ['detached'],
        }),
        unpauseMaestroAndScheduler(client, ensemble),
        signalAllSessions(client, ensemble, setPausedSignal.name, false),
      ]);
      return summary;
    },

    async migrate(ensemble, playerId, host, opts = {}) {
      if (!host || !host.trim()) {
        throw new Error('`host` is required for migrate. Use `restart` to revive on the current host.');
      }
      return this.restart(ensemble, playerId, { ...opts, host });
    },

    async attachmentInfo(ensemble, playerId) {
      // Read-only query — resolve + query directly (no outbox needed).
      const target = await resolveSession(client, ensemble, playerId);
      if (!target) throw new Error(`No session found with name "${playerId}" in ensemble "${ensemble}".`);
      // #433: unbounded — justified, `attachmentInfo()` is the
      // user-facing MCP tool that returns one player's lease/phase to
      // the operator. Not reachable from `buildEnsembleSnapshot`
      // (snapshot reads attachment info via the `phase` search
      // attribute and `getPlayerWireMeta`'s lease query, both bounded).
      return target.query(attachmentInfoQuery);
    },

    async listHosts(opts: { force?: boolean } = {}) {
      // Lazy import so this doesn't drag utils/hosts into every
      // consumer of TempoClient at module-load time.
      const { listHosts } = await import('../utils/hosts');
      // #437 — both `namespace` and `taskQueue` must match the daemon's
      // config or poller discovery silently returns `[]` (dev mode hits
      // `'agent-tempo-dev'`, prod hits `'agent-tempo'`). Passing
      // `taskQueue: undefined` is harmless — `listHosts` defaults via
      // `?? 'agent-tempo'` and unconditional pass-through avoids
      // per-call object allocation on this hot path.
      return listHosts(client, {
        force: Boolean(opts.force),
        namespace: client.options.namespace,
        taskQueue,
      });
    },

    async listAllOrphans(opts: { ensemble?: string; force?: boolean } = {}) {
      // Lazy import — `reconcile/orphans` pulls validation/visibility
      // helpers we don't need on every TempoClient consumer.
      const { listAllOrphansCached } = await import('../reconcile/orphans');
      return listAllOrphansCached(client, {
        force: Boolean(opts.force),
        ...(opts.ensemble ? { ensemble: opts.ensemble } : {}),
      });
    },

    async recall(ensemble, playerId) {
      // #128: direct session queries, no maestro round-trip. Throws rather
      // than returning empties so the CLI / TUI wrappers can surface a
      // clean "session not found" error instead of rendering a silently
      // empty timeline that looks indistinguishable from "no messages yet."
      const target = await resolveSession(client, ensemble, playerId);
      if (!target) throw new Error(`No session found with name "${playerId}" in ensemble "${ensemble}".`);
      // #433: unbounded — justified, `recall()` is an explicit MCP tool
      // action invoked on user demand ("recall messages for X"). Not
      // reachable from `buildEnsembleSnapshot` (snapshot's per-player
      // wire-meta uses bounded `getMessagingStateQuery` for counters
      // only, never the full message list).
      const [received, sent] = await Promise.all([
        target.query<Message[]>('allMessages'),
        target.query<SentMessage[]>('allSentMessages'),
      ]);
      return { received, sent };
    },

    async disbandEnsemble(ensemble: string): Promise<{ terminated: number }> {
      let terminated = 0;

      // Terminate all session workflows in the ensemble
      const sessionQuery = `WorkflowType = "agentSessionWorkflow" AND ExecutionStatus = "Running" AND AgentTempoEnsemble = "${sanitizeQueryValue(ensemble)}"`;
      for await (const wf of listWorkflows({ query: sessionQuery })) {
        try {
          const h = handle(wf.workflowId);
          await h.terminate('disbanded via TUI');
          terminated++;
        } catch { /* already closed */ }
      }

      // Terminate scheduler workflow
      try {
        const h = handle(schedulerWorkflowId(ensemble));
        await h.terminate('disbanded via TUI');
        terminated++;
      } catch { /* no scheduler or already closed */ }

      // Terminate per-ensemble maestro workflow
      try {
        const h = handle(maestroWorkflowId(ensemble));
        await h.terminate('disbanded via TUI');
        terminated++;
      } catch { /* no maestro or already closed */ }

      return { terminated };
    },

    async isConnected(): Promise<boolean> {
      try {
        // Lightweight check: list with limit 1
        const query = 'ExecutionStatus = "Running"';
        for await (const _ of listWorkflows({ query })) {
          return true;
        }
        return true; // Connected but no workflows
      } catch {
        return false;
      }
    },

    async getSchedules(ensemble: string): Promise<ScheduleEntry[]> {
      try {
        const h = handle(schedulerWorkflowId(ensemble));
        // Issue #433 — bound the scheduler query so a wedged scheduler
        // worker can't hang `getSchedules` (called from snapshot fan-out
        // and aggregate poll). Existing catch maps any failure to `[]`.
        return await queryHandleWithTimeout<ScheduleEntry[]>(h, 'getSchedules');
      } catch {
        return [];
      }
    },

    async cancelSchedule(ensemble: string, name: string): Promise<void> {
      const h = handle(schedulerWorkflowId(ensemble));
      await h.signal('removeSchedule', name);
    },

    async getEnsembleChat(ensemble: string, offset?: number, limit?: number): Promise<EnsembleChatResult> {
      try {
        const h = handle(maestroWorkflowId(ensemble));
        // Issue #433 — bound the maestro chat query so a wedged maestro
        // worker can't hang `getEnsembleChat` (called from snapshot
        // fan-out and aggregate poll). Existing catch maps any failure
        // to an empty chat result. Note: dedup keys on workflowId+name
        // only, so concurrent snapshot+aggregate calls with different
        // (offset, limit) pairs share a result — the wider window is a
        // superset of the narrower so this is safe (see helper JSDoc).
        return await queryHandleWithTimeout<EnsembleChatResult, [{ offset?: number; limit?: number }]>(
          h,
          'maestroEnsembleChat',
          { args: [{ offset, limit }] },
        );
      } catch {
        return { messages: [], total: 0, hasMore: false, hasConductor: false };
      }
    },

    async isMaestroPaused(ensemble: string): Promise<boolean> {
      // Reads the same `maestroPaused` query that `listEnsembles` uses for
      // the home-view classification. Treat hub-not-running as "not paused"
      // — bare ensembles without a maestro hub aren't displaying any
      // pause-related state in the chat view either.
      try {
        // Issue #433 — bound the maestro query so a wedged maestro worker
        // can't hang `isMaestroPaused` (called from `buildEnsembleSnapshot`
        // on every `/v1/state/:ensemble` request and aggregate tick).
        // Existing `catch` maps any failure to `false` (not paused).
        const paused = await queryHandleWithTimeout(
          handle(maestroWorkflowId(ensemble)),
          maestroPausedQuery,
        );
        return !!paused;
      } catch {
        return false;
      }
    },

    async getAnswer(ensemble: string, questionId: string): Promise<AnswerEntry | null> {
      // #700 P2 — read a parked Q&A answer from the maestro mailbox. Used by
      // both the daemon `GET /v1/ensembles/:e/answer/:id` route and the
      // aggregate's outstanding-ask poll. Hub-not-running / not-yet-answered →
      // null (mirrors isMaestroPaused's tolerant catch).
      //
      // Deliberately NOT `queryHandleWithTimeout`: its in-flight dedup is keyed
      // by (workflowId, queryName) and is ARG-BLIND, so concurrent getAnswer
      // calls for DIFFERENT questionIds (route vs aggregate poll) would collide
      // and cross-return. Run a direct bounded query instead.
      try {
        const h = handle(maestroWorkflowId(ensemble));
        const result = await Promise.race<AnswerEntry | null>([
          h.query(maestroGetAnswerQuery, questionId),
          new Promise<never>((_, reject) => {
            const t = setTimeout(
              () => reject(new Error(`getAnswer query timeout (${DEFAULT_QUERY_TIMEOUT_MS}ms)`)),
              DEFAULT_QUERY_TIMEOUT_MS,
            );
            t.unref?.();
          }),
        ]);
        return result ?? null;
      } catch {
        return null;
      }
    },

    async coatCheckPut(ensemble: string, input: CoatCheckPutInput): Promise<CoatCheckPutResult> {
      // #713 — thin wrapper over the maestro `coatCheckPut` Update so the daemon
      // HTTP route can stash on behalf of the inbox-less command-center planner.
      // Errors PROPAGATE (unlike getAnswer's tolerant catch): the workflow's
      // structured `CoatCheckSlotsFull` / `CoatCheckEntryTooLarge` failures must
      // reach the HTTP layer so it can map them to a 4xx instead of swallowing.
      const h = handle(maestroWorkflowId(ensemble));
      return await h.executeUpdate(coatCheckPutUpdate, { args: [input] });
    },

    async coatCheckGet(ensemble: string, input: CoatCheckGetInput): Promise<CoatCheckEntry | null> {
      // #713 — redeem a ticket over the maestro `coatCheckGet` Update. `null` is
      // the workflow's normal "missing / expired / evicted" return (not an
      // error); genuine failures propagate to the HTTP layer.
      const h = handle(maestroWorkflowId(ensemble));
      return await h.executeUpdate(coatCheckGetUpdate, { args: [input] });
    },

    async isAnySessionHeld(ensemble: string): Promise<boolean> {
      // Scan the ensemble's sessions and check the per-session
      // `outboxLocked` query. The maestro session is skipped — it's the
      // TUI's own dashboard attachment, not a peer agent that the user-
      // facing `/go` should target. Per-session query failures are
      // treated as "not held" so a single flaky workflow doesn't make
      // the whole ensemble appear held forever.
      try {
        const sessions = await scanEnsembleSessions(client, ensemble);
        for (const s of sessions) {
          if (s.playerId === 'maestro') continue;
          try {
            const sh = handle(s.workflowId);
            // Issue #433 — bound the per-session query so a wedged worker
            // can't hang `isAnySessionHeld` (called from
            // `buildEnsembleSnapshot` on every snapshot fan-out). Without
            // this, the first hung session blocks every subsequent
            // session and the entire `held` field of the snapshot.
            const locked = await queryHandleWithTimeout(sh, outboxLockedQuery);
            if (locked) return true;
          } catch {
            // Old workflow without `outboxLocked` query, terminated
            // mid-scan, or wedged-worker timeout (#433) — skip this
            // session, keep checking the rest.
          }
        }
        return false;
      } catch {
        return false;
      }
    },

    async getGates(ensemble: string): Promise<QualityGate[]> {
      // Gates are stored on the conductor's workflow
      try {
        const h = handle(conductorWorkflowId(ensemble));
        // #433: unbounded — justified, `getGates` is not reachable from
        // `buildEnsembleSnapshot` (snapshot doesn't surface gates).
        // Called by `gates` MCP tool / dashboard quality-gate panel on
        // explicit fetch.
        return await h.query('qualityGates');
      } catch {
        return [];
      }
    },

    async getStages(ensemble: string): Promise<StageEntry[]> {
      try {
        const h = handle(conductorWorkflowId(ensemble));
        // #433: unbounded — justified, `getStages` is not reachable from
        // `buildEnsembleSnapshot` (snapshot doesn't surface stages).
        // Called by `stages` MCP tool on explicit fetch.
        return await h.query('stages');
      } catch {
        return [];
      }
    },

    async getWorktrees(ensemble: string): Promise<WorktreeEntry[]> {
      try {
        const h = handle(conductorWorkflowId(ensemble));
        // #433: unbounded — justified, `getWorktrees` is not reachable
        // from `buildEnsembleSnapshot` (snapshot doesn't surface
        // worktrees). Called by `worktree` MCP tool on explicit fetch.
        return await h.query('worktrees');
      } catch {
        return [];
      }
    },

    async hasGlobalMaestro(): Promise<boolean> {
      try {
        const h = handle(globalMaestroId);
        const desc = await h.describe();
        return desc.status.name === 'RUNNING';
      } catch {
        return false;
      }
    },

    async ensembleExists(ensemble): Promise<boolean> {
      // #673 — STRONGLY-CONSISTENT existence check. `describe()` the per-ensemble
      // maestro HUB (started at `up`/creation via `ensureMaestroWorkflow`) — it
      // reflects a just-started workflow IMMEDIATELY, unlike `listEnsembles`
      // (Temporal visibility, eventually consistent on Cloud). Only RUNNING
      // counts as "exists": a TERMINATED/COMPLETED hub (destroyed ensemble) → false,
      // and a never-created hub throws WorkflowNotFoundError → false.
      try {
        const desc = await handle(maestroWorkflowId(ensemble)).describe();
        return desc.status.name === 'RUNNING';
      } catch {
        return false;
      }
    },

    // ── Maestro session (TUI-owned workflow for two-way messaging) ──

    async ensureMaestroSession(ensemble: string): Promise<string> {
      const workflowId = sessionWorkflowId(ensemble, 'maestro');

      const sessionInput = {
        metadata: {
          playerId: 'maestro',
          ensemble,
          hostname: 'dashboard',
          workDir: process.cwd(),
          isConductor: false,
          agentType: 'claude',
          playerType: 'maestro',
          playerTypeDescription: 'TUI dashboard — human operator interface',
        },
        part: 'Dashboard interface (human operator)',
        disableStaleDetection: true,
      };

      try {
        const wfHandle = await client.workflow.start('agentSessionWorkflow', {
          workflowId,
          taskQueue: 'agent-tempo',
          args: [sessionInput],
          workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
          workflowExecutionTimeout: '24 hours',
          // T0.5 (#747) — PlayerType rides the memo, not a search attribute
          // (fresh namespaces register only the 5 filter SAs).
          searchAttributes: {
            AgentTempoHostname: ['dashboard'],
            AgentTempoEnsemble: [ensemble],
            AgentTempoPlayerId: ['maestro'],
          },
          memo: {
            AgentTempoPlayerType: 'maestro',
            AgentTempoIsConductor: false,
            AgentTempoPart: sessionInput.part,
          },
        });
        console.error(`[tui:client] Maestro session started: ${wfHandle.workflowId}`);

        // Also ensure the per-ensemble Maestro hub workflow exists.
        // Without this, getEnsembleChat returns empty when the hub wasn't
        // previously created by a CLI command.
        const maestroHubId = maestroWorkflowId(ensemble);
        try {
          await client.workflow.start('agentMaestroWorkflow', {
            workflowId: maestroHubId,
            taskQueue: 'agent-tempo',
            args: [{ ensemble }],
            workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
            searchAttributes: {
              AgentTempoEnsemble: [ensemble],
            },
          });
          console.error(`[tui:client] Maestro hub ensured: ${maestroHubId}`);
        } catch {
          // Maestro hub is non-critical — log but don't fail
          console.error(`[tui:client] Maestro hub start skipped (may already exist): ${maestroHubId}`);
        }

        return wfHandle.workflowId;
      } catch (err) {
        console.error('[tui:client] Failed to start maestro session:', err);
        throw err;
      }
    },

    async sendAsMaestro(ensemble: string, targetPlayer: string, text: string): Promise<void> {
      // Resolve target player workflow via search attributes
      const query = `WorkflowType = "agentSessionWorkflow" AND ExecutionStatus = "Running" AND AgentTempoEnsemble = "${sanitizeQueryValue(ensemble)}" AND AgentTempoPlayerId = "${sanitizeQueryValue(targetPlayer)}"`;
      let targetHandle;
      for await (const wf of listWorkflows({ query })) {
        targetHandle = handle(wf.workflowId);
        break;
      }
      if (!targetHandle) {
        throw new Error(`Player "${targetPlayer}" not found in ensemble "${ensemble}"`);
      }

      // Signal the target with the message
      await targetHandle.signal('receiveMessage', { from: 'maestro', text, isMaestro: true });

      // Record outbound on maestro's own workflow
      const maestroId = sessionWorkflowId(ensemble, 'maestro');
      try {
        const maestroHandle = handle(maestroId);
        await maestroHandle.signal('recordSentMessage', { to: targetPlayer, text });
      } catch {
        // Best-effort — maestro workflow may not exist yet
      }
    },

    async getMaestroMessages(ensemble: string): Promise<{ received: Message[]; sent: SentMessage[] }> {
      const maestroId = sessionWorkflowId(ensemble, 'maestro');
      try {
        const h = handle(maestroId);

        // #433: unbounded (3× below) — justified, `getMaestroMessages`
        // is not reachable from `buildEnsembleSnapshot` (snapshot
        // surfaces ensemble-level chat via the bounded `getEnsembleChat`,
        // not the maestro session's per-message log). Called on explicit
        // operator fetch from the MCP `recall`/CLI inspect surfaces.

        // Query received messages (allMessages preferred, pendingMessages fallback)
        let received: Message[];
        try {
          received = await h.query('allMessages');
        } catch {
          received = await h.query('pendingMessages');
        }

        // Auto-mark undelivered messages as delivered (maestro has no listener)
        const undeliveredIds = received.filter(m => !m.delivered).map(m => m.id);
        if (undeliveredIds.length > 0) {
          try {
            await h.signal('markDelivered', undeliveredIds);
          } catch {
            // Best-effort
          }
        }

        // Query sent messages
        let sent: SentMessage[];
        try {
          sent = await h.query('allSentMessages');
        } catch {
          sent = [];
        }

        return { received, sent };
      } catch {
        return { received: [], sent: [] };
      }
    },
  };
}
