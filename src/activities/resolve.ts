import { Client, WorkflowHandle } from '@temporalio/client';
import { SessionMetadata, AttachmentPhase } from '../types';
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
 * **Deadline (#336/#529):** the visibility iterator is bounded by
 * `VISIBILITY_DEADLINES_MS.resolveSession` (default 10s). On timeout,
 * throws `VisibilityIteratorTimeoutError` rather than returning `null`
 * — silent `null` on a partially-scanned set would be indistinguishable
 * from "definitely not found," producing false "Player not found" errors
 * upstream. Every existing caller wraps this in a try/catch (outbox
 * activities, MCP tools' `defineTool` helper, CLI dev-verbs); the throw
 * propagates as a retryable / user-visible "lookup timed out" rather
 * than the misleading "player not found."
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
      // Re-throw deadline timeouts — callers that wrap us in try/catch
      // already treat unknown throws as a soft "lookup failed" path,
      // and the typed error name makes the failure mode legible in
      // outbox logs / user-facing tool errors.
      if (isVisibilityTimeout(err)) throw err;
      // Workflow may have just completed, or worker is wedged (#433) — skip
    }
  }
  return null;
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
 *   - For v1.8+ runs (memo-complete: `AgentTempoWorkDir` present), the entire
 *     player row is read from the list result (SAs + memo) — **zero**
 *     per-player queries except the BPM `getActivityState` query, which is
 *     intentionally kept per the architect's ruling (deriving BPM from phase
 *     transitions would change the metric's meaning).
 *   - Pre-v1.8 runs (no observation memo) fall back to the legacy per-player
 *     `getMetadata` + `getPart` queries — cost shrinks as old runs cycle out.
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
        const handle = client.workflow.getHandle(workflow.workflowId);
        const phase = getAttachmentPhase(workflow);
        const playerId =
          getSearchAttrString(workflow, 'AgentTempoPlayerId') ?? workflow.workflowId;
        const hostname = getSearchAttrString(workflow, 'AgentTempoHostname') ?? '';

        // v1.8-memo-observation-fields runs carry workDir on the memo — use
        // its presence as the "memo-complete row" discriminator.
        const workDir = getMemoString(workflow, MEMO_KEYS.workDir);
        let row: Omit<EnsembleSessionInfo, 'workflowId' | 'activityCount' | 'lastActivityAt' | 'phase'>;
        if (workDir !== undefined) {
          row = {
            playerId,
            part: getPart(workflow) ?? '',
            hostname,
            workDir,
            gitRoot: getWorkflowMetaString(workflow, MEMO_KEYS.gitRoot),
            gitBranch: getMemoString(workflow, MEMO_KEYS.gitBranch),
            isConductor: getIsConductor(workflow)
              ?? (workflow.workflowId?.endsWith('-conductor') ?? false),
            agentType: getMemoString(workflow, MEMO_KEYS.agentType) || 'claude',
            playerType: getPlayerType(workflow),
          };
        } else {
          // Legacy run (pre-v1.8 memo) — per-player query fallback, bounded
          // (#433). Same two queries the legacy scan used.
          const metadata = await queryHandleWithTimeout<SessionMetadata>(handle, 'getMetadata');
          const part = await queryHandleWithTimeout<string>(handle, 'getPart');
          row = {
            playerId: metadata.playerId,
            part,
            hostname: metadata.hostname,
            workDir: metadata.workDir,
            gitRoot: metadata.gitRoot,
            gitBranch: metadata.gitBranch,
            isConductor: metadata.isConductor,
            agentType: metadata.agentType || 'claude',
            playerType: metadata.playerType,
          };
        }

        // BPM fields filled in below — kept out of the enumeration loop so
        // per-player query latency can't eat the visibility deadline.
        sessions.push({ workflowId: workflow.workflowId, ...row, phase });
      } catch {
        // Workflow may have just completed, or a legacy-fallback query timed
        // out (#433) — skip this row; the next tick fills it in.
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
 * Scan all running session workflows in an ensemble.
 * Returns metadata + part for each session. Shared by the ensemble MCP tool
 * and the Maestro refresh activity.
 *
 * **Deadline (#336/#529):** the iterator is bounded by
 * `VISIBILITY_DEADLINES_MS.scanEnsembleSessions` (default 15s). On
 * timeout, returns the partial result accumulated so far and emits a
 * warn log. This site is **partial-tolerant by design** — the caller
 * (maestro refresh, ensemble MCP tool) treats the result as a
 * best-effort snapshot that the next tick / re-invocation will fill in.
 *
 * T0.1 (#748): this legacy shape is the `costProfile: 'local'` path —
 * byte-identical to pre-#748 behavior. The cloud profile uses
 * {@link scanEnsembleSessionsCloud}.
 */
export async function scanEnsembleSessions(
  client: Client,
  ensemble: string,
  log: (...args: unknown[]) => void = () => {},
): Promise<EnsembleSessionInfo[]> {
  const sessions: EnsembleSessionInfo[] = [];

  try {
    for await (const workflow of iterateWithDeadline(
      client.workflow.list({ query: SESSION_LIST_QUERY }),
      VISIBILITY_DEADLINES_MS.scanEnsembleSessions,
      'scanEnsembleSessions',
    )) {
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
      log(`scanEnsembleSessions: ${err.message} — returning partial (${sessions.length} sessions)`);
    } else {
      throw err;
    }
  }

  return sessions;
}
