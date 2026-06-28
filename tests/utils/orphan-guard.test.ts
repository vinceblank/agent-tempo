/**
 * Unit tests for the late-orphan discriminator (`shouldSelfExitAsOrphan`).
 *
 * #897 (B2) replaced the #704 running-run × close-reason × wall-clock-TTL guess
 * with an EXACT identity TRIPLE: a process self-exits as an orphan ONLY when
 * (no running run) AND (the closed run carries a typed tombstone close-reason)
 * AND (the closed run's `sessionId` == THIS process's own spawn `sessionId`).
 * A legit re-recruit carries a fresh sessionId → never matches → never
 * false-exits, no matter how late; the true orphan carries the same sessionId
 * as its closed run → exits precisely. No TTL, no clock.
 */
import { describe, it, expect } from 'vitest';
import { shouldSelfExitAsOrphan } from '../../src/utils/orphan-guard';

const SID = 'sess-abc-123';
const OTHER_SID = 'sess-xyz-999';

describe('shouldSelfExitAsOrphan (#897 sessionId-match)', () => {
  it('returns false when a RUNNING run exists (legit recruit/restart/migrate/up pre-created it)', () => {
    // Even with a matching tombstone sessionId, a RUNNING status short-circuits.
    expect(
      shouldSelfExitAsOrphan(
        { statusName: 'RUNNING', closeReason: 'destroyed', closedSessionId: SID },
        SID,
      ),
    ).toBe(false);
  });

  it('returns true for a destroyed close whose sessionId matches mine (true orphan)', () => {
    expect(
      shouldSelfExitAsOrphan(
        { statusName: 'COMPLETED', closeReason: 'destroyed', closedSessionId: SID },
        SID,
      ),
    ).toBe(true);
  });

  it('returns true for a boot-timeout close whose sessionId matches mine', () => {
    expect(
      shouldSelfExitAsOrphan(
        { statusName: 'COMPLETED', closeReason: 'boot-timeout', closedSessionId: SID },
        SID,
      ),
    ).toBe(true);
  });

  it('returns true regardless of HOW LATE the orphan boots (no TTL — identity is timeless)', () => {
    // The whole point of #897: the ~100min (or 100h) delay that a wall-clock TTL
    // had to "guess" around no longer matters — identity match is timeless.
    expect(
      shouldSelfExitAsOrphan(
        { statusName: 'COMPLETED', closeReason: 'boot-timeout', closedSessionId: SID },
        SID,
      ),
    ).toBe(true);
  });

  it('returns false when the closed run sessionId differs (legit re-recruit with a fresh sessionId)', () => {
    // This is the false-exit the TTL could never prevent: a brand-new recruit of
    // the same name, spawned with a NEW sessionId, must NEVER be killed.
    expect(
      shouldSelfExitAsOrphan(
        { statusName: 'COMPLETED', closeReason: 'destroyed', closedSessionId: OTHER_SID },
        SID,
      ),
    ).toBe(false);
  });

  it('returns false when MY sessionId is unset (legacy spawn not forwarding the env)', () => {
    expect(
      shouldSelfExitAsOrphan(
        { statusName: 'COMPLETED', closeReason: 'destroyed', closedSessionId: SID },
        undefined,
      ),
    ).toBe(false);
  });

  it('returns false when the closed run has no sessionId memo (run closed before #897)', () => {
    expect(
      shouldSelfExitAsOrphan(
        { statusName: 'COMPLETED', closeReason: 'destroyed', closedSessionId: undefined },
        SID,
      ),
    ).toBe(false);
  });

  it('returns false for a closed run with no close-reason memo (clean completion / pre-#704)', () => {
    expect(
      shouldSelfExitAsOrphan(
        { statusName: 'COMPLETED', closeReason: undefined, closedSessionId: SID },
        SID,
      ),
    ).toBe(false);
  });

  it('returns false for a non-tombstone close-reason even when sessionId matches', () => {
    expect(
      shouldSelfExitAsOrphan(
        { statusName: 'TERMINATED', closeReason: 'some-other-reason', closedSessionId: SID },
        SID,
      ),
    ).toBe(false);
  });

  it('returns false for a non-string closedSessionId memo (defensive)', () => {
    expect(
      shouldSelfExitAsOrphan(
        { statusName: 'COMPLETED', closeReason: 'destroyed', closedSessionId: 12345 },
        SID,
      ),
    ).toBe(false);
  });
});
