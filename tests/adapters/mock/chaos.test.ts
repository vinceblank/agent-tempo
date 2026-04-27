/**
 * Unit tests for chaos mode (PR-3 of #340-followup, ADR 0014 §4.2 / §4.6).
 * Pure module — no Temporal, no fs, no spawn.
 *
 * Coverage:
 *   - `mulberry32` produces a stable [0, 1) draw sequence per seed.
 *   - `chaosFromEnv` parses defaults / explicit / out-of-range values
 *     correctly, with one warn per offender (so typos surface loudly).
 *   - `decideChaosOutcome` honors crash > fail > echo precedence and
 *     consumes exactly two PRNG draws per call regardless of outcome
 *     (otherwise a chaos run with `crashRate=1` would shift the failRoll
 *     and break determinism).
 *   - Same seed → same outcome sequence over many iterations (the
 *     reproducibility contract chaos-mode tests rely on).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  CHAOS_DEFAULTS,
  CHAOS_ENV,
  chaosFromEnv,
  decideChaosOutcome,
  mulberry32,
} from '../../../src/adapters/mock/chaos';

describe('mulberry32', () => {
  it('returns a stable [0, 1) sequence for the same seed', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let i = 0; i < 50; i++) {
      const av = a();
      const bv = b();
      expect(av).toBeGreaterThanOrEqual(0);
      expect(av).toBeLessThan(1);
      expect(av).toBe(bv);
    }
  });

  it('produces different sequences for different seeds', () => {
    const a = mulberry32(1);
    const b = mulberry32(2);
    // Compare 20 draws — collision on every one would be astronomical.
    const aSeq = Array.from({ length: 20 }, () => a());
    const bSeq = Array.from({ length: 20 }, () => b());
    expect(aSeq).not.toEqual(bSeq);
  });
});

describe('chaosFromEnv', () => {
  it('returns defaults when no env vars are set', () => {
    const config = chaosFromEnv({}, () => { /* silent */ }, () => 12345);
    expect(config.delayMs).toBe(CHAOS_DEFAULTS.delayMs);
    expect(config.failRate).toBe(CHAOS_DEFAULTS.failRate);
    expect(config.crashRate).toBe(CHAOS_DEFAULTS.crashRate);
    expect(config.seed).toBe(12345);
  });

  it('parses explicit values', () => {
    const config = chaosFromEnv({
      [CHAOS_ENV.DELAY_MS]: '500',
      [CHAOS_ENV.FAIL_RATE]: '0.2',
      [CHAOS_ENV.CRASH_RATE]: '0.05',
      [CHAOS_ENV.SEED]: '7',
    }, () => { /* silent */ });
    expect(config.delayMs).toBe(500);
    expect(config.failRate).toBe(0.2);
    expect(config.crashRate).toBe(0.05);
    expect(config.seed).toBe(7);
  });

  it('clamps out-of-range rates and warns once per offender', () => {
    const warns: string[] = [];
    const config = chaosFromEnv({
      [CHAOS_ENV.FAIL_RATE]: '1.5',  // too high — clamps to 1
      [CHAOS_ENV.CRASH_RATE]: '-0.5', // too low — clamps to 0
    }, (msg) => warns.push(msg), () => 0);
    expect(config.failRate).toBe(1);
    expect(config.crashRate).toBe(0);
    expect(warns).toHaveLength(2);
    expect(warns[0]).toMatch(/FAIL_RATE/);
    expect(warns[1]).toMatch(/CRASH_RATE/);
  });

  it('falls back to clock when seed env var is non-numeric', () => {
    const warns: string[] = [];
    const fakeNow = vi.fn(() => 999);
    const config = chaosFromEnv({
      [CHAOS_ENV.SEED]: 'banana',
    }, (msg) => warns.push(msg), fakeNow);
    expect(config.seed).toBe(999);
    // The fake clock ran exactly once (the fall-through path).
    expect(fakeNow).toHaveBeenCalledTimes(1);
    expect(warns.find((w) => w.includes('SEED'))).toBeDefined();
  });

  it('treats an empty-string env value as unset (no warning)', () => {
    // Some shells set vars to empty rather than unsetting them; treat as
    // unset to avoid spurious warnings every CLI invocation.
    const warns: string[] = [];
    chaosFromEnv({ [CHAOS_ENV.FAIL_RATE]: '' }, (msg) => warns.push(msg), () => 0);
    expect(warns).toHaveLength(0);
  });
});

describe('decideChaosOutcome', () => {
  it('returns echo when crashRate=0 and failRate=0', () => {
    const prng = mulberry32(1);
    const result = decideChaosOutcome(prng, { delayMs: 0, crashRate: 0, failRate: 0 });
    expect(result.action).toBe('echo');
  });

  it('always crashes when crashRate=1', () => {
    const prng = mulberry32(1);
    const result = decideChaosOutcome(prng, { delayMs: 0, crashRate: 1, failRate: 1 });
    expect(result.action).toBe('crash');
  });

  it('always fails when crashRate=0 and failRate=1', () => {
    const prng = mulberry32(1);
    const result = decideChaosOutcome(prng, { delayMs: 0, crashRate: 0, failRate: 1 });
    expect(result.action).toBe('fail');
  });

  it('crash takes precedence over fail', () => {
    // Both rates are 1 — crash should win because it's checked first.
    const prng = mulberry32(1);
    const result = decideChaosOutcome(prng, { delayMs: 0, crashRate: 1, failRate: 1 });
    expect(result.action).toBe('crash');
  });

  it('consumes two PRNG draws per call regardless of outcome', () => {
    // Reproducibility contract: a `crash` decision must not "swallow" the
    // failRoll, otherwise downstream calls would drift between runs that
    // crashed and runs that didn't. Verified by checking the PRNG is at
    // the expected position after two calls.
    const prng = mulberry32(1);
    decideChaosOutcome(prng, { delayMs: 0, crashRate: 1, failRate: 0 });   // crash
    decideChaosOutcome(prng, { delayMs: 0, crashRate: 0, failRate: 0 });   // echo
    // After 4 draws (2 per call), the next draw should match a fresh
    // PRNG's 5th draw.
    const fresh = mulberry32(1);
    fresh(); fresh(); fresh(); fresh();
    expect(prng()).toBe(fresh());
  });

  it('produces a stable outcome sequence for the same seed', () => {
    const config = { delayMs: 0, crashRate: 0.1, failRate: 0.2 };
    const prngA = mulberry32(99);
    const prngB = mulberry32(99);
    const seqA = Array.from({ length: 30 }, () => decideChaosOutcome(prngA, config).action);
    const seqB = Array.from({ length: 30 }, () => decideChaosOutcome(prngB, config).action);
    expect(seqA).toEqual(seqB);
    // Sanity: with these rates, we expect SOME variety across 30 draws.
    expect(new Set(seqA).size).toBeGreaterThan(1);
  });

  it('propagates delayMs into every decision', () => {
    const prng = mulberry32(1);
    const result = decideChaosOutcome(prng, { delayMs: 250, crashRate: 0, failRate: 0 });
    expect(result.delayMs).toBe(250);
  });
});
