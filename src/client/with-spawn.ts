/**
 * `TempoClientWithSpawn` — TTY-bound superset of {@link TempoClientCore}.
 *
 * Composes {@link createTempoClientCore} with the two methods that shell
 * out to a local `agent-tempo up …` invocation. **Never import this from
 * the daemon, MCP tools, or the SSE event source** — those contexts have
 * no TTY and a stray spawn would launch a terminal nothing can render.
 *
 * The boundary is enforced by the type system: headless callers depend on
 * `TempoClientCore`; the spawn surface is opt-in.
 *
 * NOTE (#789): the only production opt-in was the deleted Ink TUI (via its
 * `ensure-conductor-spawned` helper). This variant is now orphaned in
 * production — kept compiling pending a follow-up decision on the split.
 *
 * See `docs/adr/0007-tempoclient-core-withspawn-split.md`.
 */
import type { Client } from '@temporalio/client';
import { createTempoClientCore, type CreateTempoClientOpts } from './core';
import type { TempoClientWithSpawn } from './interface';

export type { CreateTempoClientOpts } from './core';

/**
 * Invoke the `agent-tempo` CLI as a child process. The lazy
 * `child_process` import keeps the dependency out of `core.ts` so
 * `TempoClientCore` consumers never pay for it. Shared by the two spawn
 * methods so they have identical process semantics (cwd default,
 * timeout, shell-quoted args).
 */
async function runTempoCli(args: string[], workDir?: string): Promise<void> {
  const { execFile } = await import('child_process');
  await new Promise<void>((resolve, reject) => {
    execFile('agent-tempo', args, {
      cwd: workDir ?? process.cwd(),
      timeout: 60_000,
      shell: true,
    }, (err, _stdout, stderr) => {
      if (err) reject(new Error(stderr?.toString().trim() || err.message || `agent-tempo ${args[0]} failed`));
      else resolve();
    });
  });
}

/**
 * Build a `TempoClientWithSpawn` over a configured Temporal `Client`.
 * Composes {@link createTempoClientCore} and adds the two TTY-bound
 * spawn methods. Use this for TUI-side consumers; headless callers
 * should use {@link createTempoClientCore} directly.
 *
 * `opts` (e.g. `subscribeDeps`) is forwarded to the Core factory.
 */
export function createTempoClientWithSpawn(
  client: Client,
  opts: CreateTempoClientOpts = {},
): TempoClientWithSpawn {
  const core = createTempoClientCore(client, opts);
  return {
    ...core,

    async createEnsemble(opts) {
      const args = opts.lineup
        ? ['up', opts.ensemble, '--lineup', opts.lineup]
        : ['up', opts.ensemble];
      await runTempoCli(args, opts.workDir);
    },

    async spawnConductor(opts) {
      // `agent-tempo up <ensemble>` is idempotent at the workflow layer —
      // re-invoking it on a live ensemble reuses the existing conductor
      // workflow (deterministic workflow ID). Distinct from
      // `createEnsemble` so call sites read as "make sure the conductor
      // terminal is running", not "create a new ensemble".
      await runTempoCli(['up', opts.ensemble], opts.workDir);
    },
  };
}
