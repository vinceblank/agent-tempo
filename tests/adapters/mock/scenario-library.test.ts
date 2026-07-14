/**
 * Scenario-library smoke test (PR-3 of #340-followup, ADR 0014 §4.8).
 *
 * Every shipped scenario YAML at `scenarios/` MUST parse cleanly through the
 * Zod schema in `src/adapters/mock/scenario.ts`. A YAML-typo or an action
 * shape that drifts from the schema would silently break dashboards trying
 * to drive these scenarios — the test catches both at CI time so the
 * library stays internally consistent.
 *
 * Pure module: reads the repo's `scenarios/` directory directly, no Temporal,
 * no spawn.
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';
import { parseScenario } from '../../../src/adapters/mock/scenario';

/**
 * Repo root from this test file's perspective. Vitest compiles via ts-node;
 * `__dirname` resolves at runtime to the source location, so two levels up
 * from `tests/adapters/mock/` lands at the repo root regardless of cwd.
 */
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const SCENARIOS_DIR = resolve(REPO_ROOT, 'scenarios');

/** Names of every `.yaml` file in `scenarios/` (filename without extension). */
function listScenarioFiles(): string[] {
  return readdirSync(SCENARIOS_DIR)
    .filter((name) => name.endsWith('.yaml'))
    .filter((name) => statSync(resolve(SCENARIOS_DIR, name)).isFile())
    .sort();
}

describe('scenarios/ library — every shipped YAML parses', () => {
  const files = listScenarioFiles();

  it('finds at least one shipped scenario (sanity)', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  // One `it` per file so a failure pinpoints the offender by name in the
  // test output instead of bundling them into a single anonymous failure.
  for (const file of files) {
    it(`${file} parses cleanly`, () => {
      const yamlText = readFileSync(resolve(SCENARIOS_DIR, file), 'utf8');
      expect(() => parseScenario(yamlText)).not.toThrow();
    });
  }

  it("each scenario's `name` matches its filename stem", () => {
    // Discoverability invariant — `--dev recruit … --mockScenario <name>`
    // resolves bare names to `<repo>/scenarios/<name>.yaml`. If the
    // file's `name:` field drifted from the filename, the YAML would
    // parse but not match what users typed at the CLI.
    for (const file of files) {
      const stem = file.replace(/\.yaml$/, '');
      const yamlText = readFileSync(resolve(SCENARIOS_DIR, file), 'utf8');
      const scenario = parseScenario(yamlText);
      expect(scenario.name, `${file} should declare name: "${stem}"`).toBe(stem);
    }
  });

  it('multi-player handoff does not report completion before downstream evidence', () => {
    const yamlText = readFileSync(resolve(SCENARIOS_DIR, 'multi-player-handoff.yaml'), 'utf8');
    const scenario = parseScenario(yamlText);
    const handoffRule = scenario.rules.find((rule) => rule.when === 'ship feature');
    const reportTypes = handoffRule?.do.flatMap((action) =>
      'report' in action ? [action.report.type] : [],
    );

    expect(reportTypes).toContain('update');
    expect(reportTypes).not.toContain('result');
  });
});
