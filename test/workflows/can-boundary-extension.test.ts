/**
 * Unit tests for the CAN-boundary lease-extension math (#127).
 *
 * The math — "push `expiresAt` out by one heartbeat interval so a healthy
 * adapter has room to land its next heartbeat across the CAN transition" —
 * was originally inlined in `src/workflows/session.ts` immediately before
 * `continueAsNew`. PR-G (#125) considered adding a ~60 LOC history-fill
 * harness to exercise the path but rejected it: that approach would have
 * tested Temporal's CAN-trigger heuristic (`workflowInfo().continueAsNewSuggested`)
 * rather than our extension logic, and would have been brittle to
 * Temporal-SDK internals. PR #127 extracted the math into
 * `src/workflows/attachment-math.ts#extendAttachmentForCAN` — a pure
 * function — so this suite can test it directly without
 * `TestWorkflowEnvironment` or workflow-bundle plumbing.
 *
 * Cross-reference:
 * - `test/session-lease.test.ts` covers the BOOT side — "pre-populated
 *   `currentAttachment` is restored and phase=attached". Do NOT duplicate.
 * - `src/workflows/session.ts` line ~1516 is the sole production call site
 *   (guarded by `currentAttachment` truthiness; the pure function is total).
 *
 * Design reference: `docs/design/session-lifecycle-rebuild-v2.md` §2.3, §9.5.
 */
import { expect } from 'chai';
import { extendAttachmentForCAN } from '../../src/workflows/attachment-math';
import type { Attachment } from '../../src/types';

/**
 * Fixture builder. Callers override only the fields they care about — the
 * defaults are a plausible "healthy mid-life attachment" so tests don't have
 * to restate the full shape for every case.
 */
function makeAttachment(overrides: Partial<Attachment> = {}): Attachment {
  return {
    attachmentId: 'att-abc-123',
    hostname: 'test-host',
    adapterId: 'claude-code',
    adapterClass: 'interactive',
    claimedAt: '2026-04-01T12:00:00.000Z',
    lastHeartbeatAt: '2026-04-01T12:30:00.000Z',
    expiresAt: '2026-04-01T12:32:00.000Z',
    leaseMs: 120_000,
    runId: 'run-xyz-789',
    ...overrides,
  };
}

/** A known epoch ms so tests can assert the exact post-extension timestamps. */
const NOW_MS = Date.UTC(2026, 3, 1, 12, 31, 15); // 2026-04-01T12:31:15.000Z
const NOW_ISO = '2026-04-01T12:31:15.000Z';

describe('extendAttachmentForCAN (#127 — design §2.3)', function () {
  describe('happy path', () => {
    it('sets lastHeartbeatAt to `now` and expiresAt to `now + extendMs`', () => {
      const input = makeAttachment();
      const out = extendAttachmentForCAN(input, 30_000, NOW_MS);

      expect(out.lastHeartbeatAt).to.equal(NOW_ISO);
      expect(out.expiresAt).to.equal(new Date(NOW_MS + 30_000).toISOString());
    });

    it('preserves every non-timestamp field verbatim', () => {
      const input = makeAttachment({
        attachmentId: 'unique-id',
        hostname: 'renamed-host',
        adapterId: 'copilot',
        adapterClass: 'sdk',
        claimedAt: '2026-01-15T08:00:00.000Z',
        leaseMs: 90_000,
        runId: 'different-run',
      });
      const out = extendAttachmentForCAN(input, 60_000, NOW_MS);

      expect(out.attachmentId).to.equal('unique-id');
      expect(out.hostname).to.equal('renamed-host');
      expect(out.adapterId).to.equal('copilot');
      expect(out.adapterClass).to.equal('sdk');
      expect(out.claimedAt).to.equal('2026-01-15T08:00:00.000Z');
      expect(out.leaseMs).to.equal(90_000);
      expect(out.runId).to.equal('different-run');
    });

    it('does not mutate the input attachment', () => {
      const input = makeAttachment();
      const snapshot = { ...input };
      extendAttachmentForCAN(input, 30_000, NOW_MS);
      expect(input).to.deep.equal(snapshot);
    });

    it('returns a fresh object (reference inequality with input)', () => {
      const input = makeAttachment();
      const out = extendAttachmentForCAN(input, 30_000, NOW_MS);
      expect(out).to.not.equal(input);
    });
  });

  describe('edge cases', () => {
    it('extends past an already-past expiresAt (the whole point of §2.3)', () => {
      // This is the failure mode the extension exists to prevent: without the
      // math, the new execution's first main-loop tick would see an expiresAt
      // in the past and reap a healthy attachment. Confirming it here pins the
      // behavior so a future well-meaning "optimization" (e.g. "only extend if
      // current expiresAt is in the future") doesn't re-introduce the bug.
      const input = makeAttachment({
        expiresAt: '2026-04-01T12:00:00.000Z', // 31m15s BEFORE NOW_MS
      });
      const out = extendAttachmentForCAN(input, 30_000, NOW_MS);
      expect(new Date(out.expiresAt).getTime()).to.equal(NOW_MS + 30_000);
      expect(new Date(out.expiresAt).getTime()).to.be.greaterThan(
        new Date(input.expiresAt).getTime(),
      );
    });

    it('accepts extendMs = 0 (degenerate but not forbidden)', () => {
      const input = makeAttachment();
      const out = extendAttachmentForCAN(input, 0, NOW_MS);
      expect(out.lastHeartbeatAt).to.equal(NOW_ISO);
      expect(out.expiresAt).to.equal(NOW_ISO);
    });

    it('accepts a very large extendMs without overflow', () => {
      // Temporal workflow heartbeatMs is bounded to 600_000 in practice, but
      // the pure function does not validate. Ensure arithmetic stays sane up
      // to at least ~year-2030 expiresAt.
      const oneYearMs = 365 * 24 * 60 * 60 * 1000;
      const input = makeAttachment();
      const out = extendAttachmentForCAN(input, oneYearMs, NOW_MS);
      expect(new Date(out.expiresAt).getTime()).to.equal(NOW_MS + oneYearMs);
    });

    it('is deterministic — same inputs produce equal outputs', () => {
      const input = makeAttachment();
      const a = extendAttachmentForCAN(input, 30_000, NOW_MS);
      const b = extendAttachmentForCAN(input, 30_000, NOW_MS);
      expect(a).to.deep.equal(b);
    });
  });

  describe('production call-site contract', () => {
    it('legacy pre-#249 invocation: hardcoded HEARTBEAT_INTERVAL_MS = 30_000', () => {
      // Documents the pre-#249 call shape — still reachable via the non-patched
      // replay branch at `session.ts:1540` for histories that CAN'd before the
      // #249 fix deployed. Preserved so a future refactor of the `patched()`
      // gate doesn't silently break replay.
      const currentAttachment = makeAttachment({
        expiresAt: '2026-04-01T12:32:00.000Z', // 45s ahead of NOW_MS
      });
      const HEARTBEAT_INTERVAL_MS = 30_000;

      const out = extendAttachmentForCAN(
        currentAttachment,
        HEARTBEAT_INTERVAL_MS,
        NOW_MS,
      );

      // new expiresAt = now + 30s (NOT max(current, now+30s)) — documents the
      // floor-to-extendMs semantic. For §2.3 this is fine because the adapter
      // was beating normally pre-CAN (expiresAt ≤ ~2x heartbeatMs past now).
      expect(new Date(out.expiresAt).getTime()).to.equal(NOW_MS + 30_000);
      expect(out.lastHeartbeatAt).to.equal(NOW_ISO);
    });

    it('post-#249 invocation: uses currentAttachment.leaseMs (claude-code = 180_000)', () => {
      // #249 Bug 3: post-fix the session workflow passes `currentAttachment.leaseMs`
      // (= 3 × heartbeatMs = 180_000 for claude-code) instead of the hardcoded 30_000
      // constant. This test models the POST-fix call shape exactly so a regression
      // that silently goes back to the legacy constant fails here.
      //
      // Assertions strengthened per tempo-researcher flag 5: equality on the exact
      // extension value, and strict `>` on the expiresAt progression (guards against
      // an identity-function regression that happens to leave lastHeartbeatAt fresh
      // but leaves expiresAt unchanged).
      const CLAUDE_CODE_HEARTBEAT_MS = 60_000;
      const CLAUDE_CODE_LEASE_MS = 3 * CLAUDE_CODE_HEARTBEAT_MS; // 180_000
      const preCanExpiresAt = '2026-04-01T12:32:00.000Z'; // 45s ahead of NOW_MS
      const currentAttachment = makeAttachment({
        leaseMs: CLAUDE_CODE_LEASE_MS,
        expiresAt: preCanExpiresAt,
      });

      const out = extendAttachmentForCAN(
        currentAttachment,
        currentAttachment.leaseMs,
        NOW_MS,
      );

      // Equality: new expiresAt = now + leaseMs exactly (not ≥ — stronger bound).
      expect(new Date(out.expiresAt).getTime()).to.equal(NOW_MS + CLAUDE_CODE_LEASE_MS);
      // Strict progression: the extension MUST push expiresAt forward from the
      // pre-CAN value. 30_000 would have yielded 12:31:45 (earlier than 12:32:00);
      // 180_000 yields 12:34:15. Pins the actual fix rather than just its floor.
      expect(new Date(out.expiresAt).getTime()).to.be.greaterThan(
        new Date(preCanExpiresAt).getTime(),
      );
      // Covers at least one full adapter heartbeat interval (AC #3 in #249).
      expect(new Date(out.expiresAt).getTime() - NOW_MS).to.be.at.least(
        CLAUDE_CODE_HEARTBEAT_MS,
      );
      expect(out.lastHeartbeatAt).to.equal(NOW_ISO);
    });
  });
});
