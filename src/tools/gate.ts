/**
 * `gate` — canonical multi-action quality-gate tool (#793 merge, PARTIAL).
 *
 * Merges the two gate-DEFINITION tools (`quality_gate` → define, `gates` → list)
 * into ONE canonical tool. The canonical name is **net-new**, so `action` is
 * REQUIRED.
 *
 * PARTIAL merge: `evaluate_gate` STAYS A SEPARATE TOOL and is NOT folded in.
 * Rationale (brief §3⑤): evaluate is a distinct runtime *operation* — record
 * pass/fail + notes against criteria — not CRUD on the gate *definition*. The
 * define/list-the-gate vs act-on-the-gate line is the partial boundary.
 *
 * Legacy tools stay registered as forwarding aliases ({@link buildGateAliasTools});
 * both paths reuse the legacy handler bodies. Conductor-only (gated in
 * server-tools.ts alongside the other gate/stage tools).
 */
import { z } from 'zod';
import { WorkflowHandle } from '@temporalio/client';
import { fail, type TempoToolDescriptor } from './descriptor';
import { firstMissing } from './action-guard';
import { GATE_TASK_MAX, GATE_CRITERIA_MAX, GATE_CRITERION_TEXT_MAX } from '../utils/validation';
import { buildQualityGateTool } from './quality-gate';
import { buildGatesTool } from './gates';

/**
 * Canonical `gate` tool. Dispatches on `action` (define | list); `evaluate_gate`
 * is intentionally excluded (separate tool).
 */
export function buildGateTool(
  handle: WorkflowHandle,
  getPlayerId: () => string,
): TempoToolDescriptor {
  const define = buildQualityGateTool(handle, getPlayerId);
  const list = buildGatesTool(handle);

  return {
    name: 'gate',
    description:
      'Define and inspect quality gates for a task (conductor only). ' +
      'action="define" sets/replaces a gate (task + criteria); ' +
      'action="list" shows gates and per-criterion status (optional task/status filters). ' +
      'To record pass/fail on criteria, use the separate `evaluate_gate` tool.',
    params: {
      action: z.enum(['define', 'list']).describe('Which gate operation to perform'),
      // define / list (filter):
      task: z.string().max(GATE_TASK_MAX).optional().describe('define: the task this gate guards (required). list: optional task filter.'),
      // define:
      criteria: z.array(z.string().max(GATE_CRITERION_TEXT_MAX)).min(1).max(GATE_CRITERIA_MAX).optional().describe('define: the list of criteria that must pass (required)'),
      // list:
      status: z.enum(['open', 'passed', 'failed']).optional().describe('list: optional status filter'),
    },
    handler: async (args) => {
      const action = args.action as 'define' | 'list';
      switch (action) {
        case 'define': {
          const m = firstMissing(args, ['task', 'criteria']);
          if (m) return fail(`gate action="define" requires "${m}".`);
          return define.handler(args);
        }
        case 'list':
          return list.handler(args);
        default:
          return fail(`Unknown gate action: ${String(action)}. Expected define | list.`);
      }
    },
  };
}

/**
 * Legacy forwarding aliases — `quality_gate` → define, `gates` → list. Each
 * keeps its exact original schema + handler; description gains a deprecation
 * note. Explicit object literals (see §6 drift note).
 */
export function buildGateAliasTools(
  handle: WorkflowHandle,
  getPlayerId: () => string,
): TempoToolDescriptor[] {
  const define = buildQualityGateTool(handle, getPlayerId);
  const list = buildGatesTool(handle);

  return [
    {
      name: 'quality_gate',
      description: 'DEPRECATED — use `gate` with action="define". ' + define.description,
      params: define.params,
      handler: define.handler,
    },
    {
      name: 'gates',
      description: 'DEPRECATED — use `gate` with action="list". ' + list.description,
      params: list.params,
      handler: list.handler,
    },
  ];
}
