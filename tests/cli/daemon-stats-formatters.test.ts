/**
 * Pure-formatter tests for the `daemon stats` CLI subcommand (#336).
 * The HTTP-fetch + render path lives in `src/cli/daemon-command.ts`;
 * this file exercises only the byte/uptime formatters, which are
 * defensive-by-design (must never crash on missing or malformed wire
 * data because the daemon may be a pre-#336 build).
 */
import { describe, it, expect } from 'vitest';
import {
  formatBytesAsMb,
  formatUptime,
} from '../../src/cli/daemon-command';

describe('formatBytesAsMb (#336)', () => {
  it('rounds bytes to whole MB', () => {
    expect(formatBytesAsMb(0)).toBe('0 MB');
    expect(formatBytesAsMb(1024 * 1024)).toBe('1 MB');
    expect(formatBytesAsMb(1.5 * 1024 * 1024)).toBe('2 MB');
    expect(formatBytesAsMb(1.1 * 1024 * 1024 * 1024)).toBe('1126 MB'); // ~1.1 GB
  });

  it('returns "n/a" for non-numeric or non-finite input', () => {
    // Pre-#336 daemons won't include the `memory` field, so the wire shape
    // has unknown-typed fields — the formatter must not crash.
    expect(formatBytesAsMb(undefined)).toBe('n/a');
    expect(formatBytesAsMb(null)).toBe('n/a');
    expect(formatBytesAsMb('1024')).toBe('n/a');
    expect(formatBytesAsMb(NaN)).toBe('n/a');
    expect(formatBytesAsMb(Infinity)).toBe('n/a');
  });
});

describe('formatUptime (#336)', () => {
  it('renders sub-minute uptime as seconds only', () => {
    expect(formatUptime(0)).toBe('0s');
    expect(formatUptime(45_000)).toBe('45s');
  });

  it('renders sub-hour uptime as minutes + seconds', () => {
    expect(formatUptime(60_000)).toBe('1m 0s');
    expect(formatUptime(125_000)).toBe('2m 5s');
  });

  it('renders multi-hour uptime as hours + minutes + seconds', () => {
    // 17h 23m 5s — matches the magnitude of the original #336 observation
    // (1.1 GB after ~17h runtime).
    const ms = (17 * 3600 + 23 * 60 + 5) * 1000;
    expect(formatUptime(ms)).toBe('17h 23m 5s');
  });

  it('returns "n/a" for non-numeric, non-finite, or negative input', () => {
    expect(formatUptime(undefined)).toBe('n/a');
    expect(formatUptime('17h')).toBe('n/a');
    expect(formatUptime(NaN)).toBe('n/a');
    expect(formatUptime(-1)).toBe('n/a');
  });
});
