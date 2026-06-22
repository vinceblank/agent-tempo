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
 * NOTE (#789): `spawnConductor` was removed with the Ink TUI (its only caller
 * was the TUI's `ensure-conductor-spawned` helper). WithSpawn's only distinct
 * method is now `createEnsemble` — still live (CLI `up`, command-center board).
 * The Core-vs-WithSpawn split STAYS (WithSpawn is the universal client alias).
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
 * Composes {@link createTempoClientCore} and adds the TTY-bound
 * `createEnsemble` spawn method. Use this for spawn-capable consumers (the CLI
 * `up` path, the command-center board's `/ensemble-up`); pure-headless callers
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
    // #789: `spawnConductor` removed with the Ink TUI — its only caller was the
    // TUI's `ensure-conductor-spawned` helper (also deleted). WithSpawn's only
    // distinct method is now `createEnsemble` (still used by the command-center
    // board's `/ensemble-up` + the CLI `up` path).
  };
}
