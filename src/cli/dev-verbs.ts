/**
 * Dev-mode scriptable CLI verbs (#432).
 *
 * Five thin shell-scriptable wrappers over the MCP tool surface, available
 * only when `--dev` / `AGENT_TEMPO_DEV_MODE=1` is active. Production CLI
 * was collapsed to TUI/MCP-only in #288; this module restores
 * shell-scriptable access for autonomous E2E validation harnesses without
 * re-introducing the public surface that #288 retired.
 *
 * ## Allowlist discipline
 *
 * `DEV_VERBS` is an explicit `ReadonlySet<string>`, NOT derived from
 * `REMOVED_VERBS` keys. Promoting a removed verb to a dev-mode verb must
 * be a deliberate, code-reviewed action. The mechanical-enforcement test
 * in `test/cli-dev-verbs.test.ts` asserts the DEV_VERBS ↔ REMOVED_VERBS
 * ↔ `cli.ts` switch invariants.
 *
 * ## NOT crash-proof
 *
 * This module touches Temporal directly. It is deliberately excluded from
 * `test/cli-crash-proof-isolation.test.ts`'s `CRASH_PROOF_MODULES` allowlist
 * — dev mode requires Temporal anyway.
 */
import { CliOverrides, maestroWorkflowId } from '../config';
import { resolveSession } from '../activities/resolve';
import { setEnsembleDescriptionSignal } from '../workflows/maestro-signals';
import {
  outboxLockedQuery,
  receiveMessageSignal,
  releaseHeldSignal,
  setPausedSignal,
} from '../workflows/signals';
import {
  pauseMaestroAndScheduler,
  signalAllSessions,
  unpauseMaestroAndScheduler,
} from '../utils/ensemble-ops';
import {
  ENSEMBLE_DESCRIPTION_MAX,
  MESSAGE_MAX,
  validatePlayerName,
} from '../utils/validation';
import { verbClient } from './commands';
import * as out from './output';

/** Allowlist of verbs accepted in dev mode. Single source of truth. */
export const DEV_VERBS: ReadonlySet<string> = new Set([
  'cue',
  'pause',
  'play',
  'release',
  'set-ensemble-description',
]);

/**
 * Subset of {@link import('../cli').ParsedArgs} consumed by the dispatcher.
 * Kept narrow so this module doesn't import `../cli` (would be cyclic).
 */
export interface DevVerbArgs extends CliOverrides {
  /** All non-flag tokens, including `args.positional[0] === args.command`. */
  positional: string[];
  /** Resolved ensemble (positional override / env fallback). */
  ensemble: string;
}

async function cueCommand(args: DevVerbArgs): Promise<void> {
  const playerId = args.positional[1];
  const message = args.positional.slice(2).join(' ');

  if (!playerId || !message) {
    out.error('Usage: agent-tempo --dev cue <player> <message>');
    process.exit(1);
  }

  const nameError = validatePlayerName(playerId);
  if (nameError) {
    out.error(nameError);
    process.exit(1);
  }
  if (message.length > MESSAGE_MAX) {
    out.error(`Message exceeds max length (${MESSAGE_MAX}).`);
    process.exit(1);
  }

  const { connection, client } = await verbClient(args);
  try {
    const handle = await resolveSession(client, args.ensemble, playerId);
    if (!handle) {
      // Throw rather than exit — `connection.close()` in finally must run
      // first; `process.exit()` skips finally blocks.
      throw new Error(`No active session named "${playerId}" in ensemble "${args.ensemble}".`);
    }
    await handle.signal(receiveMessageSignal, { from: 'cli', text: message });
    out.success(`Cued ${playerId}.`);
  } finally {
    await connection.close();
  }
}

async function pauseCommand(args: DevVerbArgs): Promise<void> {
  const { connection, client } = await verbClient(args);
  try {
    const [toggle, sessions] = await Promise.all([
      pauseMaestroAndScheduler(client, args.ensemble),
      signalAllSessions(client, args.ensemble, setPausedSignal.name, true),
    ]);
    out.log(`  ${out.dim('paused')} ${sessions.sent} session${sessions.sent !== 1 ? 's' : ''}`);
    if (toggle.maestro) out.log(`  ${out.dim('paused')} maestro`);
    if (toggle.scheduler) out.log(`  ${out.dim('paused')} scheduler`);
    if (sessions.failed > 0) {
      out.warn(`${sessions.failed} session pause signal${sessions.failed !== 1 ? 's' : ''} failed.`);
    }
    out.success(`Ensemble "${args.ensemble}" paused.`);
  } finally {
    await connection.close();
  }
}

async function playCommand(args: DevVerbArgs): Promise<void> {
  const { connection, client } = await verbClient(args);
  try {
    const [toggle, sessions] = await Promise.all([
      unpauseMaestroAndScheduler(client, args.ensemble),
      signalAllSessions(client, args.ensemble, setPausedSignal.name, false),
    ]);
    out.log(`  ${out.dim('resumed')} ${sessions.sent} session${sessions.sent !== 1 ? 's' : ''}`);
    if (toggle.maestro) out.log(`  ${out.dim('resumed')} maestro`);
    if (toggle.scheduler) out.log(`  ${out.dim('resumed')} scheduler`);
    if (sessions.failed > 0) {
      out.warn(`${sessions.failed} session resume signal${sessions.failed !== 1 ? 's' : ''} failed.`);
    }
    out.success(`Ensemble "${args.ensemble}" resumed.`);
  } finally {
    await connection.close();
  }
}

/**
 * `release [<player>]` — with `<player>`, signals one session directly.
 * Without, scans the ensemble and signals every session whose outbox is
 * currently locked (matches the production `release` semantics in
 * `commands.ts`).
 */
async function releaseCommand(args: DevVerbArgs): Promise<void> {
  const player = args.positional[1];
  const { connection, client } = await verbClient(args);
  try {
    if (player) {
      const nameError = validatePlayerName(player);
      if (nameError) throw new Error(nameError);
      const handle = await resolveSession(client, args.ensemble, player);
      if (!handle) {
        throw new Error(`No active session named "${player}" in ensemble "${args.ensemble}".`);
      }
      await handle.signal(releaseHeldSignal);
      out.success(`Released ${player}.`);
      return;
    }

    // Ensemble-wide — same algorithm as `release()` in commands.ts.
    const sanitized = args.ensemble.replace(/["\\\n\r]/g, '');
    const query = `WorkflowType = "agentSessionWorkflow" AND ExecutionStatus = "Running" AND AgentTempoEnsemble = "${sanitized}"`;
    let released = 0;
    for await (const wf of client.workflow.list({ query })) {
      try {
        const handle = client.workflow.getHandle(wf.workflowId);
        const locked = await handle.query(outboxLockedQuery);
        if (locked) {
          await handle.signal(releaseHeldSignal);
          released++;
          const sa = wf.searchAttributes || {};
          const playerId = Array.isArray(sa.AgentTempoPlayerId) ? String(sa.AgentTempoPlayerId[0]) : wf.workflowId;
          out.log(`  ${out.dim('released')} ${playerId}`);
        }
      } catch {
        // Skip failed queries (terminated workflows, etc.)
      }
    }
    if (released > 0) {
      out.success(`Released ${released} player${released !== 1 ? 's' : ''}.`);
    } else {
      out.log('No held players found.');
    }
  } finally {
    await connection.close();
  }
}

async function setEnsembleDescriptionCommand(args: DevVerbArgs): Promise<void> {
  if (args.positional.length < 2) {
    out.error('Usage: agent-tempo --dev set-ensemble-description "<description>" (use "" to clear)');
    process.exit(1);
  }
  const description = args.positional.slice(1).join(' ');
  if (description.length > ENSEMBLE_DESCRIPTION_MAX) {
    out.error(`Description exceeds max length (${ENSEMBLE_DESCRIPTION_MAX}).`);
    process.exit(1);
  }

  const { connection, client } = await verbClient(args);
  try {
    const handle = client.workflow.getHandle(maestroWorkflowId(args.ensemble));
    await handle.signal(setEnsembleDescriptionSignal.name, description);
    if (description.trim().length === 0) {
      out.success(`Ensemble "${args.ensemble}" description cleared.`);
    } else {
      out.success(`Ensemble "${args.ensemble}" description updated: "${description}"`);
    }
  } finally {
    await connection.close();
  }
}

/**
 * Dispatch a dev-mode verb. Caller (`cli.ts`) gates on `isDevMode()` +
 * `DEV_VERBS.has(verb)` before calling. Throws `Error` for unknown verbs
 * — the mechanical test in `cli-dev-verbs.test.ts` asserts that this
 * is unreachable in practice.
 */
export async function dispatchDevVerb(verb: string, args: DevVerbArgs): Promise<void> {
  switch (verb) {
    case 'cue':
      await cueCommand(args);
      return;
    case 'pause':
      await pauseCommand(args);
      return;
    case 'play':
      await playCommand(args);
      return;
    case 'release':
      await releaseCommand(args);
      return;
    case 'set-ensemble-description':
      await setEnsembleDescriptionCommand(args);
      return;
    default:
      throw new Error(`dispatchDevVerb: unknown dev verb "${verb}" (not in DEV_VERBS allowlist)`);
  }
}
