import { Client, WorkflowHandle } from '@temporalio/client';
import { SessionMetadata, AttachmentPhase } from '../types';
import { sessionWorkflowId } from '../config';
import {
  getAttachmentPhase,
  getSearchAttrString,
  getMemoString,
  getWorkflowMetaString,
  getIsConductor,
  getPlayerType,
  getPart,
  sanitizeQueryValue,
  MEMO_KEYS,
} from '../utils/search-attributes';
import { getActivityStateQuery } from '../workflows/signals';
import { queryHandleWithTimeout } from '../utils/query-timeout';
import {
  iterateWithDeadline,
  isVisibilityTimeout,
  VISIBILITY_DEADLINES_MS,
} from '../utils/visibility-deadline';

/**
 * Mode-B describe-by-id timeout (#845). The strongly-consistent
 * `describe()` fallback on `resolveSession`'s not-found branch is a single
 * O(1) RPC; 2s mirrors {@link DEFAULT_QUERY_TIMEOUT_MS} — two orders of
 * magnitude over a healthy describe — so a wedged frontend can't re-hang
 * the outbox loop the visibility deadline (#336/#529) was added to bound.
 */
export const RESOLVE_DESCRIBE_TIMEOUT_MS = 2000;

/** Shared query for listing running session workflows. Exported for the
 *  ensemble-scoped variants in `client/core.ts` (#751). */
export const SESSION_LIST_QUERY = `WorkflowType = "agentSessionWorkflow" AND ExecutionStatus = "Running"`;

/**
 * Resolve a session by player name.
 * Lists all running session workflows and queries each for metadata.
 * This avoids depending on custom search attributes which are eventually
 * consistent and may be missing or stale.
 *
 * Shared by activity files (outbox, schedule-fire) and the tools layer.
 *
 * DECISION-PATH FENCE (#748): this resolver feeds DECISION paths (outbox
 * delivery addressing, schedule fires, tool targets). It must keep its
 * direct per-session `getMetadata` queries — do NOT migrate it to the
 * eventually-consistent SA/memo read path. Observation-only scans belong
 * in `scanEnsembleSessionsCloud`. Enforced by
 * tests/conformance/decision-path-fence.test.ts.
 *
 * **Mode A — deadline truncation (#336/#529):** the visibility iterator is
 * bounded by `VISIBILITY_DEADLINES_MS.resolveSession` (default 10s). On
 * timeout it throws `VisibilityIteratorTimeoutError` rather than returning
 * `null` — silent `null` on a partially-scanned set would be
 * indistinguishable from "definitely not found." The throw is classified
 * **retryable** by the outbox activity (`isRetryableTemporalError`), so
 * Temporal's activity retry policy re-runs the lookup with a fresh
 * deadline rather than collapsing it to a permanent "player not found."
 * Synchronous tool/CLI callers surface it as a distinct "resolution
 * incomplete — retry," never "not found."
 *
 * **Mode B — visibility-index lag (#845):** `list()` can complete normally
 * (no throw) yet miss a freshly-started workflow because the visibility
 * index trails the workflow store (observed live as a 3/8→8/8 roster
 * during post-restart worker warmup). An early-exhausting scan is NOT
 * proof of absence. So on the not-found branch we do **exactly one**
 * strongly-consistent `describe()` against the *derived* workflow id —
 * an O(1) read by primary key that bypasses the lagging index. This is a
 * point lookup, NOT a re-scan: it cannot re-introduce the unbounded-scan
 * hang the deadline guard was added to prevent.
 *
 * **Documented Mode-B limitation:** the derived id
 * `agent-session-{ensemble}-{playerName}` is minted from a player's
 * INITIAL name at spawn; `set_name` does not change the workflow id. So
 * describe-by-derived-id false-negatives for a player that was both
 * RENAMED and is currently index-lagged — it falls back to `null` (looks
 * absent) for that narrow intersection. Accepted by design: it closes the
 * gap for the cold-boot/warmup incident class (nobody renames mid-boot),
 * and a second full re-scan to cover renamed∩lagged would put scan cost on
 * every genuine typo'd-name lookup. See issue #845.
 */
export async function resolveSession(
  client: Client,
  ensemble: string,
  playerName: string,
): Promise<WorkflowHandle | null> {
  for await (const wf of iterateWithDeadline(
    client.workflow.list({ query: SESSION_LIST_QUERY }),
    VISIBILITY_DEADLINES_MS.resolveSession,
    'resolveSession',
  )) {
    try {
      const handle = client.workflow.getHandle(wf.workflowId);
      // Issue #433 — bound the per-session metadata query so a wedged
      // session worker can't hang the entire `resolveSession` lookup.
      // The catch already treats failure as "skip this candidate".
      const metadata: SessionMetadata = await queryHandleWithTimeout<SessionMetadata>(handle, 'getMetadata');
      if (metadata.ensemble === ensemble && metadata.playerId === playerName) {
        return handle;
      }
    } catch (err) {
      // Re-throw deadline timeouts (Mode A) — callers that wrap us in
      // try/catch treat the typed throw as a soft "lookup timed out" path,
      // distinct from the not-found `null` below.
      if (isVisibilityTimeout(err)) throw err;
      // Workflow may have just completed, or worker is wedged (#433) — skip
    }
  }
  // Mode B (#845): the scan completed without a match, but the visibility
  // index may simply be lagging a just-started workflow. One strongly-
  // consistent describe-by-derived-id disambiguates "index lag" from
  // "genuinely absent" without a second scan.
  return resolveByDerivedId(client, ensemble, playerName);
}

/**
 * Mode-B (#845) strongly-consistent fallback for {@link resolveSession}.
 *
 * Reads the session workflow by its *derived* id
 * (`agent-session-{ensemble}-{playerName}`) via a single bounded
 * `describe()` — a primary-key lookup that bypasses the eventually-
 * consistent visibility index. Returns the handle whenever the execution
 * is `RUNNING`; otherwise `null` (genuinely absent, terminated/completed,
 * renamed-false-negative, or describe timed out).
 *
 * Deliberately RUNNING-only — NO attachment-phase filter (#845 JC2): a
 * `gone` player has a LIVE workflow with a terminal adapter, which the
 * #822/#834 deliverability contract handles as warn-but-queue, not
 * "not found". Filtering it here would regress #834 for the lagged-gone
 * window and diverge from the main scan loop (which has no phase filter).
 */
async function resolveByDerivedId(
  client: Client,
  ensemble: string,
  playerName: string,
): Promise<WorkflowHandle | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    // `getHandle` is a lazy, no-RPC handle construction in the real client;
    // kept inside the try purely so a defensive throw can never escape the
    // fallback (it must only ever upgrade a null to a handle, never error).
    const handle = client.workflow.getHandle(sessionWorkflowId(ensemble, playerName));
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('describe-by-id timed out')),
        RESOLVE_DESCRIBE_TIMEOUT_MS,
      );
      timer.unref?.();
    });
    const desc = await Promise.race([handle.describe(), timeout]);

    // Only a live (RUNNING) execution is a valid resolve target. A
    // COMPLETED/TERMINATED latest run at this id means the player is gone,
    // or the id was reused by a since-closed run → null. A RUNNING run
    // under a reused id is legitimately the current player → return it.
    //
    // No attachment-phase filter (#845 JC2, architect ruling): the main
    // scan loop returns the handle for ANY running session — phase=`gone`
    // included — and #822/#834 treat `gone` as warn-but-QUEUE (the cue
    // durably queues and auto-redelivers on re-attach), NOT "not found".
    // Returning null for a lagged-`gone` player would bypass #822, re-
    // introduce the false-not-found #834 fixed, and make resolution depend
    // on visibility-index timing. The "don't deliver to a torn-down
    // adapter" concern lives at the deliverability layer, not here.
    if (desc.status.name !== 'RUNNING') return null;
    return handle;
  } catch {
    // NotFound → genuinely absent (or the renamed∩lagged false-negative
    // documented on resolveSession). Timeout/other → treat as absent; the
    // caller's not-found path (or the activity retry policy for Mode A)
    // handles it. We never throw from the fallback — it can only upgrade a
    // null to a found handle, never turn a clean lookup into an error.
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Info returned for each session by scanEnsembleSessions. */
export interface EnsembleSessionInfo {
  workflowId: string;
  playerId: string;
  part: string;
  hostname: string;
  workDir: string;
  gitRoot?: string;
  gitBranch?: string;
  isConductor: boolean;
  agentType: string;
  playerType?: string;
  /**
   * Attachment phase read from the `AgentTempoAttachmentState` search attribute.
   * May be undefined for older workflows that predate the attachment lifecycle,
   * or transiently while search attributes propagate.
   */
  phase?: AttachmentPhase;
  /**
   * #399 W1+W2 — monotonic message-activity counter from the session's
   * `getActivityState` query (introduced in W2). Undefined when the
   * session predates W2 or the query failed.
   */
  activityCount?: number;
  /**
   * #399 W1+W2 — ISO timestamp of the last activity-counter bump on the
   * session. Undefined when the session predates W2 or the query failed.
   */
  lastActivityAt?: string;
}

/**
 * T0.1 (#748) — cloud-profile ensemble scan. Observation path ONLY (see the
 * DECISION-PATH FENCE on {@link resolveSession}).
 *
 * Differences vs the legacy {@link scanEnsembleSessions}:
 *   - The visibility query is **ensemble-scoped** via the `AgentTempoEnsemble`
 *     filter SA — no more cluster-wide list + per-session `getMetadata`
 *     pre-filtering (the unfiltered scan was the dominant idle-burn driver).
 *   - The entire player row is read from the list result (SAs + memo) —
 *     **zero** per-player queries except the BPM `getActivityState` query,
 *     which is intentionally kept per the architect's ruling (deriving BPM
 *     from phase transitions would change the metric's meaning). Every 2.0
 *     session seeds the observation memo at workflow start (T0.5 #747 /
 *     #757), so `AgentTempoWorkDir` is always present; the pre-v1.8 memo-
 *     absent per-player `getMetadata`/`getPart` fallback was removed in #874.
 *
 * Staleness: SA/memo reads are eventually consistent (tens of seconds worst
 * case under backlog) — acceptable for the observation path per the design
 * addendum §B; the aggregate's confirm-on-change hook re-validates phase
 * transitions with a direct query before emitting SSE events.
 */
export async function scanEnsembleSessionsCloud(
  client: Client,
  ensemble: string,
  log: (...args: unknown[]) => void = () => {},
): Promise<EnsembleSessionInfo[]> {
  const sessions: EnsembleSessionInfo[] = [];
  const query =
    `${SESSION_LIST_QUERY} AND AgentTempoEnsemble = "${sanitizeQueryValue(ensemble)}"`;

  try {
    for await (const workflow of iterateWithDeadline(
      client.workflow.list({ query }),
      VISIBILITY_DEADLINES_MS.scanEnsembleSessions,
      'scanEnsembleSessionsCloud',
    )) {
      try {
        const phase = getAttachmentPhase(workflow);
        const playerId =
          getSearchAttrString(workflow, 'AgentTempoPlayerId') ?? workflow.workflowId;
        const hostname = getSearchAttrString(workflow, 'AgentTempoHostname') ?? '';

        // Every 2.0 session seeds the observation memo at workflow start
        // (T0.5 #747 / #757), so the entire player row is read straight from
        // the visibility list result — SAs + memo, zero per-player queries
        // (the parallel BPM `getActivityState` query below aside). The
        // pre-v1.8 memo-absent `getMetadata`/`getPart` fallback was removed
        // in #874 (dead under the 2.0 clean cutover).
        const row: Omit<EnsembleSessionInfo, 'workflowId' | 'activityCount' | 'lastActivityAt' | 'phase'> = {
          playerId,
          part: getPart(workflow) ?? '',
          hostname,
          workDir: getMemoString(workflow, MEMO_KEYS.workDir) ?? '',
          gitRoot: getWorkflowMetaString(workflow, MEMO_KEYS.gitRoot),
          gitBranch: getMemoString(workflow, MEMO_KEYS.gitBranch),
          isConductor: getIsConductor(workflow)
            ?? (workflow.workflowId?.endsWith('-conductor') ?? false),
          agentType: getMemoString(workflow, MEMO_KEYS.agentType) || 'claude',
          playerType: getPlayerType(workflow),
        };

        // BPM fields filled in below — kept out of the enumeration loop so
        // per-player query latency can't eat the visibility deadline.
        sessions.push({ workflowId: workflow.workflowId, ...row, phase });
      } catch {
        // Workflow may have just completed (its memo/SA row vanished mid-scan)
        // — skip this row; the next tick fills it in.
      }
    }
  } catch (err) {
    if (isVisibilityTimeout(err)) {
      log(`scanEnsembleSessionsCloud: ${err.message} — returning partial (${sessions.length} sessions)`);
    } else {
      throw err;
    }
  }

  // BPM source — kept as a direct per-player query at the stretched cadence
  // (architect's ruling; see design addendum §C(b)). Fired in PARALLEL after
  // enumeration: same query count, but N bounded queries (≤2s each) overlap
  // instead of stacking sequentially against the scan's wall clock.
  // Best-effort per player — a wedged session contributes zero tempo.
  await Promise.all(sessions.map(async (s) => {
    try {
      const activity = await queryHandleWithTimeout(
        client.workflow.getHandle(s.workflowId),
        getActivityStateQuery,
      );
      s.activityCount = activity.activityCount;
      s.lastActivityAt = activity.lastActivityAt;
    } catch {
      // Session predates W2 or worker wedged — contributes zero tempo.
    }
  }));

  return sessions;
}

/**
 * Result of {@link scanEnsembleSessionsWithStatus} — the session rows plus
 * whether the visibility scan completed or was cut short (#845).
 *
 * `truncated` is the Mode-A signal: a `VisibilityIteratorTimeoutError`
 * fired (the wall-clock deadline tripped mid-scan), so `sessions` is a
 * partial snapshot, NOT the full roster. Callers that render a roster (the
 * `ensemble` tool) MUST surface this so a partial set is never mistaken
 * for a complete one. NOTE: this does NOT cover Mode B (visibility-index
 * lag) — there the scan completes normally and `truncated` is `false` even
 * though a freshly-started workflow may be missing; that's best-effort by
 * design and self-heals on the next tick.
 *
 * `scanned` is the number of running workflows the iterator visited before
 * completing or timing out — useful for warn logs ("partial: 3 of ≥N").
 */
export interface EnsembleScanResult {
  sessions: EnsembleSessionInfo[];
  truncated: boolean;
  scanned: number;
}

/**
 * Scan all running session workflows in an ensemble, reporting whether the
 * scan completed or was truncated by the visibility deadline (#845).
 *
 * This is the single source of truth for the local-profile ensemble scan;
 * {@link scanEnsembleSessions} is a thin array-facade over it that drops
 * the status fields for the many callers that don't need them.
 *
 * **Deadline (#336/#529):** the iterator is bounded by
 * `VISIBILITY_DEADLINES_MS.scanEnsembleSessions` (default 15s). On timeout
 * the accumulated rows are returned with `truncated: true` and a warn log
 * — the scan is **partial-tolerant by design**, but the truncation is now
 * SIGNALLED rather than silent so a roster renderer can flag it.
 *
 * T0.1 (#748): this legacy shape is the `costProfile: 'local'` path —
 * byte-identical row data to pre-#748 behavior. The cloud profile uses
 * {@link scanEnsembleSessionsCloud}.
 */
export async function scanEnsembleSessionsWithStatus(
  client: Client,
  ensemble: string,
  log: (...args: unknown[]) => void = () => {},
): Promise<EnsembleScanResult> {
  const sessions: EnsembleSessionInfo[] = [];
  let truncated = false;
  let scanned = 0;

  try {
    for await (const workflow of iterateWithDeadline(
      client.workflow.list({ query: SESSION_LIST_QUERY }),
      VISIBILITY_DEADLINES_MS.scanEnsembleSessions,
      'scanEnsembleSessions',
    )) {
      scanned++;
      try {
        const handle = client.workflow.getHandle(workflow.workflowId);
        // Issue #433 — bound the metadata + part queries so a single wedged
        // session worker can't hang the entire ensemble scan. Outer
        // try/catch treats any failure as "skip this row", so timeouts
        // produce a partial-but-progressing scan instead of a stalled one.
        const metadata: SessionMetadata = await queryHandleWithTimeout<SessionMetadata>(handle, 'getMetadata');

        if (metadata.ensemble !== ensemble) continue;

        const part: string = await queryHandleWithTimeout<string>(handle, 'getPart');

        // Attachment phase lives in the `AgentTempoAttachmentState` search
        // attribute (written by the workflow on every phase transition).
        const phase = getAttachmentPhase(workflow);

        // #399 W1+W2 — best-effort fetch of the session's monotonic
        // activity counter. Wrapped in its own try/catch so a session
        // predating W2 (no `getActivityState` query handler) doesn't
        // disqualify the whole row. #433 — also timeout-bounded so a
        // wedged W2 query handler doesn't stall the scan.
        let activityCount: number | undefined;
        let lastActivityAt: string | undefined;
        try {
          const activity = await queryHandleWithTimeout(handle, getActivityStateQuery);
          activityCount = activity.activityCount;
          lastActivityAt = activity.lastActivityAt;
        } catch {
          // Session predates W2 or the query is otherwise unavailable —
          // leave both fields undefined so the maestro contributes zero
          // to the tempo bucket for this player this cycle.
        }

        sessions.push({
          workflowId: workflow.workflowId,
          playerId: metadata.playerId,
          part,
          hostname: metadata.hostname,
          workDir: metadata.workDir,
          gitRoot: metadata.gitRoot,
          gitBranch: metadata.gitBranch,
          isConductor: metadata.isConductor,
          agentType: metadata.agentType || 'claude',
          playerType: metadata.playerType,
          phase,
          activityCount,
          lastActivityAt,
        });
      } catch {
        // Workflow may have just completed — skip it
      }
    }
  } catch (err) {
    if (isVisibilityTimeout(err)) {
      truncated = true;
      log(`scanEnsembleSessions: ${err.message} — returning partial (${sessions.length} sessions)`);
    } else {
      throw err;
    }
  }

  return { sessions, truncated, scanned };
}

/**
 * Scan all running session workflows in an ensemble — array facade over
 * {@link scanEnsembleSessionsWithStatus}.
 *
 * Returns just the session rows; the truncation/scan-status fields are
 * dropped. This is the byte-identical shape the maestro refresh activity,
 * the #785 upgrade-snapshot, and the other roster consumers already depend
 * on — keeping it a thin delegate means the truncation-signalling work
 * (#845) does NOT ripple through those call sites. Callers that need to
 * know whether the scan was complete (the `ensemble` tool) call the rich
 * sibling directly.
 */
export async function scanEnsembleSessions(
  client: Client,
  ensemble: string,
  log: (...args: unknown[]) => void = () => {},
): Promise<EnsembleSessionInfo[]> {
  return (await scanEnsembleSessionsWithStatus(client, ensemble, log)).sessions;
}
