/**
 * Unit tests for `bootstrap` + its building blocks (#289).
 *
 * The full `bootstrap()` wires real `execFileSync` / `fetch` / Temporal
 * connections — not suitable for Vitest. This file covers:
 *   - cache read/write/invalidation
 *   - `classifyVersion` semver policy (the entire truth table)
 *   - `isCacheFresh` TTL math
 *
 * Integration-ish whole-bootstrap coverage lives in `test/startup.test.ts`
 * (Mocha) where we stub out the same boundaries with full control.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  readCache,
  writeCache,
  isCacheFresh,
  classifyVersion,
} from '../../src/cli/startup';

describe('startup cache', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tempo-startup-test-'));
  });
  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('returns an empty cache when the file is missing', () => {
    const c = readCache(tmpDir, '0.26.0');
    expect(c.schemaVersion).toBe(1);
    expect(c.binaryVersion).toBe('0.26.0');
    expect(c.steps).toEqual({});
  });

  it('returns empty on malformed JSON', () => {
    fs.writeFileSync(path.join(tmpDir, '.bootstrap-cache.json'), '{ this is: not json');
    const c = readCache(tmpDir, '0.26.0');
    expect(c.steps).toEqual({});
  });

  it('invalidates on schemaVersion mismatch', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.bootstrap-cache.json'),
      JSON.stringify({ schemaVersion: 99, binaryVersion: '0.26.0', steps: { preflight: { lastSuccess: '2026-04-21T00:00:00Z' } } }),
    );
    const c = readCache(tmpDir, '0.26.0');
    expect(c.steps).toEqual({});
  });

  it('invalidates on binaryVersion mismatch (upgrade path)', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.bootstrap-cache.json'),
      JSON.stringify({ schemaVersion: 1, binaryVersion: '0.25.0', steps: { preflight: { lastSuccess: '2026-04-21T00:00:00Z' } } }),
    );
    const c = readCache(tmpDir, '0.26.0');
    expect(c.steps).toEqual({});
  });

  it('round-trips a valid cache', () => {
    const now = new Date('2026-04-21T00:00:00Z').toISOString();
    writeCache(tmpDir, {
      schemaVersion: 1,
      binaryVersion: '0.26.0',
      steps: {
        preflight: { lastSuccess: now },
        mcpConfig: { lastSuccess: now, configMtime: '2026-04-20T12:00:00Z' },
      },
    });
    const c = readCache(tmpDir, '0.26.0');
    expect(c.steps.preflight?.lastSuccess).toBe(now);
    expect(c.steps.mcpConfig?.configMtime).toBe('2026-04-20T12:00:00Z');
  });

  it('write tolerates missing cache dir (creates it)', () => {
    const nested = path.join(tmpDir, 'does', 'not', 'exist');
    writeCache(nested, { schemaVersion: 1, binaryVersion: '0.26.0', steps: {} });
    expect(fs.existsSync(path.join(nested, '.bootstrap-cache.json'))).toBe(true);
  });
});

describe('isCacheFresh', () => {
  const now = Date.parse('2026-04-21T12:00:00Z');
  const ttl24h = 24 * 60 * 60 * 1000;
  const ttl60s = 60 * 1000;

  it('returns false for undefined entry', () => {
    expect(isCacheFresh(undefined, ttl24h, now)).toBe(false);
  });
  it('returns false when lastSuccess is missing', () => {
    expect(isCacheFresh({ lastSuccess: '' }, ttl24h, now)).toBe(false);
  });
  it('returns false when lastSuccess is unparseable', () => {
    expect(isCacheFresh({ lastSuccess: 'not-an-iso' }, ttl24h, now)).toBe(false);
  });
  it('returns true within TTL', () => {
    const fresh = new Date(now - 3600_000).toISOString(); // 1h ago
    expect(isCacheFresh({ lastSuccess: fresh }, ttl24h, now)).toBe(true);
  });
  it('returns false past TTL', () => {
    const stale = new Date(now - 2 * ttl24h).toISOString();
    expect(isCacheFresh({ lastSuccess: stale }, ttl24h, now)).toBe(false);
  });
  it('60s TTL is exact boundary', () => {
    const justInside = new Date(now - 59_000).toISOString();
    const justOutside = new Date(now - 61_000).toISOString();
    expect(isCacheFresh({ lastSuccess: justInside }, ttl60s, now)).toBe(true);
    expect(isCacheFresh({ lastSuccess: justOutside }, ttl60s, now)).toBe(false);
  });
});

describe('classifyVersion (#289 pin item 4 — semver policy)', () => {
  it('up-to-date → undefined', () => {
    expect(classifyVersion('0.26.0', '0.26.0')).toBeUndefined();
  });

  it('installed newer than latest → undefined (don\'t downgrade)', () => {
    expect(classifyVersion('0.27.0', '0.26.0')).toBeUndefined();
  });

  it('patch behind → silent (undefined)', () => {
    expect(classifyVersion('0.26.0', '0.26.1')).toBeUndefined();
    expect(classifyVersion('0.26.1', '0.26.3')).toBeUndefined();
  });

  it('minor behind → normal badge', () => {
    const result = classifyVersion('0.25.0', '0.26.0');
    expect(result).toEqual({ latest: '0.26.0', severity: 'minor' });
  });

  it('major behind → prominent badge', () => {
    const result = classifyVersion('0.26.0', '1.0.0');
    expect(result).toEqual({ latest: '1.0.0', severity: 'major' });
  });

  it('prerelease installed vs stable latest → silent (user opted into beta)', () => {
    expect(classifyVersion('0.26.0-beta.3', '0.26.0')).toBeUndefined();
    expect(classifyVersion('0.25.0-rc.1', '0.26.0')).toBeUndefined();
  });

  it('stable installed vs prerelease latest → silent (don\'t recommend prereleases)', () => {
    expect(classifyVersion('0.26.0', '0.27.0-beta.1')).toBeUndefined();
  });

  it('prerelease iteration within same minor → silent', () => {
    expect(classifyVersion('0.26.0-beta.1', '0.26.0-beta.7')).toBeUndefined();
  });

  it('prerelease of prior major + newer prerelease → still badged (different minor)', () => {
    // Both prereleases, different minor version — treat as minor-behind.
    // This is the boundary case: `i.major === l.major && i.minor === l.minor`
    // is the silent rule; otherwise standard diff applies.
    const result = classifyVersion('0.25.0-beta.1', '0.27.0-beta.1');
    expect(result?.severity).toBe('minor');
  });

  it('invalid installed → undefined (can\'t classify unknown)', () => {
    expect(classifyVersion('nonsense', '0.26.0')).toBeUndefined();
  });
  it('invalid latest → undefined', () => {
    expect(classifyVersion('0.26.0', 'nonsense')).toBeUndefined();
  });
});
