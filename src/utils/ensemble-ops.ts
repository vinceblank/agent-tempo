/**
 * Shared ensemble-scope plumbing for the MCP tool handlers (`pause`, `play`,
 * `shutdown`, `restore`, ensemble-scope `destroy`) and their `TempoClient`
 * counterparts.
 *
 * All of these verbs need the same bits:
 *   1. Toggle the maestro + scheduler pause signals, tolerating "workflow
 *      not running" on each because a bare-bones ensemble may lack either.
 *   2. Fan out a signal (or update) across every session in the ensemble.
 *
 * Inlining these at each call site was pushing the diff past the architect's
 * 500-line budget on PR #287 and bloating every new verb with near-identical
 * try/catch scaffolding. This module is the single source of truth for both
 * layers (tools + TempoClient) so a future signal-name rename or fan-out
 * concurrency tweak only has to change here.
 */
import type { Client } from '@temporalio/client';
import { maestroWorkflowId, schedulerWorkflowId } from '../config';
import { scanEnsembleSessions } from '../activities/resolve';

/**
 * Result of a pause/unpause toggle. Each flag reflects whether the signal
 * was actually delivered — `false` means the workflow wasn't running and
 * the error was swallowed (the common bare-ensemble case).
 */
export interface MaestroSchedulerToggleResult {
  maestro: boolean;
  scheduler: boolean;
}

/** Pause the ensemble's maestro + scheduler. Best-effort on both. */
export async function pauseMaestroAndScheduler(
  client: Client,
  ensemble: string,
): Promise<MaestroSchedulerToggleResult> {
  return toggleMaestroAndScheduler(client, ensemble, true);
}

/** Unpause the ensemble's maestro + scheduler. Best-effort on both. */
export async function unpauseMaestroAndScheduler(
  client: Client,
  ensemble: string,
): Promise<MaestroSchedulerToggleResult> {
  return toggleMaestroAndScheduler(client, ensemble, false);
}

async function toggleMaestroAndScheduler(
  client: Client,
  ensemble: string,
  paused: boolean,
): Promise<MaestroSchedulerToggleResult> {
  // Two independent RPCs — run them in parallel. Each catches its own
  // error so one missing workflow doesn't block the other's state change.
  const [maestro, scheduler] = await Promise.all([
    safeSignal(client, maestroWorkflowId(ensemble), 'maestroSetPaused', paused),
    safeSignal(client, schedulerWorkflowId(ensemble), 'setSchedulerPaused', paused),
  ]);
  return { maestro, scheduler };
}

async function safeSignal(
  client: Client,
  workflowId: string,
  signalName: string,
  payload: unknown,
): Promise<boolean> {
  try {
    await client.workflow.getHandle(workflowId).signal(signalName, payload);
    return true;
  } catch {
    return false;
  }
}

/**
 * Fan-out a signal across every session in the ensemble. Per-session calls
 * run in parallel via `Promise.allSettled` so a slow / failing session
 * doesn't block the others — all Temporal ensembles are inherently
 * unordered at this boundary (each session has its own workflow).
 *
 * `skip(playerId)` lets the caller exclude specific sessions (e.g. the
 * caller's own session) without an extra pass.
 */
export interface FanoutSignalResult {
  sent: number;
  skipped: number;
  failed: number;
  perSession: Array<
    | { playerId: string; workflowId: string; outcome: 'sent' }
    | { playerId: string; workflowId: string; outcome: 'skipped' }
    | { playerId: string; workflowId: string; outcome: 'failed'; error: string }
  >;
}

export async function signalAllSessions(
  client: Client,
  ensemble: string,
  signalName: string,
  payload: unknown,
  opts: { skip?: (playerId: string) => boolean } = {},
): Promise<FanoutSignalResult> {
  const sessions = await scanEnsembleSessions(client, ensemble);
  const shouldSkip = opts.skip ?? (() => false);
  const result: FanoutSignalResult = { sent: 0, skipped: 0, failed: 0, perSession: [] };

  const settled = await Promise.allSettled(
    sessions.map(async (s) => {
      if (shouldSkip(s.playerId)) {
        return { session: s, outcome: 'skipped' as const };
      }
      try {
        await client.workflow.getHandle(s.workflowId).signal(signalName, payload);
        return { session: s, outcome: 'sent' as const };
      } catch (err) {
        return {
          session: s,
          outcome: 'failed' as const,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );

  for (const r of settled) {
    // `Promise.allSettled` only rejects if the mapper itself throws, and
    // the mapper catches all signal errors internally — so every entry
    // here will be `fulfilled`.
    if (r.status !== 'fulfilled') continue;
    const v = r.value;
    if (v.outcome === 'sent') {
      result.sent++;
      result.perSession.push({ playerId: v.session.playerId, workflowId: v.session.workflowId, outcome: 'sent' });
    } else if (v.outcome === 'skipped') {
      result.skipped++;
      result.perSession.push({ playerId: v.session.playerId, workflowId: v.session.workflowId, outcome: 'skipped' });
    } else {
      result.failed++;
      result.perSession.push({ playerId: v.session.playerId, workflowId: v.session.workflowId, outcome: 'failed', error: v.error });
    }
  }
  return result;
}
