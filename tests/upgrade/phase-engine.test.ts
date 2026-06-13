/**
 * Unit coverage for the `upgrade-to-2` phase-engine PURE helpers (issue #785) —
 * the version-floor logic that drives the multi-host preflight refusal. The
 * Temporal-touching orchestration (pause/drain/snapshot/destroy/resume) is
 * exercised by the mocha TestWorkflowEnvironment suite; this file pins the
 * decision logic that must NOT regress, including the classic lexical
 * version-comparison footgun (`'1.10.0' < '1.8.0'` as strings).
 */
import { describe, it, expect } from 'vitest';
import {
  parseMajorMinor,
  meetsVersionFloor,
  preflightVersions,
  DEFAULT_VERSION_FLOOR,
} from '../../src/upgrade/phase-engine';

describe('phase-engine — parseMajorMinor', () => {
  it('parses plain + v-prefixed versions', () => {
    expect(parseMajorMinor('1.8.0')).toEqual({ major: 1, minor: 8 });
    expect(parseMajorMinor('v1.8.0')).toEqual({ major: 1, minor: 8 });
    expect(parseMajorMinor('  1.8.0  ')).toEqual({ major: 1, minor: 8 });
  });

  it('parses double-digit minors and prereleases', () => {
    expect(parseMajorMinor('1.10.3')).toEqual({ major: 1, minor: 10 });
    expect(parseMajorMinor('2.0.0-beta.1')).toEqual({ major: 2, minor: 0 });
    expect(parseMajorMinor('1.8.0-beta.8')).toEqual({ major: 1, minor: 8 });
  });

  it('returns null for unparseable input', () => {
    expect(parseMajorMinor('garbage')).toBeNull();
    expect(parseMajorMinor('')).toBeNull();
    expect(parseMajorMinor('v')).toBeNull();
  });
});

describe('phase-engine — meetsVersionFloor', () => {
  const FLOOR = '1.8.0';

  it('accepts the exact floor', () => {
    expect(meetsVersionFloor('1.8.0', FLOOR)).toBe(true);
  });

  it('accepts prereleases of the floor line (lenient on -beta)', () => {
    // The cutover ships IN 1.8.0; a 1.8.0-beta.N daemon rides the same line
    // and carries the cutover-compatible code, so it must NOT be refused.
    expect(meetsVersionFloor('1.8.0-beta.8', FLOOR)).toBe(true);
  });

  it('accepts a higher minor — and does NOT regress to lexical comparison', () => {
    // '1.10.0' < '1.8.0' as STRINGS — the bug this guards against.
    expect(meetsVersionFloor('1.10.0', FLOOR)).toBe(true);
    expect('1.10.0' < '1.8.0').toBe(true); // proves the lexical trap is real
  });

  it('accepts a higher major', () => {
    expect(meetsVersionFloor('2.0.0', FLOOR)).toBe(true);
  });

  it('rejects a lower minor on the same major', () => {
    expect(meetsVersionFloor('1.7.9', FLOOR)).toBe(false);
  });

  it('rejects a lower major', () => {
    expect(meetsVersionFloor('0.28.0', FLOOR)).toBe(false);
  });

  it('rejects unknown / unparseable / undefined (refuse, never assume safe)', () => {
    expect(meetsVersionFloor(undefined, FLOOR)).toBe(false);
    expect(meetsVersionFloor('', FLOOR)).toBe(false);
    expect(meetsVersionFloor('garbage', FLOOR)).toBe(false);
  });

  it('uses 1.8.0 as the shipped default floor', () => {
    expect(DEFAULT_VERSION_FLOOR).toBe('1.8.0');
  });
});

describe('phase-engine — preflightVersions', () => {
  it('returns no refusals when every host meets the floor', () => {
    const profiles = {
      'box-1': { version: '1.8.0' },
      'box-2': { version: '1.9.2' },
      'box-3': { version: '2.0.0-beta.1' },
    };
    expect(preflightVersions(profiles, '1.8.0')).toEqual([]);
  });

  it('refuses a host below the floor, with hostname + version + reason', () => {
    const refusals = preflightVersions(
      { 'box-1': { version: '1.8.0' }, 'box-old': { version: '1.7.5' } },
      '1.8.0',
    );
    expect(refusals).toHaveLength(1);
    expect(refusals[0].hostname).toBe('box-old');
    expect(refusals[0].version).toBe('1.7.5');
    expect(refusals[0].reason).toMatch(/below the required 1\.8\.0/);
  });

  it('refuses a host advertising no version (reports `unknown`)', () => {
    const refusals = preflightVersions({ 'box-x': {} }, '1.8.0');
    expect(refusals).toHaveLength(1);
    expect(refusals[0].version).toBe('unknown');
  });

  it('refuses EVERY stale host (same-host-stale-daemon included, #801)', () => {
    const refusals = preflightVersions(
      { 'box-1': { version: '1.7.0' }, 'box-2': { version: '0.28.0' } },
      '1.8.0',
    );
    expect(refusals.map((r) => r.hostname).sort()).toEqual(['box-1', 'box-2']);
  });

  it('defaults the floor to 1.8.0', () => {
    expect(preflightVersions({ h: { version: '1.7.0' } })).toHaveLength(1);
    expect(preflightVersions({ h: { version: '1.8.0' } })).toEqual([]);
  });

  it('returns no refusals for an empty profile set (single-host assumption)', () => {
    expect(preflightVersions({}, '1.8.0')).toEqual([]);
  });
});
