/**
 * Unit tests for dashboard time-format helpers (#431).
 *
 * Covers `formatDuration` boundary cases — sub-minute returns `"<1m"`,
 * not a raw seconds value, so EnsembleCard uptime is never "0s".
 */
import { describe, it, expect } from 'vitest';
import { formatDuration } from '../../dashboard/src/lib/time-format';

describe('formatDuration', () => {
  it('returns "—" for undefined', () => {
    expect(formatDuration(undefined)).toBe('—');
  });

  it('returns "—" for negative values (clock skew)', () => {
    expect(formatDuration(-1000)).toBe('—');
  });

  it('returns "—" for NaN', () => {
    expect(formatDuration(NaN)).toBe('—');
  });

  it('returns "<1m" for 0 ms (brand-new ensemble)', () => {
    expect(formatDuration(0)).toBe('<1m');
  });

  it('returns "<1m" for sub-minute (30 000 ms)', () => {
    expect(formatDuration(30_000)).toBe('<1m');
  });

  it('returns "<1m" for exactly 59 999 ms', () => {
    expect(formatDuration(59_999)).toBe('<1m');
  });

  it('returns "1m" for exactly 60 000 ms', () => {
    expect(formatDuration(60_000)).toBe('1m');
  });

  it('returns "59m" for 59 minutes', () => {
    expect(formatDuration(59 * 60_000)).toBe('59m');
  });

  it('returns "1h" for exactly 1 hour (no trailing 0m)', () => {
    expect(formatDuration(60 * 60_000)).toBe('1h');
  });

  it('returns "1h 14m" for 1 h 14 m', () => {
    expect(formatDuration((60 + 14) * 60_000)).toBe('1h 14m');
  });

  it('returns "23h" for 23 hours (no trailing 0m)', () => {
    expect(formatDuration(23 * 60 * 60_000)).toBe('23h');
  });

  it('returns "1d" for exactly 24 hours', () => {
    expect(formatDuration(24 * 60 * 60_000)).toBe('1d');
  });

  it('returns "1d 3h" for 27 hours', () => {
    expect(formatDuration(27 * 60 * 60_000)).toBe('1d 3h');
  });
});
