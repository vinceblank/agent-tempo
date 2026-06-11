/**
 * Unit tests for the #749 (T0.2) SDK-poller idle backoff —
 * `src/adapters/sdk/idle-backoff.ts`.
 *
 * The class is pure (no timers): tests assert the delay sequence directly.
 * Contract under test (issue #749 AC):
 *   - active conversation (delivered messages) → stays at the 2s base
 *   - consecutive empty polls → grow by 1.5× toward the 30s cap
 *   - any delivered message → snap back to base
 *   - env overrides honored at construction; MAX==BASE pins fixed cadence
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  IdleBackoff,
  resolveIdleBackoffConfig,
  SDK_POLL_BASE_MS,
  SDK_POLL_BACKOFF_FACTOR,
  SDK_POLL_MAX_MS,
} from '../../src/adapters/sdk/idle-backoff';
import { ENV } from '../../src/config';

afterEach(() => {
  delete process.env[ENV.SDK_POLL_BASE_MS];
  delete process.env[ENV.SDK_POLL_MAX_MS];
});

describe('IdleBackoff (#749)', () => {
  it('starts at the base cadence', () => {
    expect(new IdleBackoff().current).toBe(SDK_POLL_BASE_MS);
  });

  it('active polls stay at base — legacy 2s responsiveness preserved', () => {
    const b = new IdleBackoff();
    expect(b.next(true)).toBe(SDK_POLL_BASE_MS);
    expect(b.next(true)).toBe(SDK_POLL_BASE_MS);
  });

  it('empty polls grow by the factor: 2s → 3s → 4.5s → …', () => {
    const b = new IdleBackoff();
    expect(b.next(false)).toBe(SDK_POLL_BASE_MS * SDK_POLL_BACKOFF_FACTOR);          // 3000
    expect(b.next(false)).toBe(SDK_POLL_BASE_MS * SDK_POLL_BACKOFF_FACTOR ** 2);     // 4500
    expect(b.next(false)).toBe(SDK_POLL_BASE_MS * SDK_POLL_BACKOFF_FACTOR ** 3);     // 6750
  });

  it('caps at the max and stays there while idle', () => {
    const b = new IdleBackoff();
    for (let i = 0; i < 50; i++) b.next(false);
    expect(b.current).toBe(SDK_POLL_MAX_MS);
    expect(b.next(false)).toBe(SDK_POLL_MAX_MS);
  });

  it('a delivered message snaps back to base from the cap', () => {
    const b = new IdleBackoff();
    for (let i = 0; i < 50; i++) b.next(false);
    expect(b.next(true)).toBe(SDK_POLL_BASE_MS);
    // …and idle growth restarts from base, not from the old curve position.
    expect(b.next(false)).toBe(SDK_POLL_BASE_MS * SDK_POLL_BACKOFF_FACTOR);
  });

  it('reset() snaps back to base (external-activity hook)', () => {
    const b = new IdleBackoff();
    for (let i = 0; i < 10; i++) b.next(false);
    b.reset();
    expect(b.current).toBe(SDK_POLL_BASE_MS);
  });

  it('steady-state idle cadence is ~16× cheaper than fixed 2s (the T0.2 win)', () => {
    // Cadence math used in the PR body: 86,400s/day ÷ 2s = 43,200 polls
    // vs 86,400 ÷ 30s = 2,880 polls. Lock the ratio so a future constant
    // tweak consciously re-derives the cost claim.
    expect((86_400 / (SDK_POLL_BASE_MS / 1000)) / (86_400 / (SDK_POLL_MAX_MS / 1000))).toBe(15);
  });
});

describe('resolveIdleBackoffConfig — env overrides', () => {
  it('defaults when env is unset', () => {
    expect(resolveIdleBackoffConfig()).toEqual({
      baseMs: SDK_POLL_BASE_MS,
      factor: SDK_POLL_BACKOFF_FACTOR,
      maxMs: SDK_POLL_MAX_MS,
    });
  });

  it('honors base + max overrides', () => {
    process.env[ENV.SDK_POLL_BASE_MS] = '100';
    process.env[ENV.SDK_POLL_MAX_MS] = '500';
    const b = new IdleBackoff();
    expect(b.next(false)).toBe(150);
    for (let i = 0; i < 20; i++) b.next(false);
    expect(b.current).toBe(500);
  });

  it('MAX == BASE pins the legacy fixed cadence (dev/test escape hatch)', () => {
    process.env[ENV.SDK_POLL_BASE_MS] = '2000';
    process.env[ENV.SDK_POLL_MAX_MS] = '2000';
    const b = new IdleBackoff();
    expect(b.next(false)).toBe(2000);
    expect(b.next(false)).toBe(2000);
  });

  it('clamps MAX below BASE up to BASE (never poll faster when idle than active)', () => {
    process.env[ENV.SDK_POLL_BASE_MS] = '5000';
    process.env[ENV.SDK_POLL_MAX_MS] = '1000';
    expect(resolveIdleBackoffConfig()).toMatchObject({ baseMs: 5000, maxMs: 5000 });
  });

  it('garbage env values fall back to defaults', () => {
    process.env[ENV.SDK_POLL_BASE_MS] = 'fast-please';
    process.env[ENV.SDK_POLL_MAX_MS] = '-1';
    expect(resolveIdleBackoffConfig()).toMatchObject({
      baseMs: SDK_POLL_BASE_MS,
      maxMs: SDK_POLL_MAX_MS,
    });
  });
});
