/**
 * `destroy` — terminal end of either a single session or the whole ensemble.
 *
 * **Single-player mode (`playerId` present)**: enqueues a `DestroyOutboxEntry`
 * on the caller's workflow outbox. The session workflow's dispatch loop runs
 * the `deliverDestroy` activity on the target, which calls `destroyUpdate` +
 * (optionally) posts a system message on the ensemble conductor via
 * `receiveMessageSignal`.
 *
 * **Ensemble mode (`playerId` omitted, #287)**: walks every peer session via
 * `destroyUpdate` directly (in parallel), then terminates the scheduler +
 * maestro, then destroys the conductor last. Direct `destroyUpdate` calls
 * (not outbox entries) because ensemble teardown is a batch operation with
 * a fixed ordering invariant (conductor sees peer teardown), not
 * cross-workflow traffic that needs the caller's dispatch loop. The caller's
 * own session is skipped — tools can't destroy themselves safely.
 *
 * For graceful shutdown without destroying workflows, use `shutdown` instead.
 */
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client, WorkflowHandle } from '@temporalio/client';
import { Config, maestroWorkflowId, schedulerWorkflowId, conductorWorkflowId } from '../config';
import type { OutboxEntryInput } from '../types';
import { destroyUpdate, submitOutboxUpdate } from '../workflows/signals';
import { scanEnsembleSessions } from '../activities/resolve';
import { defineTool, ok, fail, formatError } from './helpers';
import { PLAYER_NAME_MAX, validatePlayerName } from '../utils/validation';
import type { EnsembleDestroyDetail } from '../client/interface';

const log = (...args: unknown[]) => console.error('[agent-tempo:destroy]', ...args);

export function registerDestroyTool(
  server: McpServer,
  client: Client,
  config: Config,
  getPlayerId: () => string,
  handle: WorkflowHandle,
) {
  defineTool(
    server,
    'destroy',
    'Terminally destroy a session workflow (when `playerId` is given) or the entire ensemble (when omitted): every peer session, the scheduler, the maestro, and the conductor. COMPLETEs workflows and cannot be undone. For graceful reap use `shutdown`; for a clean revive use `restart`.',
    {
      // #306: `.min(1)` rejects `{playerId: ""}` at the SDK boundary so a
      // buggy MCP caller can't silently fall through to ensemble-wide
      // destroy mode. The handler also guards programmatic callers that
      // bypass Zod (see explicit `playerId === ''` rejection below).
      playerId: z.string().min(1).max(PLAYER_NAME_MAX).optional().describe('Target player name. Omit to destroy the entire ensemble.'),
      reason: z.string().max(500).optional().describe('Optional reason recorded in the workflow\'s audit event'),
    },
    async (args) => {
      const { playerId, reason } = args as { playerId?: string; reason?: string };
      const callerId = getPlayerId();

      // #306: defense-in-depth for callers that bypass Zod (test harnesses,
      // direct handler invocation). Zod's `.min(1)` already covers normal
      // MCP traffic; this guard ensures empty-string never falls through to
      // ensemble-wide destroy mode regardless of how the handler is reached.
      if (playerId === '') {
        return fail('`playerId` cannot be an empty string. Omit it to destroy the entire ensemble.');
      }

      // ── Single-player mode (existing behaviour) ─────────────────────────
      if (playerId !== undefined) {
        const nameError = validatePlayerName(playerId);
        if (nameError) return fail(nameError);

        if (playerId === callerId) {
          return fail('Cannot destroy your own session.');
        }

        try {
          const entry: OutboxEntryInput = {
            type: 'destroy',
            targetPlayerId: playerId,
            ...(reason !== undefined ? { reason } : {}),
            notifyConductor: true,
          };
          const entryId = await handle.executeUpdate(submitOutboxUpdate, { args: [entry] });
          return ok(`Destroy queued for **${playerId}**${reason ? ` (reason: ${reason})` : ''}. (outbox: ${entryId})`);
        } catch (err) {
          return fail(`Failed to destroy: ${formatError(err)}`);
        }
      }

      // ── Ensemble-scope mode (#287) ──────────────────────────────────────
      // Order: peer sessions (parallel) → scheduler + maestro (parallel) →
      // conductor last. The conductor-last step is the invariant the
      // architect's spec relies on so the conductor sees every peer
      // teardown before its own destroy.
      try {
        const destroyReason = reason ?? `ensemble destroy via ${callerId}`;
        const sessions = await scanEnsembleSessions(client, config.ensemble);
        const conductorWfId = conductorWorkflowId(config.ensemble);

        const peers: typeof sessions = [];
        let conductorPresent = false;
        for (const s of sessions) {
          if (s.workflowId === conductorWfId) {
            conductorPresent = true;
          } else {
            peers.push(s);
          }
        }

        const details: EnsembleDestroyDetail[] = [];
        let destroyed = 0;
        let terminated = 0;
        let failed = 0;

        // Phase 1: destroy every peer in parallel (conductor excluded). Skip
        // the caller's own session — self-destroy is a no-op guard.
        const peerResults = await Promise.allSettled(
          peers.map(async (s) => {
            if (s.playerId === callerId) return { session: s, outcome: 'skipped-self' as const };
            try {
              await client.workflow.getHandle(s.workflowId).executeUpdate(destroyUpdate, {
                args: [{ reason: destroyReason, terminatedBy: callerId }],
              });
              return { session: s, outcome: 'destroyed' as const };
            } catch (err) {
              return { session: s, outcome: 'failed' as const, error: formatError(err) };
            }
          }),
        );
        for (const r of peerResults) {
          if (r.status !== 'fulfilled') continue;
          const v = r.value;
          if (v.outcome === 'destroyed') {
            details.push({ target: v.session.playerId, outcome: 'destroyed' });
            destroyed++;
          } else if (v.outcome === 'failed') {
            details.push({ target: v.session.playerId, outcome: 'failed', error: v.error });
            failed++;
          }
          // #299: `'skipped-self'` is an internal control-flow tag for the
          // caller's own session — intentionally NOT surfaced in `details`
          // because `EnsembleDestroyDetail` is consumed publicly via
          // `EnsembleDestroySummary` (TempoClient.destroy), which has no
          // caller-self concept. The skip is a bookkeeping no-op here.
        }

        // Phase 2: scheduler + maestro terminate in parallel (non-session
        // workflows — no destroy handler). `terminate` rejects when the
        // workflow isn't running; treat as "not present" instead of failure.
        const [schedRes, maestroRes] = await Promise.allSettled([
          client.workflow.getHandle(schedulerWorkflowId(config.ensemble)).terminate(destroyReason),
          client.workflow.getHandle(maestroWorkflowId(config.ensemble)).terminate(destroyReason),
        ]);
        if (schedRes.status === 'fulfilled') {
          details.push({ target: 'scheduler', outcome: 'terminated' });
          terminated++;
        }
        if (maestroRes.status === 'fulfilled') {
          details.push({ target: 'maestro', outcome: 'terminated' });
          terminated++;
        }

        // Phase 3: conductor last, so it observes peer teardown. Skipped if
        // the caller IS the conductor (same self-destroy guard). #299: the
        // skip is a control-flow no-op — no `details` entry, mirroring the
        // peer-self skip. `EnsembleDestroyDetail.outcome` no longer carries
        // a self-skip member.
        if (callerId === 'conductor') {
          // self-skip; no recording
        } else if (conductorPresent) {
          try {
            await client.workflow.getHandle(conductorWfId).executeUpdate(destroyUpdate, {
              args: [{ reason: destroyReason, terminatedBy: callerId }],
            });
            details.push({ target: 'conductor', outcome: 'destroyed' });
            destroyed++;
          } catch (err) {
            details.push({ target: 'conductor', outcome: 'failed', error: formatError(err) });
            failed++;
          }
        }

        const summaryLine = `${destroyed} destroyed, ${terminated} terminated, ${failed} failed`;
        const headline = failed > 0
          ? `Ensemble **${config.ensemble}** partially destroyed.`
          : `Ensemble **${config.ensemble}** destroyed.`;
        const lines: string[] = [headline, summaryLine];
        const failures = details.filter((d) => d.outcome === 'failed');
        if (failures.length > 0) {
          lines.push(`Errors:\n${failures.map((d) => `  - ${d.target}: ${d.error}`).join('\n')}`);
          // #306 follow-up: surface the indeterminate-state hint from my own
          // PR-#306 holistic review (regression risk #3). `Promise.allSettled`
          // returned `failed` outcomes for these peers — the workflows may
          // be in any state from "still running" to "destroyed but RPC
          // timed out". Re-running `destroy` is safe (idempotent on the
          // workflow side: `destroyUpdate` on a `gone` workflow is a no-op
          // via the `isDestroyedQuery` guard) and the cleanest recovery.
          const noun = failed === 1 ? 'peer' : 'peers';
          lines.push(
            `⚠ ${failed} ${noun} in indeterminate state — ` +
            `run \`/destroy ${config.ensemble}\` again to clean up.`,
          );
        }
        log(`Ensemble destroy by ${callerId}: ${summaryLine}`);
        return ok(lines.join('\n'));
      } catch (err) {
        return fail(`Failed to destroy ensemble: ${formatError(err)}`);
      }
    },
  );
}
