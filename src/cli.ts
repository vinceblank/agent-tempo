#!/usr/bin/env node

import { start, status, init, server, up, down, help, version } from './cli/commands';
import { runPreflight } from './cli/preflight';
import * as out from './cli/output';
import { AgentType } from './types';
import { ENV } from './config';

interface ParsedArgs {
  command: string;
  positional: string[];
  temporalAddress: string;
  name?: string;
  dir: string;
  skipPreflight: boolean;
  background: boolean;
  keepMcp: boolean;
  agent?: AgentType;
}

function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = {
    command: 'help',
    positional: [],
    temporalAddress: process.env[ENV.TEMPORAL_ADDRESS] || 'localhost:7233',
    dir: process.cwd(),
    skipPreflight: false,
    background: false,
    keepMcp: false,
  };

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === '--temporal-address' && i + 1 < argv.length) {
      result.temporalAddress = argv[++i];
    } else if ((arg === '-n' || arg === '--name') && i + 1 < argv.length) {
      result.name = argv[++i];
    } else if (arg === '--dir' && i + 1 < argv.length) {
      result.dir = argv[++i];
    } else if (arg === '--skip-preflight') {
      result.skipPreflight = true;
    } else if (arg === '--background' || arg === '-d') {
      result.background = true;
    } else if (arg === '--keep-mcp') {
      result.keepMcp = true;
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const ensemble = args.positional[1] || process.env[ENV.ENSEMBLE] || 'default';

  switch (args.command) {
    case 'conduct':
      await start({
        ensemble,
        conductor: true,
        temporalAddress: args.temporalAddress,
        name: args.name,
        skipPreflight: args.skipPreflight,
        agent: args.agent ?? 'claude',
      });
      break;

    case 'start':
      await start({
        ensemble,
        conductor: false,
        temporalAddress: args.temporalAddress,
        name: args.name,
        skipPreflight: args.skipPreflight,
        agent: args.agent ?? 'claude',
      });
      break;

    case 'status':
      await status({
        ensemble: args.positional[1], // undefined = show all
        temporalAddress: args.temporalAddress,
      });
      break;

    case 'server':
      await server({
        temporalAddress: args.temporalAddress,
        background: args.background,
      });
      break;

    case 'down':
      await down({
        temporalAddress: args.temporalAddress,
        removeMcp: !args.keepMcp,
        dir: args.dir,
      });
      break;

    case 'up':
      await up({
        ensemble,
        temporalAddress: args.temporalAddress,
        name: args.name,
      });
      break;

    case 'init':
      await init({ dir: args.dir });
      break;

    case 'preflight':
      const result = await runPreflight({
        temporalAddress: args.temporalAddress,
        projectDir: args.dir,
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
