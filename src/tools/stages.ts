import { WorkflowHandle } from '@temporalio/client';
import { ok, fail, formatError, type TempoToolDescriptor } from './descriptor';
import type { StageEntry } from '../types';

export function buildStagesTool(
  handle: WorkflowHandle,
): TempoToolDescriptor {
  return {
    name: 'stages',
    description: 'List all pipeline stages and their status. Shows which players have reported, who is still waiting, and stage completion status. Conductor only.',
    params: {},
    handler: async () => {
      try {
        const stages: StageEntry[] = await handle.query('stages');

        if (stages.length === 0) {
          return ok('No stages defined.');
        }

        const lines = stages.map((s) => {
          const statusIcon = s.status === 'complete' ? '\u2714'
            : s.status === 'failed' ? '\u2718'
            : s.status === 'cancelled' ? '\u2212'
            : '\u25CB';

          const playerLines = s.players.map((p) => {
            const pIcon = p.status === 'reported' ? '\u2714'
              : p.status === 'blocked' ? '\u2718'
              : '\u25CB';
            const detail = p.reportedAt ? ` (${p.reportType})` : '';
            return `    ${pIcon} ${p.playerId}${detail}`;
          });

          return [
            `${statusIcon} **${s.name}** [${s.status}] (policy: ${s.failurePolicy})`,
            ...playerLines,
          ].join('\n');
        });

        return ok(lines.join('\n\n'));
      } catch (err) {
        return fail(`Failed to query stages: ${formatError(err)}`);
      }
    },
  };
}
