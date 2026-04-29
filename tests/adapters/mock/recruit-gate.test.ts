/**
 * Recruit-time rejection regression test for ADR 0014 §7 gate 3.
 *
 * The full integration coverage lives in `test/mock-adapter-claim-heartbeat.test.ts`
 * (Mocha + TestWorkflowEnvironment). This vitest file gives us a fast unit-level
 * tripwire on the gate's wiring:
 *
 *   - The Zod enum on the recruit tool accepts `'mock'`.
 *   - `recruit.ts` references `isDevMode` (i.e. the gate is wired at all).
 *   - The fail-path message contains an actionable hint (`--dev`).
 *
 * Source-level rather than runtime because the property is "this gate exists
 * and references the right symbol." Adding the literal strings as guards
 * means a future contributor who edits the gate text also has to update this
 * test, and the test will fail loudly instead of silently passing because
 * the gate logic was rewritten in a way that no longer rejects.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const RECRUIT_SRC = fs.readFileSync(path.join(REPO_ROOT, 'src/tools/recruit.ts'), 'utf8');
// Post-#476 the agent enum's allowlist lives in `src/types.ts` as the
// `AGENT_TYPES` const tuple — single source of truth shared with the
// CLI argv parser. Read both files so the tripwire still asserts that
// `'mock'` is reachable from the recruit tool, just via the canonical
// constant rather than a literal in recruit.ts.
const TYPES_SRC = fs.readFileSync(path.join(REPO_ROOT, 'src/types.ts'), 'utf8');

describe('recruit tool — gate 3 wiring', () => {
  it('imports isDevMode from src/config', () => {
    // Allow either order — `import { ..., isDevMode } from '../config'`
    // (current shape) or `import { isDevMode, ... } from '../config'`.
    // The check that matters: `isDevMode` is named-imported from the
    // `../config` module, anywhere in the file's import block.
    const imports = RECRUIT_SRC.split(/\r?\n/).filter((l) => /^import\s/.test(l)).join('\n');
    expect(imports).toMatch(/isDevMode/);
    expect(imports).toMatch(/from\s+['"]\.\.\/config['"]/);
  });

  it('extends the agent enum to accept "mock"', () => {
    // Post-#476 the recruit tool sources its enum allowlist from the
    // canonical `AGENT_TYPES` tuple in `src/types.ts` instead of an
    // inline literal — keeps CLI parser + MCP enum in lockstep when
    // a new adapter lands. Two-step assertion:
    //   1. recruit.ts uses `z.enum(AGENT_TYPES)` (no inline drift)
    //   2. AGENT_TYPES in types.ts contains 'mock'
    expect(RECRUIT_SRC).toMatch(/z\.enum\(AGENT_TYPES\)/);
    expect(TYPES_SRC).toMatch(/AGENT_TYPES\s*=\s*\[[^\]]*['"]mock['"][^\]]*\]\s*as\s*const/);
  });

  it('rejects agent: "mock" outside dev mode with an actionable error', () => {
    // Verify both halves of the gate are present:
    //   1. the conditional `agent === 'mock' && !isDevMode()`
    //   2. an error message that names `--dev` so users know how to enable it
    expect(RECRUIT_SRC).toMatch(/agent\s*===\s*['"]mock['"]\s*&&\s*!isDevMode\(\)/);
    expect(RECRUIT_SRC).toMatch(/only available in dev mode/);
    expect(RECRUIT_SRC).toMatch(/--dev/);
  });

  it('rejects mockMode/mockScenario when agent is not "mock"', () => {
    expect(RECRUIT_SRC).toMatch(/mockMode is only valid when agent: ['"]mock['"]/);
    expect(RECRUIT_SRC).toMatch(/mockScenario is only valid when agent: ['"]mock['"]/);
  });

  it('requires mockScenario when mockMode is "scripted"', () => {
    expect(RECRUIT_SRC).toMatch(/mockMode: ['"]scripted['"] requires mockScenario/);
  });
});
