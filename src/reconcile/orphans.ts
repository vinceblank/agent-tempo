/**
 * Orphan-session query — shared by `reconcileOnBoot()` in `src/daemon.ts` and
 * the `claude-tempo restore` CLI command (`src/cli/commands.ts`).
 *
 * Design §10.1: a session is an **orphan** when the workflow is `Running` but
 * no adapter process is alive to own its attachment. Two candidate shapes
 * matter:
 *
 *  1. **Active-host sessions** — `ClaudeTempoAttachedHost = local` AND phase
 *     is `attached` / `processing` / `awaiting` / `draining`. The attachment
 *     exists but the adapter process may have died.
 *  2. **Detached-home sessions** — `ClaudeTempoAttachmentState = detached` AND
 *     `ClaudeTempoHostname = local`. No adapter at all; the home host is us.
 *
 * For each candidate we query `attachmentInfo` + `orphanSummary`. If the
 * adapter process is alive (`isAdapterProcessAlive` returns true) we skip —
 * that's the daemon-restarted-under-a-live-adapter case, not an orphan.
 *
 * `isAdapterProcessAlive` is stubbed as `() => false` for v0.25.0-beta.1 per
 * PR-E engineer brief §8 answer 1. No adapter PID file convention exists yet
 * (only the daemon process has `daemon.pid`; Copilot bridges write their own
 * per-session file but Claude Code CLI does not). A conservative always-dead
 * stub is safe: false negatives cost an extra `claimAttachment` attempt,
 * which the caller catches as `AttachmentConflict` and backs off silently
 * (design §10.6). False positives — skipping a session that needs restore —
 * are the worse failure mode.
 */
import type { Client } from '@temporalio/client';
import type { AttachmentInfo, OrphanSummary } from '../types';
import { attachmentInfoQuery, orphanSummaryQuery } from '../workflows/signals';

/**
 * A session workflow observed to be an orphan: the workflow is alive but no
 * adapter is owning its attachment on this host.
 */
export interface OrphanCandidate {
  workflowId: string;
  info: AttachmentInfo;
  summary: OrphanSummary;
}

/** Filter options for {@link queryOrphanedSessions}. */
export interface OrphanQueryFilter {
  /** Local hostname to match against `ClaudeTempoAttachedHost` / `ClaudeTempoHostname`. */
  hostname: string;
  /**
   * When set, override `isAdapterProcessAlive`. Default stub returns `false`
   * (always assume dead, conservative always-restore). Tests pass a custom
   * predicate; production callers omit.
   */
  isAdapterProcessAlive?: (hostname: string, workflowId: string) => boolean;
}

/**
 * Stub per §8 answer 1 — always reports dead. Exported for test wiring even
 * though production callers use the default via {@link queryOrphanedSessions}.
 */
export function isAdapterProcessAliveStub(): boolean {
  return false;
}

/**
 * Escape a value for interpolation into a Temporal visibility query string.
 * Mirrors the helper in `src/client/index.ts`.
 */
function sanitizeQueryValue(value: string): string {
  return value.replace(/["\\\n\r]/g, '');
}

/**
 * Build the visibility-query string matching the §10.1 candidate set for the
 * given hostname. Exposed (rather than inlined) so tests can introspect the
 * query shape without a live Temporal connection.
 */
export function buildOrphanQuery(hostname: string): string {
  const h = sanitizeQueryValue(hostname);
  return (
    `WorkflowType = "claudeSessionWorkflow" ` +
    `AND ExecutionStatus = "Running" ` +
    `AND (` +
      `(ClaudeTempoAttachedHost = "${h}" ` +
        `AND ClaudeTempoAttachmentState IN ("attached","processing","awaiting","draining")) ` +
      `OR ` +
      `(ClaudeTempoAttachmentState = "detached" ` +
        `AND ClaudeTempoHostname = "${h}")` +
    `)`
  );
}

/**
 * Query Temporal for orphan candidates matching the filter. Runs the
 * visibility query, then fetches `attachmentInfo` + `orphanSummary` per
 * candidate. Skips candidates whose adapter process the liveness predicate
 * reports as alive.
 *
 * Defensive: any per-candidate failure (workflow completed between list +
 * query, query handler throws) is logged and the candidate is skipped — the
 * result array always reflects only the candidates that could be fully
 * resolved at query time.
 */
export async function queryOrphanedSessions(
  client: Client,
  filter: OrphanQueryFilter,
  log: (...args: unknown[]) => void = () => {},
): Promise<OrphanCandidate[]> {
  const isAlive = filter.isAdapterProcessAlive ?? isAdapterProcessAliveStub;
  const query = buildOrphanQuery(filter.hostname);

  const orphans: OrphanCandidate[] = [];

  for await (const wf of client.workflow.list({ query })) {
    const handle = client.workflow.getHandle(wf.workflowId);
    try {
      const info = await handle.query(attachmentInfoQuery) as AttachmentInfo;

      // Live adapter — not an orphan.
      if (info.currentAttachment && isAlive(info.currentAttachment.hostname, wf.workflowId)) {
        continue;
      }

      const summary = await handle.query(orphanSummaryQuery) as OrphanSummary;
      orphans.push({ workflowId: wf.workflowId, info, summary });
    } catch (err) {
      // Workflow may have completed between list + query, or a query handler
      // threw. Skip — not every candidate will be reachable, and partial
      // results are acceptable for reconcile (next tick will retry).
      log(`orphan-query skip ${wf.workflowId}:`, err instanceof Error ? err.message : String(err));
    }
  }

  return orphans;
}
