/**
 * Unit tests for #563 ensemble active/dormant classification.
 *
 * Targets the pure `classifyDormancy` helper. The rendering layer + Zod
 * arg parsing are exercised via the existing integration suite; here we
 * lock down the threshold logic that the rendering depends on.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyDormancy,
  DORMANT_THRESHOLD_MS,
} from '../../src/tools/ensemble';
import { formatTimeAgo } from '../../src/utils/duration';

/** Fixed reference time for deterministic tests. */
const NOW = Date.parse('2026-05-11T12:00:00.000Z');

/** Make an ISO timestamp at `offsetMs` before NOW. */
function iso(offsetMs: number): string {
  return new Date(NOW - offsetMs).toISOString();
}

describe('classifyDormancy', () => {
  it('returns active for an undefined phase (pre-attachment-lifecycle session)', () => {
    expect(classifyDormancy({ phase: undefined, lastActivityAt: undefined }, NOW)).toBe('active');
  });

  it('returns active for processing phase', () => {
    expect(classifyDormancy({ phase: 'processing' }, NOW)).toBe('active');
  });

  it('returns active for awaiting phase regardless of last-activity age', () => {
    // Awaiting is "live but idle." Even if the conductor has been awaiting
    // for hours, the attachment is alive and the player isn't dormant.
    expect(classifyDormancy(
      { phase: 'awaiting', lastActivityAt: iso(10 * 3_600_000) },
      NOW,
    )).toBe('active');
  });

  it('returns active for attached phase regardless of last-activity age', () => {
    expect(classifyDormancy(
      { phase: 'attached', lastActivityAt: iso(2 * 3_600_000) },
      NOW,
    )).toBe('active');
  });

  it('returns active for booting phase', () => {
    expect(classifyDormancy({ phase: 'booting' }, NOW)).toBe('active');
  });

  it('returns active for draining phase (still tearing down)', () => {
    expect(classifyDormancy({ phase: 'draining' }, NOW)).toBe('active');
  });

  it('returns dormant for gone phase regardless of last-activity', () => {
    expect(classifyDormancy({ phase: 'gone' }, NOW)).toBe('dormant');
    expect(classifyDormancy(
      { phase: 'gone', lastActivityAt: iso(1000) /* 1s ago */ },
      NOW,
    )).toBe('dormant');
  });

  it('returns active for detached with recent activity (< threshold)', () => {
    // 30m ago, threshold is 1h → still active.
    expect(classifyDormancy(
      { phase: 'detached', lastActivityAt: iso(30 * 60_000) },
      NOW,
    )).toBe('active');
  });

  it('returns dormant for detached with old activity (> threshold)', () => {
    // 2h ago, threshold is 1h → dormant.
    expect(classifyDormancy(
      { phase: 'detached', lastActivityAt: iso(2 * 3_600_000) },
      NOW,
    )).toBe('dormant');
  });

  it('threshold boundary: exactly threshold-ms ago → still active', () => {
    // The check is `now - lastMs > threshold`, strictly greater, so equal
    // is active. This matches the "last activity > 1 hour ago" wording.
    expect(classifyDormancy(
      { phase: 'detached', lastActivityAt: iso(DORMANT_THRESHOLD_MS) },
      NOW,
    )).toBe('active');
  });

  it('threshold boundary: 1ms over threshold → dormant', () => {
    expect(classifyDormancy(
      { phase: 'detached', lastActivityAt: iso(DORMANT_THRESHOLD_MS + 1) },
      NOW,
    )).toBe('dormant');
  });

  it('returns dormant for detached with missing lastActivityAt (pre-W2 session)', () => {
    // The session predates the W2 activity-state query. We can't compute
    // age — treat as dormant so the operator's declutter intent wins.
    expect(classifyDormancy({ phase: 'detached', lastActivityAt: undefined }, NOW)).toBe('dormant');
  });

  it('returns dormant for detached with unparseable lastActivityAt', () => {
    // Defensive: garbage timestamp falls through the same path as missing.
    expect(classifyDormancy(
      { phase: 'detached', lastActivityAt: 'not-an-iso-date' },
      NOW,
    )).toBe('dormant');
  });

  it('respects a custom threshold override', () => {
    // 30m ago, threshold passed as 15m → dormant.
    expect(classifyDormancy(
      { phase: 'detached', lastActivityAt: iso(30 * 60_000) },
      NOW,
      15 * 60_000,
    )).toBe('dormant');

    // Same activity time, threshold passed as 1h → active.
    expect(classifyDormancy(
      { phase: 'detached', lastActivityAt: iso(30 * 60_000) },
      NOW,
      60 * 60_000,
    )).toBe('active');
  });
});

describe('formatTimeAgo', () => {
  it('returns "just now" for sub-second deltas', () => {
    expect(formatTimeAgo(iso(0), NOW)).toBe('just now');
    expect(formatTimeAgo(iso(500), NOW)).toBe('just now');
  });

  it('renders seconds, minutes, hours, days at the correct cutoffs', () => {
    expect(formatTimeAgo(iso(1500), NOW)).toBe('1s ago');
    expect(formatTimeAgo(iso(45 * 1000), NOW)).toBe('45s ago');
    expect(formatTimeAgo(iso(2 * 60_000), NOW)).toBe('2m ago');
    expect(formatTimeAgo(iso(59 * 60_000), NOW)).toBe('59m ago');
    expect(formatTimeAgo(iso(3 * 3_600_000), NOW)).toBe('3h ago');
    expect(formatTimeAgo(iso(23 * 3_600_000), NOW)).toBe('23h ago');
    expect(formatTimeAgo(iso(2 * 86_400_000), NOW)).toBe('2d ago');
  });

  it('returns "unknown" for an unparseable timestamp', () => {
    expect(formatTimeAgo('garbage', NOW)).toBe('unknown');
  });

  it('defaults `now` to Date.now() when not provided', () => {
    // Don't fix the value (would be flaky); just confirm shape.
    const recent = new Date(Date.now() - 5000).toISOString();
    expect(formatTimeAgo(recent)).toMatch(/^[45]s ago$/);
  });
});
