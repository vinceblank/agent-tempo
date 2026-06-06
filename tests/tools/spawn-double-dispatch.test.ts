/**
 * #676 FIX-3 — double-dispatch backstop decision (shouldSkipDuplicateSpawn,
 * src/activities/outbox.ts). SKIP iff a FRESH recruit (no attachmentId handoff)
 * finds a live adapter already attached. Restart/migrate carry attachmentId (the
 * handoff to their fresh claim) → never skipped, so restart isn't broken.
 */
import { describe, it, expect } from 'vitest';
import { shouldSkipDuplicateSpawn } from '../../src/activities/outbox';
import type { AttachmentPhase } from '../../src/types';

const LIVE: AttachmentPhase[] = ['attached', 'processing', 'awaiting'];
const NOT_LIVE: AttachmentPhase[] = ['booting', 'draining', 'detached', 'gone'];

describe('shouldSkipDuplicateSpawn (#676 FIX-3)', () => {
  it('SKIPS a fresh recruit (no attachmentId) when a live adapter is already attached', () => {
    for (const phase of LIVE) {
      expect(shouldSkipDuplicateSpawn(undefined, phase), phase).toBe(true);
    }
  });

  it('does NOT skip a restart/migrate (attachmentId present) even when phase is live (else restart attaches to nothing)', () => {
    for (const phase of LIVE) {
      expect(shouldSkipDuplicateSpawn('attach-abc', phase), phase).toBe(false);
    }
  });

  it('does NOT skip a fresh recruit of a new/dead name (non-live phase) — spawns normally', () => {
    for (const phase of NOT_LIVE) {
      expect(shouldSkipDuplicateSpawn(undefined, phase), phase).toBe(false);
    }
  });

  it('ACCEPTED EDGE (architect-ruled): a force-recruit of a live name is STILL skipped', () => {
    // force is a PREFLIGHT bypass, not an adapter-steal. A force-recruit is still a
    // fresh recruit (no attachmentId) → skipped. "Replace a live adapter" = restart/
    // migrate (which carry attachmentId). A stale "attached" zombie self-heals via
    // lease expiry (~90s). Documented here so it isn't later mistaken for a bug.
    expect(shouldSkipDuplicateSpawn(undefined, 'attached')).toBe(true);
  });
});
