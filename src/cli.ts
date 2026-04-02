#!/usr/bin/env node

import { start, status, init, server, up, down, stop, help, version } from './cli/commands';
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
  dir: string;
  skipPreflight: boolean;
  background: boolean;
  keepMcp: boolean;
  all: boolean;
  project: boolean;
  ensemble?: string;
  agent?: AgentType;
}

function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = {
    command: 'help',
    positional: [],
    dir: process.cwd(),
    skipPreflight: false,
    background: false,
    keepMcp: false,
    all: false,
    project: false,
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
    } else if (arg === '--ensemble' && i + 1 < argv.length) {
      result.ensemble = argv[++i];
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
        name: args.positional[1] || args.name,
        ensemble: args.ensemble,
        all: args.all || undefined,
        ...overrides,
      });
      break;

    case 'down':
      await down({
        removeMcp: !args.keepMcp,
        dir: args.dir,
        ...overrides,
      });
      break;

    case 'up':
      await up({
        ensemble,
        name: args.name,
        agent: resolvedAgent(),
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

    case 'version':
      version();
      break;

    case 'help':
    default:
      help();
      break;
  }
}

main().catch((err) => {
  out.error(err.message || String(err));
  process.exit(1);
});
