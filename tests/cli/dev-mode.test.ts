/**
 * Unit tests for the dev profile gate (ADR 0014 §5.2). Coverage:
 *   - `isDevMode()` returns true for `'1'` and `'true'` (case-insensitive).
 *   - Returns false for unset, empty, and any other value.
 *   - Negative case (env unset) explicitly tested per architect's gate-1
 *     production-safety contract.
 *
 * `isDevMode()` is the single source of truth — every downstream layer
 * (paths, namespace, port, task queue, banner, namespace auto-create,
 * future PR-2 registry registration) consults it. Pinning this contract
 * is what keeps the dev profile from drifting into production.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ENV, isDevMode } from '../../src/config';

describe('isDevMode (ADR 0014 §5.2)', () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env[ENV.DEV_MODE];
    delete process.env[ENV.DEV_MODE];
  });

  afterEach(() => {
    if (savedEnv == null) delete process.env[ENV.DEV_MODE];
    else process.env[ENV.DEV_MODE] = savedEnv;
  });

  it('returns false when the env var is unset', () => {
    expect(isDevMode()).toBe(false);
  });

  it('returns false for the empty string', () => {
    process.env[ENV.DEV_MODE] = '';
    expect(isDevMode()).toBe(false);
  });

  it('returns true for "1"', () => {
    process.env[ENV.DEV_MODE] = '1';
    expect(isDevMode()).toBe(true);
  });

  it('returns true for "true" (lowercase)', () => {
    process.env[ENV.DEV_MODE] = 'true';
    expect(isDevMode()).toBe(true);
  });

  it('returns true for "True" / "TRUE" (case-insensitive)', () => {
    process.env[ENV.DEV_MODE] = 'True';
    expect(isDevMode()).toBe(true);
    process.env[ENV.DEV_MODE] = 'TRUE';
    expect(isDevMode()).toBe(true);
  });

  it('returns false for "0", "false", "no", or other truthy-looking strings', () => {
    // The gate is intentionally strict — only `1` and `true` flip dev mode.
    // Any other value (even an existing-but-falsy string) is treated as
    // production, so that an accidental `CLAUDE_TEMPO_DEV_MODE=0` in a
    // shell rc file doesn't quietly stay in dev mode.
    for (const v of ['0', 'false', 'no', 'off', 'yes', 'on', 'enabled']) {
      process.env[ENV.DEV_MODE] = v;
      expect(isDevMode(), `value "${v}" should be production`).toBe(false);
    }
  });
});
