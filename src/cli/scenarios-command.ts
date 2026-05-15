/**
 * `agent-tempo --dev scenarios <list|show> [name]` — discoverability surface
 * for the mock-adapter scenario library shipped at the package's repo-root
 * `scenarios/` directory (ADR 0014 §4.8).
 *
 * Crash-proof: imports only `fs`, `path`, the scenario parser, and the
 * shared CLI output helpers. No Temporal, no rxjs — lives in the same
 * "always-importable" tier as `help-text.ts` and `daemon-command.ts`. A
 * conductor can `agent-tempo --dev scenarios list` to enumerate the
 * library before the dev daemon is even running.
 *
 * Resolution rules mirror `MockAttachment.resolveScenarioPath`:
 *
 *   1. Absolute path — used verbatim.
 *   2. Bare name (no separators) — `<package-root>/scenarios/<name>.yaml`.
 *   3. Relative path — `process.cwd()`-relative.
 */
import * as fs from 'fs';
import * as path from 'path';
import { parseScenario } from '../adapters/mock/scenario';
import * as out from './output';

/** Walk up from this file's compiled location to the package root. */
function packageRoot(): string {
  // dist/cli/scenarios-command.js → dist/cli → dist → <root>
  return path.resolve(__dirname, '..', '..');
}

function shippedScenariosDir(): string {
  return path.join(packageRoot(), 'scenarios');
}

/** Surface used by `src/cli.ts`'s `--dev scenarios` verb. */
export async function scenariosCommand(args: {
  subcommand?: string;
  name?: string;
  json?: boolean;
}): Promise<void> {
  const sub = args.subcommand ?? 'list';
  switch (sub) {
    case 'list':
      await listScenarios(Boolean(args.json));
      return;
    case 'show':
      if (!args.name) {
        out.error('Usage: agent-tempo --dev scenarios show <name>');
        process.exit(1);
      }
      await showScenario(args.name);
      return;
    default:
      out.error(`Unknown scenarios subcommand "${sub}". Available: list, show.`);
      process.exit(1);
  }
}

async function listScenarios(asJson: boolean): Promise<void> {
  const dir = shippedScenariosDir();
  if (!fs.existsSync(dir)) {
    if (asJson) {
      out.log(JSON.stringify({ scenarios: [], scenariosDir: dir }));
      return;
    }
    out.warn(`No scenarios directory found at ${dir}.`);
    out.warn('This agent-tempo install may have been built without dev-mode artifacts.');
    return;
  }

  const entries = fs.readdirSync(dir)
    .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
    .sort();

  const items = entries.map((file) => {
    const abs = path.join(dir, file);
    try {
      const yamlText = fs.readFileSync(abs, 'utf8');
      const scenario = parseScenario(yamlText);
      return {
        name: scenario.name,
        file: path.basename(file, path.extname(file)),
        description: (scenario.description ?? '').split('\n').map((l) => l.trim()).filter(Boolean).join(' '),
        ruleCount: scenario.rules.length,
      };
    } catch (err) {
      return {
        name: '(invalid)',
        file: path.basename(file, path.extname(file)),
        description: `parse error: ${(err as Error)?.message ?? err}`,
        ruleCount: 0,
      };
    }
  });

  if (asJson) {
    out.log(JSON.stringify({ scenarios: items, scenariosDir: dir }, null, 2));
    return;
  }

  if (items.length === 0) {
    out.log(`No scenarios found in ${dir}.`);
    return;
  }
  out.log(`Mock-adapter scenarios in ${dir}:\n`);
  for (const item of items) {
    out.log(`  ${item.file}  (${item.ruleCount} rule${item.ruleCount === 1 ? '' : 's'})`);
    if (item.description) {
      out.log(`    ${item.description}`);
    }
  }
  out.log('\nUse with: agent-tempo --dev recruit <name> --agent mock --mockMode scripted --mockScenario <name>');
}

async function showScenario(reference: string): Promise<void> {
  const abs = resolveCliReference(reference);
  if (!fs.existsSync(abs)) {
    out.error(`Scenario file not found: ${abs}`);
    process.exit(1);
  }
  const yamlText = fs.readFileSync(abs, 'utf8');
  // Validate while displaying so users get an immediate "this YAML is fine"
  // signal alongside the printed body. Show the raw YAML even on parse
  // failure so operators can spot the offending line.
  try {
    parseScenario(yamlText);
  } catch (err) {
    out.error(`(scenario validation failed: ${(err as Error)?.message ?? err})`);
    out.error('Showing raw YAML below regardless:\n');
  }
  out.log(`# ${abs}\n`);
  out.log(yamlText.replace(/\n$/, ''));
}

function resolveCliReference(reference: string): string {
  if (path.isAbsolute(reference)) return reference;
  if (!reference.includes('/') && !reference.includes(path.sep)) {
    const stem = reference.endsWith('.yaml') || reference.endsWith('.yml')
      ? reference
      : `${reference}.yaml`;
    return path.join(shippedScenariosDir(), stem);
  }
  return path.resolve(process.cwd(), reference);
}
