import { Client, WorkflowHandle } from '@temporalio/client';
import { SessionMetadata, AttachmentPhase } from '../types';
import { getAttachmentPhase } from '../utils/search-attributes';
import { getActivityStateQuery } from '../workflows/signals';
import { queryHandleWithTimeout } from '../utils/query-timeout';
import {
  iterateWithDeadline,
  isVisibilityTimeout,
  VISIBILITY_DEADLINES_MS,
} from '../utils/visibility-deadline';

/** Shared query for listing running session workflows. */
const SESSION_LIST_QUERY = `WorkflowType = "agentSessionWorkflow" AND ExecutionStatus = "Running"`;

/**
 * Resolve a session by player name.
 * Lists all running session workflows and queries each for metadata.
 * This avoids depending on custom search attributes which are eventually
 * consistent and may be missing or stale.
 *
 * Shared by activity files (outbox, schedule-fire) and the tools layer.
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
