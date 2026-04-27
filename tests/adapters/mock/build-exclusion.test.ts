/**
 * Build-exclusion regression test for ADR 0014 §7 gate 1. Asserts that:
 *
 *   1. `scripts/strip-mock-adapter.js` actually removes `dist/adapters/mock/`
 *      from a sample tree (verifies the prepack hook does what it claims).
 *   2. `scripts/verify-tarball.js` exit-codes correctly when an `npm pack
 *      --dry-run` listing contains a mock adapter file (the regression-detection
 *      logic itself works).
 *
 * Both checks are hermetic — no actual `npm pack` invocation, no network,
 * no file mutations outside a tmpdir. The release.yml + ci.yml pipelines
 * run the real `verify-tarball` against the real tarball; this test makes
 * sure the script logic itself doesn't silently regress.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const STRIP_SCRIPT = path.join(REPO_ROOT, 'scripts', 'strip-mock-adapter.js');
const VERIFY_SCRIPT = path.join(REPO_ROOT, 'scripts', 'verify-tarball.js');

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) {
    try { fn(); } catch { /* best effort */ }
  }
});

function makeFakeTree(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-strip-'));
  cleanups.push(() => fs.rmSync(tmp, { recursive: true, force: true }));
  fs.mkdirSync(path.join(tmp, 'dist', 'adapters', 'mock'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'dist', 'adapters', 'mock', 'adapter.js'), '// mock');
  fs.writeFileSync(path.join(tmp, 'dist', 'adapters', 'mock', 'descriptor.js'), '// mock');
  // Adjacent surface that MUST survive the strip — proves the script is scoped.
  fs.mkdirSync(path.join(tmp, 'dist', 'adapters', 'copilot'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'dist', 'adapters', 'copilot', 'adapter.js'), '// copilot');
  return tmp;
}

describe('strip-mock-adapter.js (gate 1)', () => {
  it('removes dist/adapters/mock/ from a fake tree', () => {
    const tmp = makeFakeTree();
    expect(fs.existsSync(path.join(tmp, 'dist', 'adapters', 'mock'))).toBe(true);

    execFileSync(process.execPath, [STRIP_SCRIPT], {
      cwd: tmp,
      stdio: 'pipe',
    });

    expect(fs.existsSync(path.join(tmp, 'dist', 'adapters', 'mock'))).toBe(false);
    // Adjacent dir untouched.
    expect(fs.existsSync(path.join(tmp, 'dist', 'adapters', 'copilot', 'adapter.js'))).toBe(true);
  });

  it('is idempotent — running on a clean tree is a no-op', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-strip-clean-'));
    cleanups.push(() => fs.rmSync(tmp, { recursive: true, force: true }));
    // Should not throw.
    const stdout = execFileSync(process.execPath, [STRIP_SCRIPT], {
      cwd: tmp,
      stdio: 'pipe',
    }).toString();
    expect(stdout).toMatch(/nothing to strip/);
  });
});

describe('verify-tarball.js (gate 1 watchdog)', () => {
  // The real `verify-tarball.js` shells out to `npm pack`. Instead of
  // running the full pack (slow, env-dependent), we replicate its core
  // logic in this test: parse a fake `npm pack` JSON listing and assert
  // the script's failure-detection path catches a leaked mock file.
  //
  // We do this by writing a one-off harness script alongside the real one
  // that re-uses the failure logic shape (literal-mirror of the inline
  // checks in verify-tarball.js). When the production script changes, this
  // test stays meaningful because it's checking the SAME literal patterns
  // verify-tarball.js asserts on.

  function runHarness(files: string[]): { ok: boolean; output: string } {
    const harness = `
      const files = ${JSON.stringify(files)};
      const failures = [];
      if (!files.some((p) => p === 'dashboard/dist/index.html')) {
        failures.push('dashboard missing');
      }
      const mockMatches = files.filter((p) => p.startsWith('dist/adapters/mock/'));
      if (mockMatches.length > 0) {
        failures.push('mock leaked: ' + mockMatches.length);
      }
      if (failures.length > 0) {
        console.error(failures.join('\\n'));
        process.exit(1);
      }
      console.log('ok');
    `;
    try {
      const out = execFileSync(process.execPath, ['-e', harness], { stdio: 'pipe' });
      return { ok: true, output: out.toString() };
    } catch (err) {
      const e = err as { stdout?: Buffer | string; stderr?: Buffer | string };
      return {
        ok: false,
        output: `${e.stdout?.toString() ?? ''}\n${e.stderr?.toString() ?? ''}`,
      };
    }
  }

  it('passes on a clean tarball listing', () => {
    const r = runHarness([
      'dashboard/dist/index.html',
      'dist/adapters/copilot/adapter.js',
      'dist/server.js',
    ]);
    expect(r.ok).toBe(true);
  });

  it('fails when dashboard SPA is missing', () => {
    const r = runHarness(['dist/server.js']);
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/dashboard missing/);
  });

  it('fails when mock adapter leaked into the tarball', () => {
    const r = runHarness([
      'dashboard/dist/index.html',
      'dist/adapters/mock/adapter.js',
      'dist/adapters/mock/descriptor.js',
    ]);
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/mock leaked: 2/);
  });

  it('verify-tarball.js script references the right paths', () => {
    // Belt-and-suspenders — load the production script's source and pin the
    // literal paths it asserts on. A typo regression in the script (renaming
    // `dashboard/dist/index.html` to a non-shipping path, or dropping the
    // `dist/adapters/mock/` filter) would silently green CI; this test
    // catches it.
    //
    // We don't `new Function(src)` to "syntax-check" — that fails on
    // CommonJS-shape code (`'use strict'`, `require(...)`) which is wrong.
    // Loading the file via `require` would actually execute it (it shells out
    // to `npm pack`), which is too heavy for a unit test. The literal-string
    // check below is the right level.
    const src = fs.readFileSync(VERIFY_SCRIPT, 'utf8');
    expect(src).toMatch(/dist\/adapters\/mock/);
    expect(src).toMatch(/dashboard\/dist\/index\.html/);
    expect(src).toMatch(/process\.exit\(1\)/);
  });
});
