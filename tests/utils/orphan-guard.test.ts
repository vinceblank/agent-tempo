/**
 * Unit tests for the #704 Item 1b late-orphan discriminator
 * (`shouldSelfExitAsOrphan`).
 *
 * The discriminator is the running-run × close-reason PAIR: a process self-exits
 * as an orphan ONLY when (no running run) AND (the closed run carries a typed
 * tombstone close-reason within the TTL). Every managed re-creation
 * (recruit / restart / migrate / up) pre-creates a RUNNING run, so this guard
 * never false-exits a legit reuse.
 */
import { describe, it, expect } from 'vitest';
import { shouldSelfExitAsOrphan } from '../../src/utils/orphan-guard';

const TTL = 6 * 60 * 60 * 1000; // 6h
const NOW = 1_000_000_000_000;

describe('shouldSelfExitAsOrphan', () => {
  it('returns false when a RUNNING run exists (legit recruit/restart/migrate/up pre-created it)', () => {
    // Even with a (stale) tombstone reason, a RUNNING status short-circuits.
    expect(
      shouldSelfExitAsOrphan(
        { statusName: 'RUNNING', closeReason: 'destroyed', closeTimeMs: 0 },
        TTL,
        NOW,
      ),
    ).toBe(false);
  });

  it('returns true for a destroyed close within the TTL (no running run)', () => {
    expect(
      shouldSelfExitAsOrphan(
        { statusName: 'COMPLETED', closeReason: 'destroyed', closeTimeMs: NOW - 60_000 },
        TTL,
        NOW,
      ),
    ).toBe(true);
  });

  it('returns true for a boot-timeout close within the TTL', () => {
    expect(
      shouldSelfExitAsOrphan(
        { statusName: 'COMPLETED', closeReason: 'boot-timeout', closeTimeMs: NOW - 90 * 60_000 },
        TTL,
        NOW,
      ),
    ).toBe(true);
  });

  it('catches the actual incident timing (~100min orphan delay) with the 6h default', () => {
    // The #704 orphan booted ~100min after its run closed — a 10min TTL would
    // miss it. The generous default comfortably covers it.
    expect(
      shouldSelfExitAsOrphan(
        { statusName: 'COMPLETED', closeReason: 'boot-timeout', closeTimeMs: NOW - 100 * 60_000 },
        TTL,
        NOW,
      ),
    ).toBe(true);
  });

  it('returns false once the tombstone ages past the TTL (legit much-later reuse)', () => {
    expect(
      shouldSelfExitAsOrphan(
        { statusName: 'COMPLETED', closeReason: 'destroyed', closeTimeMs: NOW - (TTL + 1) },
        TTL,
        NOW,
      ),
    ).toBe(false);
  });

  it('returns false for a closed run with no close-reason memo (clean completion / pre-#704)', () => {
    expect(
      shouldSelfExitAsOrphan(
        { statusName: 'COMPLETED', closeReason: undefined, closeTimeMs: NOW - 1_000 },
        TTL,
        NOW,
      ),
    ).toBe(false);
  });

  it('returns false for a non-tombstone close-reason', () => {
    expect(
      shouldSelfExitAsOrphan(
        { statusName: 'TERMINATED', closeReason: 'some-other-reason', closeTimeMs: NOW - 1_000 },
        TTL,
        NOW,
      ),
    ).toBe(false);
  });

  it('returns false when closeTime is missing/unknown (cannot bound staleness)', () => {
    expect(
      shouldSelfExitAsOrphan(
        { statusName: 'COMPLETED', closeReason: 'destroyed', closeTimeMs: 0 },
        TTL,
        NOW,
      ),
    ).toBe(false);
  });

  it('honors a custom (shorter) TTL', () => {
    const shortTtl = 10 * 60_000; // 10min
    expect(
      shouldSelfExitAsOrphan(
        { statusName: 'COMPLETED', closeReason: 'destroyed', closeTimeMs: NOW - 5 * 60_000 },
        shortTtl,
        NOW,
      ),
    ).toBe(true);
    expect(
      shouldSelfExitAsOrphan(
        { statusName: 'COMPLETED', closeReason: 'destroyed', closeTimeMs: NOW - 20 * 60_000 },
        shortTtl,
        NOW,
      ),
    ).toBe(false);
  });
});
