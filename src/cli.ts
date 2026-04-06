#!/usr/bin/env node

import { start, status, init, server, up, down, stop, help, version, ensembleCommand, agentTypesCommand, broadcast, encore, daemon } from './cli/commands';
import { configCommand } from './cli/config-command';
import { runPreflight } from './cli/preflight';
import * as out from './cli/output';
import { AgentType } from './types';
import { ENV, CliOverrides, getConfig } from './config';

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
  all: boolean;
  project: boolean;
  replace: boolean;
  resume: boolean;
  ensemble?: string;
  agent?: AgentType;
  type?: string;
  includeStale: boolean;
  host?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = {
    command: 'tui',
    positional: [],
    dir: process.cwd(),
    skipPreflight: false,
    background: false,
    keepMcp: false,
    all: false,
    project: false,
    replace: false,
    resume: false,
    includeStale: false,
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
    } else if ((arg === '-n' || arg === '--name') && i + 1 < argv.length) {
      result.name = argv[++i];
    } else if ((arg === '-d' || arg === '--dir') && i + 1 < argv.length) {
      result.dir = argv[++i];
    } else if (arg === '--skip-preflight') {
      result.skipPreflight = true;
    } else if (arg === '--background') {
      result.background = true;
    } else if (arg === '--keep-mcp') {
      result.keepMcp = true;
    } else if (arg === '--all') {
      result.all = true;
    } else if (arg === '--project') {
      result.project = true;
    } else if (arg === '--replace') {
      result.replace = true;
    } else if (arg === '--resume') {
      result.resume = true;
    } else if (arg === '--ensemble' && i + 1 < argv.length) {
      result.ensemble = argv[++i];
    } else if (arg === '--type' && i + 1 < argv.length) {
      result.type = argv[++i];
    } else if (arg === '--include-stale') {
      result.includeStale = true;
    } else if (arg === '--host' && i + 1 < argv.length) {
      result.host = argv[++i];
    } else if (arg === '--agent' && i + 1 < argv.length) {
      const val = argv[++i];
      if (val !== 'claude' && val !== 'copilot') {
        out.error(`Invalid agent type: "${val}". Must be "claude" or "copilot".`);
        process.exit(1);
      }
      result.agent = val;
    } else if (arg === '--help' || arg === '-h') {
      result.command = 'help';
    } else if (arg === '--version' || arg === '-v') {
      result.command = 'version';
    } else if (!arg.startsWith('-')) {
      result.positional.push(arg);
    } else {
      out.error(`Unknown option: ${arg}`);
      out.log(`Run ${out.dim('claude-tempo help')} for usage.`);
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const ensemble = args.positional[1] || process.env[ENV.ENSEMBLE] || 'default';
  const overrides = cliOverrides(args);
  // Resolve the default agent from config (only needed for commands that use it)
  const resolvedAgent = (): AgentType => args.agent ?? getConfig(overrides).defaultAgent;

  switch (args.command) {
    case 'conduct':
      await start({
        ensemble,
        conductor: true,
        replace: args.replace,
        resume: args.resume,
        name: args.name,
        skipPreflight: args.skipPreflight,
        agent: resolvedAgent(),
        dir: args.dir,
        ...overrides,
      });
      break;

    case 'start':
      await start({
        ensemble,
        conductor: false,
        name: args.name,
        skipPreflight: args.skipPreflight,
        agent: resolvedAgent(),
        dir: args.dir,
        ...overrides,
      });
      break;

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

    case 'stop':
      await stop({
        name: args.name,
        ensemble: args.positional[1],
        all: args.all || undefined,
        ...overrides,
      });
      break;

    case 'down':
      await down({
        ensemble: args.ensemble || args.positional[1] || process.env[ENV.ENSEMBLE],
        all: args.all,
        removeMcp: !args.keepMcp,
        dir: args.dir,
        ...overrides,
      });
      break;

    case 'up':
      await up({
        ensemble,
        name: args.name,
        lineup: args.lineup,
        agent: resolvedAgent(),
        ...overrides,
      });
      break;

    case 'broadcast': {
      const msg = args.positional.slice(1).join(' ');
      if (!msg) {
        out.error('Usage: claude-tempo broadcast <message> [--ensemble <name>] [--type <player-type>] [--include-stale]');
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

    case 'encore': {
      const encoreName = args.positional[1] || args.name;
      if (!encoreName) {
        out.error('Usage: claude-tempo encore <name> [--ensemble <name>] [--host <hostname>]');
        process.exit(1);
      }
      await encore({
        name: encoreName,
        ensemble: args.ensemble || ensemble,
        host: args.host,
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

    case 'daemon':
      await daemon({
        subcommand: args.positional[1],
        ...overrides,
      });
      break;

    case 'init':
      await init({ dir: args.dir, project: args.project });
      break;

    case 'config':
      await configCommand(args.positional);
      break;

    case 'preflight':
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

    case 'tui': {
      const config = getConfig(overrides);
      // If --ensemble or positional arg given, start in single-ensemble view.
      // Otherwise, start in multi-ensemble home view.
      const tuiEnsemble = args.ensemble || args.positional[1] || undefined;
      // Dynamic import — TUI module uses ESM ink
      const { run: runTui } = await import('./tui/index');
      await runTui({ config, ensemble: tuiEnsemble });
      break;
    }

    case 'version':
      version();
      break;

    case 'help':
      help();
      break;

    default:
      out.error(`Unknown command: ${args.command}`);
      out.log(`Run ${out.dim('claude-tempo --help')} for usage.`);
      process.exit(1);
  }
}

main().catch((err) => {
  out.error(err.message || String(err));
  process.exit(1);
});
