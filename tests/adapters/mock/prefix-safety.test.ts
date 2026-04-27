/**
 * Production-safety regression test for the `__MOCK__:` cue-prefix
 * (ADR 0014 §4.4 prefix safety guarantee + conductor's PR-2 brief risk
 * #2). The prefix is interpreted ONLY by the mock adapter; production
 * adapters (claude-code, copilot) MUST treat it as plain text so an
 * accidentally-cross-pollinated directive into a real chat is inert.
 *
 * This test asserts the property by source inspection: no production
 * adapter source file references the `__MOCK__:` literal or imports the
 * prefix module. A regression — adding "if message starts with __MOCK__:
 * ..." logic to a real adapter — would fail the assertion before it ever
 * shipped.
 *
 * Source-level rather than runtime, because the property in question is
 * "this code path doesn't exist." Mocking a real adapter and feeding it a
 * prefixed message would only test "this particular code path doesn't
 * branch on the prefix today" — which is a weaker assertion than "no
 * such branch exists anywhere in the production adapter source."
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

const PRODUCTION_ADAPTER_FILES = [
  'src/adapters/base.ts',
  'src/adapters/sdk/base.ts',
  'src/adapters/claude-code/adapter.ts',
  'src/adapters/copilot/adapter.ts',
  'src/adapters/claude-code/index.ts',
  'src/adapters/copilot/index.ts',
];

describe('__MOCK__: prefix safety — production adapters never inspect it', () => {
  for (const rel of PRODUCTION_ADAPTER_FILES) {
    it(`${rel} does not reference the __MOCK__: prefix`, () => {
      const abs = path.join(REPO_ROOT, rel);
      if (!fs.existsSync(abs)) {
        // If a production adapter file moves, this guard surfaces the rename
        // instead of silently passing.
        throw new Error(`expected file not found: ${abs}`);
      }
      const src = fs.readFileSync(abs, 'utf8');
      expect(src).not.toMatch(/__MOCK__:/);
      expect(src).not.toMatch(/from ['"][^'"]*\/mock\/prefix['"]/);
      expect(src).not.toMatch(/import ['"][^'"]*\/mock\/prefix['"]/);
    });
  }

  it('the production adapter registry does not import mock at module top level', () => {
    // The registry file imports `mockDescriptor` ONLY inside an `if (isDevMode())`
    // require()  — never as a top-level static import. A static import would
    // pull the mock into every consumer's module graph (including production
    // tarballs without `dist/adapters/mock/`), breaking gate 2.
    const src = fs.readFileSync(path.join(REPO_ROOT, 'src/adapters/index.ts'), 'utf8');
    // Walk the file: every line that mentions the mock module must be inside
    // a call to require('./mock'), never an `import ... from './mock'`.
    const importLines = src
      .split(/\r?\n/)
      .filter((line) => /^\s*import\b/.test(line))
      .filter((line) => /['"][^'"]*\/mock(?:\/|['"])/.test(line));
    expect(importLines, `static imports of mock: ${importLines.join(', ')}`).toHaveLength(0);
  });
});
