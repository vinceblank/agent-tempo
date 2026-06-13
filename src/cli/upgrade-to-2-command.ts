/**
 * `agent-tempo upgrade-to-2` CLI handler — the 1.x → 2.0 cutover verb (#785).
 *
 * **Crash-proof discipline (mirrors `upgrade-command.ts`).** This module must
 * NOT statically import `@temporalio/*`, `../connection`, `../upgrade/phase-engine`
 * (which transitively pulls the Temporal SDK), or anything else on the forbidden
 * list in `test/cli-crash-proof-isolation.test.ts`. The cutover genuinely needs
 * a working Temporal SDK to run — but keeping the *import* dynamic means a broken
 * install surfaces an actionable error here instead of crashing `cli.ts` at
 * dispatch, and the sibling crash-proof verbs (`version`/`help`/`daemon`) stay
 * unaffected.
 *
 * Returns a process exit code (0 success / dry-run / clean abort; non-zero for
 * connection failure, version refusal, drain-stop, or an unexpected error).
 */
import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import * as readline from 'readline';
import { getConfig, CliOverrides, AGENT_TEMPO_HOME } from '../config';
import * as out from './output';

/** Package root is two levels up from `dist/cli/`. */
const PACKAGE_ROOT = resolve(__dirname, '..', '..');

export interface UpgradeToV2Opts extends CliOverrides {
  /** Skip the interactive confirm. */
  yes?: boolean;
  /** Print the would-be snapshot + destroy list and exit before pausing. */
  dryRun?: boolean;
  /** Proceed past a non-empty drain, recording stragglers in the snapshot. */
  forceDrain?: boolean;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function promptYesNo(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

export async function upgradeToV2Command(opts: UpgradeToV2Opts): Promise<number> {
  const config = getConfig(opts);

  let cliVersion = 'unknown';
  try {
    const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'));
    cliVersion = pkg.version || 'unknown';
  } catch {
    /* ignore */
  }

  out.heading('agent-tempo upgrade-to-2');
  out.log(`  Cutover 1.x → 2.0: pause → drain → snapshot → destroy.`);
  out.log(`  ${out.dim(`Running v${cliVersion} against ${config.temporalNamespace}@${config.temporalAddress}`)}`);
  if (opts.dryRun) out.log(`  ${out.dim('DRY-RUN — nothing will be paused, captured, or destroyed.')}`);
  console.log();

  // ── Dynamic-import the Temporal-touching surface (crash-proof gate) ────
  let runUpgradeToV2: typeof import('../upgrade/phase-engine').runUpgradeToV2;
  let createTemporalConnection: typeof import('../connection').createTemporalConnection;
  let Client: typeof import('@temporalio/client').Client;
  try {
    ({ runUpgradeToV2 } = await import('../upgrade/phase-engine'));
    ({ createTemporalConnection } = await import('../connection'));
    ({ Client } = await import('@temporalio/client'));
  } catch (err) {
    out.error(`Temporal SDK failed to load — upgrade-to-2 requires a working install.`);
    out.log(`  ${out.dim(errMsg(err))}`);
    out.log(`  Recovery: npm install -g agent-tempo`);
    return 1;
  }

  let connection: Awaited<ReturnType<typeof createTemporalConnection>>;
  try {
    connection = await createTemporalConnection(config);
  } catch (err) {
    out.error(`Could not connect to Temporal at ${config.temporalAddress}: ${errMsg(err)}`);
    out.log(`  Is the daemon running? Try: agent-tempo daemon start`);
    return 1;
  }
  const client = new Client({ connection, namespace: config.temporalNamespace });

  try {
    const result = await runUpgradeToV2(
      {
        client,
        home: AGENT_TEMPO_HOME,
        cliVersion,
        log: (...args: unknown[]) => console.log(...args),
        confirm: async () =>
          promptYesNo(
            `  ${out.cyan('?')} Proceed with the cutover? This DESTROYS all workflows after the snapshot. [y/N] `,
          ),
      },
      {
        yes: opts.yes,
        dryRun: opts.dryRun,
        forceDrain: opts.forceDrain,
      },
    );

    console.log();
    switch (result.status) {
      case 'done':
        out.success('Cutover complete — all workflows torn down, snapshot stamped `done`.');
        return 0;
      case 'dry-run':
        out.log('Dry-run complete. Re-run without --dry-run to perform the cutover.');
        return 0;
      case 'aborted':
        out.log('Cutover aborted — no changes were made.');
        return 0;
      case 'refused':
        out.error('Cutover refused — one or more daemons are below the 1.8.x version floor.');
        return 2;
      case 'drain-stopped':
        out.warn('Cutover stopped at DRAIN — outbox entries are still pending.');
        out.log('  Re-run once they clear, or pass --force-drain to proceed (stragglers recorded, not delivered).');
        return 3;
      default:
        return 0;
    }
  } catch (err) {
    out.error(`Cutover failed: ${errMsg(err)}`);
    out.log(`  If a snapshot was written (~/.agent-tempo/upgrade-snapshot-v1.json), re-run to resume from where it stopped.`);
    return 1;
  } finally {
    try {
      await connection.close();
    } catch {
      /* best-effort */
    }
  }
}
