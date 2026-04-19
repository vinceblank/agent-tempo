import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client, WorkflowHandle } from '@temporalio/client';
import { Config } from '../config';
import { WorktreeEntry } from '../types';
import { resolveSession } from './resolve';
import { submitOutboxUpdate } from '../workflows/signals';
import { defineTool, ok, fail, formatError } from './helpers';
import { createWorktree, installDependencies, removeWorktree } from '../utils/worktree';
import { PLAYER_NAME_MAX } from '../utils/validation';

export function registerWorktreeTool(
  server: McpServer,
  client: Client,
  config: Config,
  handle: WorkflowHandle,
  getPlayerId: () => string,
) {
  defineTool(
    server,
    'worktree',
    'Manage git worktrees for player isolation. Conductor only. Actions: create (provision worktree for a player), remove (clean up), list (show active worktrees).',
    {
      action: z.enum(['create', 'remove', 'list']).describe('Action to perform'),
      player: z.string().max(PLAYER_NAME_MAX).optional().describe('Player name (required for create/remove)'),
      branch: z.string().optional().describe('Git branch for the worktree (defaults to {ensemble}/{player-name})'),
    },
    async (args) => {
      const { action, player, branch } = args as {
        action: 'create' | 'remove' | 'list';
        player?: string;
        branch?: string;
      };

      try {
        switch (action) {
          case 'create': {
            if (!player) {
              return fail('`player` is required for create action.');
            }

            // Verify player exists
            const targetHandle = await resolveSession(client, config.ensemble, player);
            if (!targetHandle) {
              return fail(`No active session found for "${player}".`);
            }

            // Check target is on same host (cross-machine worktrees not supported)
            const targetMeta = await targetHandle.query('getMetadata') as { hostname?: string };
            const { hostname } = await import('os').then((os) => ({ hostname: os.hostname() }));
            if (targetMeta.hostname && targetMeta.hostname !== hostname) {
              return fail(`Cannot create worktree for "${player}" — they are on host "${targetMeta.hostname}" but worktrees must be created locally.`);
            }

            const gitRoot = process.cwd();
            const result = createWorktree({
              gitRoot,
              ensemble: config.ensemble,
              playerName: player,
              branch,
            });

            if (result.created) {
              installDependencies(result.path);
            }

            // Record in conductor's worktree state
            const entry: WorktreeEntry = {
              player,
              path: result.path,
              branch: result.branch,
              gitRoot,
              createdAt: new Date().toISOString(),
              createdBy: getPlayerId(),
            };
            await handle.signal('setWorktree', entry);

            // Auto-cue the player with worktree info
            const cueMessage = [
              `\u{1f33f} **Worktree ready** for your task:`,
              `- **Path**: \`${result.path}\``,
              `- **Branch**: \`${result.branch}\``,
              '',
              `Run \`cd ${result.path}\` to switch to your isolated workspace.`,
              `All your changes will be on branch \`${result.branch}\`.`,
              `When done, commit and push \u2014 the conductor will handle cleanup.`,
            ].join('\n');

            await handle.executeUpdate(submitOutboxUpdate, {
              args: [{
                type: 'cue' as const,
                targetPlayerId: player,
                message: cueMessage,
              }],
            });

            // #261: when we reused an existing worktree directory, surface the
            // actual state transition (same branch / switched / created-from-main)
            // so the conductor sees ground truth instead of the prior silent
            // "reused existing" that implied the worktree was already on the
            // requested branch.
            const createdLabel = result.created
              ? 'new'
              : (() => {
                  switch (result.switched) {
                    case 'same':
                      return `reused existing (already on \`${result.branch}\`)`;
                    case 'switched':
                      return `reused existing (switched to \`${result.branch}\`)`;
                    case 'created-from-main':
                      return `reused existing (created \`${result.branch}\` from origin/main)`;
                    default:
                      return 'reused existing';
                  }
                })();
            return ok(`Worktree created for **${player}**:\n- Path: \`${result.path}\`\n- Branch: \`${result.branch}\`\n- Created: ${createdLabel}\n\nPlayer has been notified.`);
          }

          case 'remove': {
            if (!player) {
              return fail('`player` is required for remove action.');
            }

            // Look up worktree entry from conductor state
            const entries: WorktreeEntry[] = await handle.query('worktrees');
            const entry = entries.find((w) => w.player === player);
            if (!entry) {
              return fail(`No worktree found for player "${player}".`);
            }

            // Remove from disk
            removeWorktree(entry.path);

            // Remove from conductor state
            await handle.signal('removeWorktree', player);

            // Auto-cue the player
            try {
              await handle.executeUpdate(submitOutboxUpdate, {
                args: [{
                  type: 'cue' as const,
                  targetPlayerId: player,
                  message: `Worktree removed. You're back in the shared repository.`,
                }],
              });
            } catch {
              // Player may no longer be active — non-fatal
            }

            return ok(`Worktree for **${player}** removed (branch: \`${entry.branch}\`).`);
          }

          case 'list': {
            const entries: WorktreeEntry[] = await handle.query('worktrees');
            if (entries.length === 0) {
              return ok('No active worktrees.');
            }

            const lines = entries.map((w) =>
              `- **${w.player}**: \`${w.path}\` (branch: \`${w.branch}\`, created: ${w.createdAt} by ${w.createdBy})`,
            );
            return ok(`${entries.length} active worktree${entries.length === 1 ? '' : 's'}:\n${lines.join('\n')}`);
          }
        }
      } catch (err) {
        return fail(`Worktree operation failed: ${formatError(err)}`);
      }
    },
  );
}
