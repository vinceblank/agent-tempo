/**
 * Unit tests for the shared attachment-info display formatter. Originally
 * added for #138 (CLI heartbeat age); the formatter was relocated to
 * `src/utils/attachment-format.ts` in #264 so the TUI consumer could reuse
 * it without drifting. These Mocha cases stay here to keep the CLI-side
 * workflow/wire-protocol suite validating the pure pure-data-in / string-out
 * contract. (The former TUI companion suite was deleted with the TUI, #789.)
 *
 * Covers:
 *   - Happy path: currentAttachment present → all fields including heartbeat
 *     age render correctly.
 *   - Detached: no currentAttachment → only phase + in-flight lines (no
 *     attachment-specific fields).
 *   - Optional fields populated: preferredHost + processingSince appear as
 *     extra lines in the expected order.
 *   - Heartbeat age edge cases:
 *       · clock-skew (lastHeartbeatAt > now) → "just now"
 *       · malformed timestamp → "unknown"
 *
 * "Not-found" (session doesn't exist) is handled by the CLI wrapper's
 * try/catch → out.error → process.exit(1) path, mirroring sibling verbs
 * restart/detach/destroy/migrate. No dedicated test for that path here —
 * it would require mocking TempoClient, which no other CLI verb tests, and
 * the formatter itself is what #138's AC is about.
 */
import { expect } from 'chai';
import { formatAttachmentInfoForDisplay } from '../src/utils/attachment-format';
import type { AttachmentInfo } from '../src/types';

// Frozen "now" so heartbeat-age strings are deterministic across CI runs.
const NOW = Date.parse('2026-04-19T12:00:00.000Z');

describe('formatAttachmentInfoForDisplay (#138, #264)', function () {
  it('happy path: attached session — renders all core fields + heartbeat age', function () {
    const info: AttachmentInfo = {
      phase: 'attached',
      inFlightCount: 0,
      currentAttachment: {
        attachmentId: 'att-abc123',
        hostname: 'main-laptop',
        adapterId: 'claude-code',
        adapterClass: 'interactive',
        claimedAt: '2026-04-19T11:55:00.000Z',
        lastHeartbeatAt: '2026-04-19T11:59:30.000Z', // 30s before NOW
        expiresAt: '2026-04-19T12:02:30.000Z',
        leaseMs: 180_000,
        runId: 'run-xyz',
      },
    };
    expect(formatAttachmentInfoForDisplay('tempo-eng', info, NOW)).to.deep.equal([
      'tempo-eng — phase: attached',
      '  in-flight: 0',
      '  attached on: main-laptop (adapter: claude-code/interactive)',
      '  attachmentId: att-abc123',
      '  lease expires: 2026-04-19T12:02:30.000Z',
      '  heartbeat: 30s ago',
    ]);
  });

  it('detached session: no currentAttachment — only phase + in-flight lines render', function () {
    const info: AttachmentInfo = {
      phase: 'detached',
      inFlightCount: 0,
    };
    expect(formatAttachmentInfoForDisplay('tempo-eng', info, NOW)).to.deep.equal([
      'tempo-eng — phase: detached',
      '  in-flight: 0',
    ]);
  });

  it('attached with preferredHost + processingSince — extras appended in order', function () {
    const info: AttachmentInfo = {
      phase: 'processing',
      inFlightCount: 2,
      currentAttachment: {
        attachmentId: 'att-def456',
        hostname: 'remote-box',
        adapterId: 'copilot',
        adapterClass: 'sdk',
        claimedAt: '2026-04-19T11:50:00.000Z',
        lastHeartbeatAt: '2026-04-19T11:58:00.000Z', // 2m before NOW
        expiresAt: '2026-04-19T12:04:00.000Z',
        leaseMs: 360_000,
        runId: 'run-abc',
      },
      preferredHost: 'remote-box',
      processingSince: '2026-04-19T11:59:45.000Z',
    };
    expect(formatAttachmentInfoForDisplay('tempo-eng', info, NOW)).to.deep.equal([
      'tempo-eng — phase: processing',
      '  in-flight: 2',
      '  attached on: remote-box (adapter: copilot/sdk)',
      '  attachmentId: att-def456',
      '  lease expires: 2026-04-19T12:04:00.000Z',
      '  heartbeat: 2m ago',
      '  preferred host: remote-box',
      '  processing since: 2026-04-19T11:59:45.000Z',
    ]);
  });

  it('heartbeat age: clock skew (adapter ran ahead of us) renders as "just now"', function () {
    const info: AttachmentInfo = {
      phase: 'attached',
      inFlightCount: 0,
      currentAttachment: {
        attachmentId: 'att-1',
        hostname: 'h',
        adapterId: 'claude-code',
        adapterClass: 'interactive',
        claimedAt: NOW_ISO(-5_000),
        lastHeartbeatAt: NOW_ISO(+500), // 500ms in the future
        expiresAt: NOW_ISO(+180_000),
        leaseMs: 180_000,
        runId: 'run-1',
      },
    };
    const lines = formatAttachmentInfoForDisplay('p', info, NOW);
    expect(lines).to.include('  heartbeat: just now');
  });

  it('heartbeat age: malformed timestamp renders as "unknown" (defensive)', function () {
    const info: AttachmentInfo = {
      phase: 'attached',
      inFlightCount: 0,
      currentAttachment: {
        attachmentId: 'att-1',
        hostname: 'h',
        adapterId: 'claude-code',
        adapterClass: 'interactive',
        claimedAt: '2026-04-19T11:00:00.000Z',
        lastHeartbeatAt: 'not-a-valid-timestamp',
        expiresAt: '2026-04-19T13:00:00.000Z',
        leaseMs: 180_000,
        runId: 'run-1',
      },
    };
    const lines = formatAttachmentInfoForDisplay('p', info, NOW);
    expect(lines).to.include('  heartbeat: unknown');
  });
});

/** ISO timestamp at NOW + `offsetMs`, for building fixtures relative to the frozen clock. */
function NOW_ISO(offsetMs: number): string {
  return new Date(NOW + offsetMs).toISOString();
}
