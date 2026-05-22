#!/usr/bin/env node

// Lazy-loaded command surfaces — see `main()` below. The CLI entrypoint
// avoids top-level imports of any module that transitively pulls in the
// Temporal SDK, so that recovery commands (`daemon stop`, `version`, `help`,
// `config show/set`, `upgrade`) stay operable on Node versions where the
// Temporal SDK's transitive deps fail to resolve (issue #157).
//
// Each command-specific handler lives in its own module:
//   - `./cli/daemon-command`   (PR A) — `daemon` subcommands
//   - `./cli/help-text`        (PR C) — `help` output
//   - `./cli/upgrade-command`  (PR C) — `upgrade`
//   - `./cli/config-command`   — `config` set/show/interactive
//   - `./cli/preflight`        — Temporal-touching, legitimately not crash-proof
//   - `./cli/commands`         — all Temporal-touching verbs (start, status, …)
// The `test/cli-crash-proof-isolation.test.ts` suite asserts the crash-proof
// modules carry no `@temporalio/*` / `rxjs` / `@grpc/*` leaks in their
// `require.cache` after load.

// MUST be the first import — promotes a top-level `--dev` flag into the
// `AGENT_TEMPO_DEV_MODE=1` env var BEFORE `./config` evaluates its
// module-load-time `AGENT_TEMPO_HOME` constant. ADR 0014 §5.4.
import './cli/dev-mode-bootstrap';

import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import * as out from './cli/output';
import { emitDevBannerIfActive } from './cli/dev-banner';
import { AGENT_TYPES, AgentType } from './types';
import { ENV, CliOverrides, getConfig, isDevMode } from './config';
import { formatMigrationResult, type LegacyMigrationResult } from './cli/legacy-migration';
import { refreshEntrypoint } from './cli/global-wrapper';

/** Package root — cli.js compiles to dist/cli.js, so one level up. Used by the inline `version` handler. */
const PACKAGE_ROOT = resolve(__dirname, '..');

interface ParsedArgs {
  command: string;
  positional: string[];
  temporalAddress?: string;
  temporalNamespace?: string;
  temporalApiKey?: string;
  temporalTlsCertPath?: string;
  temporalTlsKeyPath?: string;
  name?: string;
  lineup?: string;
  dir: string;
  skipPreflight: boolean;
  background: boolean;
  keepMcp: boolean;
  keepDaemon: boolean;
  yes: boolean;
  all: boolean;
  /**
   * `restore --all-hosts` (#151): switch the `restore` verb into cluster-view
   * readonly listing mode. Surfaces orphans on remote hosts the local
   * daemon's `restore <ensemble>` would skip silently. Never enqueues a
   * restart.
   */
  allHosts: boolean;
  project: boolean;
  /** Issue #172: `up --no-hold` opts out of the defer-conductor-instructions-
   *  until-first-user-message behavior. */
  noHold: boolean;
  /** When set with `down`, terminate every live workflow across all
   *  ensembles before stopping infra. */
  destroy: boolean;
  /** `down --kill-shared-temporal` (#423): bypass the cross-profile guard
   *  and tear down the shared Temporal dev server unconditionally. */
  killSharedTemporal: boolean;
  ensemble?: string;
  agent?: AgentType;
  type?: string;
  includeStale: boolean;
  host?: string;
  /** `daemon start --force` — bypass the stale-PID-file guard.
   *  Also consumed by `migrate-from-claude-tempo --force` to bypass the
   *  conflict + volatile-state guards. */
  force: boolean;
  /** `migrate-from-claude-tempo --dry-run` — print the migration plan without writing. */
  dryRun?: boolean;
  // #128 recall flags (generic enough to share with future commands).
  limit?: number;
  offset?: number;
  previewLength?: number;
  since?: string;
  from?: string;
  includeSent: boolean;
  json: boolean;
  /** `dashboard --port <N>` — override the daemon port discovery. */
  port?: number;
  /** `dashboard --bind <addr>` — override the bind address. */
  bind?: string;
  /** `dashboard --no-open` — print the URL without launching a browser. */
  noOpen: boolean;
  /** `dashboard --pair` — mint a single-use cross-device pairing token + QR. */
  pair: boolean;
  /** `dashboard --bearer <token>` — bearer to include on the pair-mint POST. */
  bearer?: string;
  /**
   * `up --scenario <name>` (PR-3 of #340-followup). Forces every `agent: "mock"`
   * player in the loaded lineup into `mockMode: "scripted"` with this
   * scenario. Bare scenario name (resolved against the package's shipped
   * `scenarios/` dir) or absolute path. Dev-mode only.
   */
  scenario?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = {
    command: 'tui',
    positional: [],
    dir: process.cwd(),
    skipPreflight: false,
    background: false,
    keepMcp: false,
    keepDaemon: false,
    yes: false,
    all: false,
    allHosts: false,
    project: false,
    noHold: false,
    destroy: false,
    killSharedTemporal: false,
    includeStale: false,
    force: false,
    includeSent: false,
    json: false,
    noOpen: false,
    pair: false,
  };

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === '--temporal-address' && i + 1 < argv.length) {
      result.temporalAddress = argv[++i];
    } else if (arg === '--temporal-namespace' && i + 1 < argv.length) {
      result.temporalNamespace = argv[++i];
    } else if (arg === '--temporal-api-key' && i + 1 < argv.length) {
      result.temporalApiKey = argv[++i];
    } else if (arg === '--temporal-tls-cert' && i + 1 < argv.length) {
      result.temporalTlsCertPath = argv[++i];
    } else if (arg === '--temporal-tls-key' && i + 1 < argv.length) {
      result.temporalTlsKeyPath = argv[++i];
    } else if (arg === '--lineup' && i + 1 < argv.length) {
      result.lineup = argv[++i];
    } else if (arg === '--name' && i + 1 < argv.length) {
      // Alias for the positional form on `recall` / `attachment-info`.
      result.name = argv[++i];
    } else if ((arg === '-d' || arg === '--dir') && i + 1 < argv.length) {
      result.dir = argv[++i];
    } else if (arg === '--skip-preflight') {
      result.skipPreflight = true;
    } else if (arg === '--background') {
      result.background = true;
    } else if (arg === '--keep-mcp') {
      result.keepMcp = true;
    } else if (arg === '--keep-daemon') {
      result.keepDaemon = true;
    } else if (arg === '--yes' || arg === '-y') {
      result.yes = true;
    } else if (arg === '--all') {
      result.all = true;
    } else if (arg === '--all-hosts') {
      // #151: `restore --all-hosts` — cluster-view readonly orphan listing.
      result.allHosts = true;
    } else if (arg === '--project') {
      result.project = true;
    } else if (arg === '--no-hold') {
      result.noHold = true;
    } else if (arg === '--destroy') {
      result.destroy = true;
    } else if (arg === '--kill-shared-temporal') {
      // #423 (down only): bypass the cross-profile coexistence guard and
      // tear down the shared Temporal dev server even when the OPPOSITE
      // profile is likely active. Without it, `--dev down` skips the
      // Temporal kill to avoid collateral damage to the prod profile.
      result.killSharedTemporal = true;
    } else if (arg === '--ensemble' && i + 1 < argv.length) {
      result.ensemble = argv[++i];
    } else if (arg === '--type' && i + 1 < argv.length) {
      result.type = argv[++i];
    } else if (arg === '--include-stale') {
      result.includeStale = true;
    } else if (arg === '--host' && i + 1 < argv.length) {
      result.host = argv[++i];
    } else if (arg === '--force') {
      // Consumed by `daemon start --force` (bypass stale-PID guard) and by
      // `migrate-from-claude-tempo --force` (bypass conflict + volatile-state guards).
      result.force = true;
    } else if (arg === '--dry-run') {
      // `migrate-from-claude-tempo --dry-run` — print the plan, write nothing.
      result.dryRun = true;
    } else if (arg === '--no-open') {
      // `dashboard --no-open` — print the URL without spawning a browser.
      result.noOpen = true;
    } else if (arg === '--pair') {
      // `dashboard --pair` — mint a single-use cross-device pairing token.
      result.pair = true;
    } else if (arg === '--port' && i + 1 < argv.length) {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1 || n > 65535) {
        out.error(`Invalid --port: ${argv[i]} (expected 1-65535)`);
        process.exit(1);
      }
      result.port = n;
    } else if (arg === '--bind' && i + 1 < argv.length) {
      result.bind = argv[++i];
    } else if (arg === '--bearer' && i + 1 < argv.length) {
      result.bearer = argv[++i];
    } else if (arg === '--scenario' && i + 1 < argv.length) {
      // PR-3 of #340-followup. Threaded through to mock-player spawn envs by
      // `up`'s `applyLineupPlayersAndSchedules`. Dev-mode only — silently
      // no-ops outside dev mode because mock players can't exist there.
      result.scenario = argv[++i];
    } else if (arg === '--limit' && i + 1 < argv.length) {
      const raw = argv[++i];
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1) {
        out.error(`Invalid --limit: ${raw}`);
        process.exit(1);
      }
      // #270: cap at 100 to match the MCP Zod schema. Recall queries load
      // the full inbox/sent history from the workflow; the cap bounds the
      // worst-case payload across every surface. Use `--offset` to page.
      if (n > 100) {
        out.error(`--limit exceeds max (100). Use --offset N to page through more results.`);
        process.exit(1);
      }
      result.limit = n;
    } else if (arg === '--offset' && i + 1 < argv.length) {
      const n = Number(argv[++i]);
      if (Number.isInteger(n) && n >= 0) result.offset = n;
      else {
        out.error(`Invalid --offset: ${argv[i]}`);
        process.exit(1);
      }
    } else if (arg === '--preview' && i + 1 < argv.length) {
      const n = Number(argv[++i]);
      if (Number.isInteger(n) && n >= 1) result.previewLength = n;
      else {
        out.error(`Invalid --preview: ${argv[i]}`);
        process.exit(1);
      }
    } else if (arg === '--since' && i + 1 < argv.length) {
      result.since = argv[++i];
    } else if (arg === '--from' && i + 1 < argv.length) {
      result.from = argv[++i];
    } else if (arg === '--include-sent') {
      result.includeSent = true;
    } else if (arg === '--json') {
      result.json = true;
    } else if (arg === '--agent' && i + 1 < argv.length) {
      const val = argv[++i];
      // #476: source the allowlist from the canonical `AGENT_TYPES` tuple in
      // `src/types.ts` so the CLI surface tracks the union automatically when
      // a new adapter lands. Pre-#476 this was a hardcoded `'claude'|'copilot'`
      // pair that fell out of sync when `'mock'` (#220) and `'claude-api'`
      // (#131) were added — `agent-tempo recruit --agent claude-api` errored
      // out here even though the recruit MCP tool accepted it. Dev-mode gating
      // for `'mock'` lives downstream at the recruit boundary (`src/tools/
      // recruit.ts`, ADR 0014 §7 gate 3); we don't double-gate it here.
      if (!(AGENT_TYPES as readonly string[]).includes(val)) {
        out.error(`Invalid agent type: "${val}". Must be one of: ${AGENT_TYPES.join(', ')}.`);
        process.exit(1);
      }
      result.agent = val as AgentType;
    } else if (arg === '--help' || arg === '-h') {
      result.command = 'help';
    } else if (arg === '--version' || arg === '-v') {
      result.command = 'version';
    } else if (!arg.startsWith('-')) {
      result.positional.push(arg);
    } else {
      out.error(`Unknown option: ${arg}`);
      out.log(`Run ${out.dim('agent-tempo help')} for usage.`);
      process.exit(1);
    }
    i++;
  }

  if (result.positional.length > 0) {
    result.command = result.positional[0];
  }

  return result;
}

/** Extract CLI overrides for config resolution. */
function cliOverrides(args: ParsedArgs): CliOverrides {
  return {
    temporalAddress: args.temporalAddress,
    temporalNamespace: args.temporalNamespace,
    temporalApiKey: args.temporalApiKey,
    temporalTlsCertPath: args.temporalTlsCertPath,
    temporalTlsKeyPath: args.temporalTlsKeyPath,
  };
}

/**
 * Format + print a {@link LegacyMigrationResult} from
 * `migrate-from-claude-tempo`. Extracted to module scope (an if/else cascade
 * rather than a nested switch) so the body doesn't trip the CLI surface-drift
 * detector, which scans top-level `case '...':` labels in this file.
 */
function reportMigrationResult(result: LegacyMigrationResult): void {
  const msg = formatMigrationResult(result);
  if (result.status === 'no-legacy' || result.status === 'already-migrated') {
    out.success(msg);
    return;
  }
  if (result.status === 'migrated') {
    out.success(msg);
    if (result.copiedFiles?.length) {
      for (const f of result.copiedFiles) out.log(`  ${out.dim('+')} ${f}`);
    }
    if (result.errors?.length) {
      for (const e of result.errors) out.warn(e);
    }
    return;
  }
  if (result.status === 'skipped') {
    out.warn(msg);
    process.exitCode = 1;
    return;
  }
  // 'failed'
  out.error(msg);
  process.exitCode = 1;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const overrides = cliOverrides(args);

  // ADR 0014 §5.4 / gate 4: every dev-mode CLI invocation prints the
  // `[DEV MODE]` banner so operators (and operators' daemon log files)
  // self-identify as the dev profile. Banner emits to stderr — keeps
  // `--json` stdout consumers clean.
  emitDevBannerIfActive();

  // Refresh the global wrapper entrypoint pointer so `~/.agent-tempo/bin/agent-tempo`
  // always resolves to the currently-running binary. Cheap (single writeFileSync),
  // idempotent, and best-effort — never blocks or throws.
  refreshEntrypoint();

  // ── Crash-proof fast paths (#157 PR C) ────────────────────────────────
  // These handlers MUST NOT reach `./cli/commands`, `./cli/preflight`, or
  // any other module that transitively imports `@temporalio/*` / `rxjs` /
  // `@grpc/*`. Keeping their dispatch ABOVE the `import('./cli/commands')`
  // line is what makes them resilient to a broken Temporal SDK install —
  // the scenario users are often trying to recover from by running one of
  // these very commands. Any future crash-proof candidate should slot in
  // here AND get added to CRASH_PROOF_MODULES in the isolation test.
  //
  // Enumerated crash-proof entrypoints:
  //   version / --version / -v          (inline below)
  //   help / --help / -h                 (→ ./cli/help-text)
  //   daemon <sub>                       (→ ./cli/daemon-command)  [PR A]
  //   upgrade [version]                  (→ ./cli/upgrade-command) [PR C]
  //   config / config show / config set  (→ ./cli/config-command)  [PR C]

  if (args.command === 'version') {
    try {
      const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'));
      out.log(`agent-tempo v${pkg.version}`);
    } catch {
      out.log('agent-tempo (unknown version)');
    }
    return;
  }

  if (args.command === 'help') {
    const { printHelp } = await import('./cli/help-text');
    printHelp();
    return;
  }

  if (args.command === 'daemon') {
    const { daemon } = await import('./cli/daemon-command');
    await daemon({
      subcommand: args.positional[1],
      force: args.force,
      ...overrides,
    });
    return;
  }

  if (args.command === 'upgrade') {
    const { upgrade } = await import('./cli/upgrade-command');
    await upgrade({
      version: args.positional[1], // "0.20.0" | "latest" | undefined
      ...overrides,
    });
    return;
  }

  if (args.command === 'config') {
    const { configCommand } = await import('./cli/config-command');
    await configCommand(args.positional);
    return;
  }

  if (args.command === 'dashboard') {
    // PR-8 of #340. Crash-proof — stays out of `./cli/commands` so a
    // broken Temporal SDK doesn't block operators from opening the
    // dashboard against an already-running daemon.
    const { dashboardCommand } = await import('./cli/dashboard-command');
    await dashboardCommand({
      port: args.port,
      bind: args.bind,
      noOpen: args.noOpen,
      pair: args.pair,
      bearer: args.bearer,
      json: args.json,
      ...overrides,
    });
    return;
  }

  // Dev-mode scriptable verbs (#432). Gated on `isDevMode()` AND an explicit
  // allowlist (`DEV_VERBS`); intercepts BEFORE the removed-verbs check so
  // verbs like `pause` (collapsed by #288) can act on the live ensemble in
  // dev mode. NOT crash-proof — dev mode requires Temporal anyway, and the
  // dynamic-import keeps `cli.ts` itself out of `dev-verbs.ts`'s module
  // graph at the top level. The DEV_VERBS ↔ REMOVED_VERBS ↔ cli.ts switch
  // invariants are mechanically asserted by `test/cli-dev-verbs.test.ts`.
  if (isDevMode()) {
    const { DEV_VERBS, dispatchDevVerb } = await import('./cli/dev-verbs');
    if (DEV_VERBS.has(args.command)) {
      const ensemble = args.ensemble || process.env[ENV.ENSEMBLE] || 'default';
      await dispatchDevVerb(args.command, {
        positional: args.positional,
        ensemble,
        ...overrides,
      });
      return;
    }
  }

  // Removed-verb fast path (#288). Intercepted BEFORE the Temporal-touching
  // `./cli/commands` import so the friendly error message works even when
  // Temporal is broken — same reasoning as the crash-proof `help` path.
  const { REMOVED_VERBS, printRemovedVerbMessage } = await import('./cli/removed-verbs');
  if (Object.prototype.hasOwnProperty.call(REMOVED_VERBS, args.command)) {
    printRemovedVerbMessage(args.command);
    process.exit(1);
  }

  // All other commands: lazy-load the full command surface now.
  const {
    status, init, server, up, down,
    ensembleCommand, agentTypesCommand, broadcast, release,
    destroy, attachmentInfo, recall, hosts, refreshHostProfile, restore,
  } = await import('./cli/commands');

  const ensemble = args.positional[1] || process.env[ENV.ENSEMBLE] || 'default';
  // Resolve the default agent from config (only needed for commands that use it)
  const resolvedAgent = (): AgentType => args.agent ?? getConfig(overrides).defaultAgent;

  switch (args.command) {
    case 'status':
      await status({
        ensemble: args.positional[1], // undefined = show all
        ...overrides,
      });
      break;

    case 'server':
      await server({
        background: args.background,
        ...overrides,
      });
      break;

    case 'down':
      await down({
        removeMcp: !args.keepMcp,
        keepDaemon: args.keepDaemon,
        killSharedTemporal: args.killSharedTemporal,
        yes: args.yes,
        destroy: args.destroy,
        dir: args.dir,
        ...overrides,
      });
      break;

    case 'up':
      await up({
        ensemble,
        name: args.name,
        lineup: args.lineup,
        noHold: args.noHold,
        agent: resolvedAgent(),
        ...(args.scenario ? { scenario: args.scenario } : {}),
        ...overrides,
      });
      break;

    case 'broadcast': {
      const msg = args.positional.slice(1).join(' ');
      if (!msg) {
        out.error('Usage: agent-tempo broadcast <message> [--ensemble <name>] [--type <player-type>] [--include-stale]');
        process.exit(1);
      }
      await broadcast({
        message: msg,
        ensemble: args.ensemble || ensemble,
        type: args.type,
        includeStale: args.includeStale,
        ...overrides,
      });
      break;
    }

    case 'release':
      await release({
        ensemble: args.ensemble || ensemble,
        ...overrides,
      });
      break;

    case 'destroy': {
      const target = args.positional[1] || args.ensemble || process.env[ENV.ENSEMBLE];
      if (!target) {
        out.error('Usage: agent-tempo destroy <ensemble> [-y]');
        process.exit(1);
      }
      await destroy({
        ensemble: target,
        yes: args.yes,
        ...overrides,
      });
      break;
    }

    case 'attachment-info':
    case 'attachment': {
      const name = args.positional[1] || args.name;
      if (!name) {
        out.error('Usage: agent-tempo attachment-info <name>');
        process.exit(1);
      }
      await attachmentInfo({
        name,
        ensemble: args.ensemble || ensemble,
        ...overrides,
      });
      break;
    }

    case 'hosts': {
      await hosts({
        ensemble: args.ensemble || ensemble,
        ...(args.all ? { all: true } : {}),
        ...(args.json ? { json: true } : {}),
        ...overrides,
      });
      break;
    }

    case 'refresh-host-profile': {
      await refreshHostProfile({
        ensemble: args.ensemble || ensemble,
        ...overrides,
      });
      break;
    }

    case 'recall': {
      // Positional player is required — matches the #128 design.
      const name = args.positional[1] || args.name;
      if (!name) {
        out.error('Usage: agent-tempo recall <player> [--limit N] [--offset N] [--preview N] [--from X] [--since ISO] [--include-sent] [--json]');
        process.exit(1);
      }
      await recall({
        name,
        ensemble: args.ensemble || ensemble,
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
        ...(args.offset !== undefined ? { offset: args.offset } : {}),
        ...(args.previewLength !== undefined ? { previewLength: args.previewLength } : {}),
        ...(args.since !== undefined ? { since: args.since } : {}),
        ...(args.from !== undefined ? { from: args.from } : {}),
        ...(args.includeSent ? { includeSent: true } : {}),
        ...(args.json ? { json: true } : {}),
        ...overrides,
      });
      break;
    }

    case 'restore': {
      // #288: ensemble-scoped local mode requires a positional name.
      // #151: `--all-hosts` switches to cluster-view readonly listing
      //       — ensemble becomes optional (when set, narrows the listing).
      const target = args.positional[1] || args.ensemble || process.env[ENV.ENSEMBLE];
      if (!args.allHosts && !target) {
        out.error('Usage: agent-tempo restore <ensemble>   (or --all-hosts for cluster-view)');
        process.exit(1);
      }
      await restore({
        ...(target ? { ensemble: target } : {}),
        ...(args.allHosts ? { allHosts: true } : {}),
        ...overrides,
      });
      break;
    }

    case 'ensemble':
      await ensembleCommand({
        subcommand: args.positional[1],
        name: args.positional[2],
        ...overrides,
      });
      break;

    case 'agent-types':
      await agentTypesCommand({
        subcommand: args.positional[1],
        name: args.positional[2],
      });
      break;

    case 'scenarios': {
      // ADR 0014 PR-2 — mock-adapter scenario library discovery surface.
      // Available regardless of `--dev` so users investigating a published
      // agent-tempo can see the shipped library; but the actual recruit
      // gate (`agent: 'mock'`) still rejects without dev mode.
      const { scenariosCommand } = await import('./cli/scenarios-command');
      await scenariosCommand({
        subcommand: args.positional[1],
        name: args.positional[2],
        json: args.json,
      });
      break;
    }

    case 'init':
      await init({ dir: args.dir, project: args.project });
      break;

    case 'migrate-from-claude-tempo': {
      // PR-2 of the v1.0 rebrand — one-shot copy of `~/.agent-tempo/` →
      // `~/.agent-tempo/`. Crash-proof (no Temporal deps). The `--dev`
      // top-level flag selects the dev profile (`~/.agent-tempo-dev/` →
      // `~/.agent-tempo-dev/`) via {@link isDevMode}.
      const { migrateLegacyHome } = await import('./cli/legacy-migration');
      const result = await migrateLegacyHome({
        dryRun: !!(args as { dryRun?: boolean }).dryRun,
        force: !!(args as { force?: boolean }).force,
        profile: isDevMode() ? 'dev' : 'prod',
      });
      reportMigrationResult(result);
      break;
    }

    case 'preflight': {
      // Preflight legitimately requires Temporal (that's what it tests), so
      // it's NOT in the crash-proof module set. Dynamic-imported here so its
      // static import doesn't leak into the top-level module graph of cli.ts
      // (which would undo the crash-proofing of version/help/daemon/etc).
      const { runPreflight } = await import('./cli/preflight');
      const result = await runPreflight({
        dir: args.dir,
        ...overrides,
      });
      for (const w of result.warnings) out.warn(w);
      if (!result.ok) {
        for (const e of result.errors) out.error(e);
        process.exit(1);
      }
      out.success('All checks passed');
      break;
    }

    case 'tui': {
      const config = getConfig(overrides);
      // If --ensemble or positional arg given, start in single-ensemble view.
      // Otherwise, start in multi-ensemble home view.
      const tuiEnsemble = args.ensemble || args.positional[1] || undefined;

      // #289 / S7: run the auto-provisioning bootstrap before handing off
      // to the TUI. Steps 1–6 register MCP, ensure Temporal reachability,
      // boot the daemon, and prefetch badges + ensembles so the TUI home
      // view renders instantly. `skipPreflight` bypass: power users can
      // opt out if the cache / disk-probe cost ever regresses (no current
      // way to trigger, but the flag is already on the parser).
      let bootstrapResult;
      if (!args.skipPreflight) {
        const { bootstrap } = await import('./cli/startup');
        try {
          bootstrapResult = await bootstrap({ config });
        } catch (err) {
          // Bootstrap is best-effort — per-step failures degrade into
          // `StepOutcome.status: 'failed'` and a usable result. A thrown
          // error means something outside the step boundaries broke
          // (e.g. cache-dir creation). Log + continue with an undefined
          // bootstrap payload so the TUI still launches.
          out.warn(`Bootstrap hit an unexpected error: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // Dynamic import — TUI module uses ESM ink
      const { run: runTui } = await import('./tui/index');
      await runTui({ config, ensemble: tuiEnsemble, ...(bootstrapResult ? { bootstrap: bootstrapResult } : {}) });
      break;
    }

    // `version`, `help`, `upgrade`, `config`, `daemon`, and removed-verb
    // dispatch handled above the `./cli/commands` import — crash-proof
    // fast paths (#157 PR C + #288).

    default:
      out.error(`Unknown command: ${args.command}`);
      out.log(`Run ${out.dim('agent-tempo --help')} for usage.`);
      process.exit(1);
  }
}

main().catch((err) => {
  out.error(err.message || String(err));
  process.exit(1);
});
