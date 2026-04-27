/**
 * ESLint custom-rule guard — verify the testability bans actually fire.
 *
 * The conductor's autonomous validation script CAN'T DRIVE the dashboard
 * if a `window.confirm()` lurks somewhere and pops a modal that the
 * `claude-in-chrome` MCP tool can't dismiss. So we make the rule
 * build-blocking AND we test that it does what it claims.
 *
 * Synthetic source strings get fed to ESLint's programmatic API; we
 * assert the rule fires on the offending forms and stays silent
 * otherwise.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { Linter } from 'eslint';
// `eslint.config.js` is a JS module without bundled types; cast at the
// dynamic-import boundary so the test file stays strict-mode clean.
let flatConfig: unknown;

beforeAll(async () => {
  // @ts-expect-error — `eslint.config.js` is a flat-config JS module
  // without ambient TS types. Resolving via dynamic import avoids the
  // top-level `import` baking the path into compilation.
  flatConfig = (await import('../eslint.config.js')).default;
});

function lint(code: string, filename = 'src/check.tsx'): Linter.LintMessage[] {
  const linter = new Linter({ configType: 'flat' });
  return linter.verify(code, flatConfig as Linter.Config[], { filename });
}

describe('ESLint testability bans', () => {
  it('flags bare `confirm("...")` as no-restricted-globals', () => {
    const messages = lint('confirm("delete?");');
    expect(messages.some((m) => m.ruleId === 'no-restricted-globals')).toBe(true);
  });

  it('flags bare `alert("...")`', () => {
    const messages = lint('alert("hello");');
    expect(messages.some((m) => m.ruleId === 'no-restricted-globals')).toBe(true);
  });

  it('flags bare `prompt("...")`', () => {
    const messages = lint('prompt("name?");');
    expect(messages.some((m) => m.ruleId === 'no-restricted-globals')).toBe(true);
  });

  it('flags `window.confirm()` via no-restricted-syntax', () => {
    const messages = lint('window.confirm("ok?");');
    expect(messages.some((m) => m.ruleId === 'no-restricted-syntax')).toBe(true);
  });

  it('flags `window.alert()` via no-restricted-syntax', () => {
    const messages = lint('window.alert("hi");');
    expect(messages.some((m) => m.ruleId === 'no-restricted-syntax')).toBe(true);
  });

  it('does NOT flag clean code that uses neither pattern', () => {
    const messages = lint('const x = 1;');
    const banViolations = messages.filter(
      (m) => m.ruleId === 'no-restricted-globals' || m.ruleId === 'no-restricted-syntax',
    );
    expect(banViolations).toHaveLength(0);
  });
});
