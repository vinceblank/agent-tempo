import { z } from 'zod';
import { WorkflowHandle } from '@temporalio/client';
import { ok, fail, formatError, type TempoToolDescriptor } from './descriptor';
import { firstMissing } from './action-guard';
import { buildStagesTool } from './stages';
import { buildCancelStageTool } from './cancel-stage';
import { STAGE_NAME_MAX, STAGE_PLAYERS_MAX, PLAYER_NAME_REGEX } from '../utils/validation';

/**
 * Internal create-only descriptor (the legacy bare-`stage` behaviour). Its
 * `.handler` is reused verbatim by the canonical {@link buildStageTool} under
 * `action="create"`. Not exported — the canonical tool is the public surface.
 */
function buildStageCreateTool(
  handle: WorkflowHandle,
  getPlayerId: () => string,
): TempoToolDescriptor {
  return {
    name: 'stage',
    description: 'Create a pipeline stage tracking N players. When all players report, a completion message is auto-injected. Conductor only.',
    params: {
      name: z.string().max(STAGE_NAME_MAX).describe('Unique stage name (e.g. "code-review", "testing")'),
      players: z.array(z.string().regex(PLAYER_NAME_REGEX)).min(1).max(STAGE_PLAYERS_MAX).describe('Player names to track in this stage'),
      failurePolicy: z.enum(['halt', 'continue']).optional().describe('What to do when a player reports a blocker. "halt" (default) fails the stage immediately; "continue" waits for all players.'),
    },
    handler: async (args) => {
      const { name, players, failurePolicy } = args as {
        name: string;
        players: string[];
        failurePolicy?: 'halt' | 'continue';
      };

      try {
        await handle.signal('setStage', {
          name,
          players,
          failurePolicy,
          createdBy: getPlayerId(),
        });

        const playerList = players.map((p) => `  - ${p}`).join('\n');
        return ok(`Stage **${name}** created tracking ${players.length} player(s) [policy: ${failurePolicy || 'halt'}]:\n${playerList}`);
      } catch (err) {
        return fail(`Failed to create stage: ${formatError(err)}`);
      }
    },
  };
}

/**
 * Canonical `stage` tool (#793 merge) — **reused** name, so `action` defaults to
 * `'create'` for backward-compat. Actions: `create | list | cancel` (all CRUD
 * peers on the same StageEntry — see #793 brief §4). Conductor-only (gated in
 * server-tools.ts).
 *
 * The legacy `stages` / `cancel_stage` names stay registered as forwarding
 * aliases ({@link buildStageAliasTools}); there is no alias for `create` — the
 * bare `stage` IS create.
 */
export function buildStageTool(
  handle: WorkflowHandle,
  getPlayerId: () => string,
): TempoToolDescriptor {
  const create = buildStageCreateTool(handle, getPlayerId);
  const list = buildStagesTool(handle);
  const cancel = buildCancelStageTool(handle);

  return {
    name: 'stage',
    description:
      'Track a fan-out/fan-in pipeline stage across N players (conductor only). ' +
      'action="create" (default) opens a stage (name + players[, failurePolicy]); ' +
      'action="list" shows all stages and per-player report status; ' +
      'action="cancel" cancels a named stage.',
    params: {
      action: z.enum(['create', 'list', 'cancel']).optional().describe('Which stage operation to perform (defaults to "create" when omitted)'),
      // create / cancel:
      name: z.string().max(STAGE_NAME_MAX).optional().describe('create/cancel: the stage name'),
      // create:
      players: z.array(z.string().regex(PLAYER_NAME_REGEX)).min(1).max(STAGE_PLAYERS_MAX).optional().describe('create: player names to track in this stage'),
      failurePolicy: z.enum(['halt', 'continue']).optional().describe('create: "halt" (default) fails the stage on a blocker; "continue" waits for all players.'),
    },
    handler: async (args) => {
      const action = (args.action as 'create' | 'list' | 'cancel' | undefined) ?? 'create';
      switch (action) {
        case 'create': {
          const m = firstMissing(args, ['name', 'players']);
          if (m) return fail(`stage action="create" requires "${m}".`);
          return create.handler(args);
        }
        case 'list':
          return list.handler(args);
        case 'cancel': {
          const m = firstMissing(args, ['name']);
          if (m) return fail(`stage action="cancel" requires "${m}".`);
          return cancel.handler(args);
        }
        default:
          return fail(`Unknown stage action: ${String(action)}. Expected create | list | cancel.`);
      }
    },
  };
}

/**
 * Legacy forwarding aliases — `stages` → list, `cancel_stage` → cancel. Each
 * keeps its exact original schema + handler; description gains a deprecation
 * note. No alias for `create` — the bare `stage` IS create. Explicit object
 * literals (see #793 brief §6 drift note).
 */
export function buildStageAliasTools(
  handle: WorkflowHandle,
): TempoToolDescriptor[] {
  const list = buildStagesTool(handle);
  const cancel = buildCancelStageTool(handle);

  return [
    {
      name: 'stages',
      description: 'DEPRECATED — use `stage` with action="list". ' + list.description,
      params: list.params,
      handler: list.handler,
    },
    {
      name: 'cancel_stage',
      description: 'DEPRECATED — use `stage` with action="cancel". ' + cancel.description,
      params: cancel.params,
      handler: cancel.handler,
    },
  ];
}
