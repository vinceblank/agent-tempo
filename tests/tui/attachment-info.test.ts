/**
 * Vitest integration coverage for the TUI `/attachment-info` handler (#264).
 *
 * The shared formatter itself (`src/utils/attachment-format.ts`) already has
 * Mocha unit coverage at `test/cli-attachment-info.test.ts` for input/output
 * pairs and heartbeat-age edge cases. This file covers the missing piece:
 * that the TUI handler ACTUALLY feeds the formatter's output into the
 * command overlay — the integration the pre-#264 handler forgot to wire up.
 *
 * Invocation goes through the public `COMMANDS` registry rather than
 * importing `handleAttachmentInfo` directly, so we exercise the same
 * dispatch surface the App uses at runtime.
 */
import { describe, it, expect, vi } from 'vitest';
import { COMMANDS, type CommandContext } from '../../src/tui/commands';
import type { AttachmentInfo } from '../../src/types';
import type { TempoClient } from '../../src/client';
import type { TuiAction } from '../../src/tui/store';

// Build a canned TempoClient stub — only `attachmentInfo` is called by the
// handler, so the rest is `vi.fn()` sentinels that throw if touched (catches
// handler drift).
function makeApi(info: AttachmentInfo): TempoClient {
  const unusedStub = vi.fn(() => {
    throw new Error('TempoClient method not expected during /attachment-info');
  });
  return new Proxy({} as TempoClient, {
    get(_target, prop: string) {
      if (prop === 'attachmentInfo') return vi.fn(async () => info);
      return unusedStub;
    },
  });
}

const CTX: CommandContext = { activeEnsemble: 'demo-ensemble' };

// Fixed "now" for deterministic heartbeat-age assertions. The handler
// defaults `now` to `Date.now()`, so mock the clock.
const NOW = Date.parse('2026-04-19T12:00:00.000Z');

describe('/attachment-info handler — TUI integration (#264)', () => {
  it('surfaces heartbeat age in the command overlay (regression for #264)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    const info: AttachmentInfo = {
      phase: 'attached',
      inFlightCount: 0,
      currentAttachment: {
        attachmentId: 'att-tui-1',
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

    const dispatch = vi.fn<(a: TuiAction) => void>();
    const handler = COMMANDS['attachment-info'].handler!;
    await handler(['tempo-eng'], dispatch, makeApi(info), CTX);

    // Assert: dispatch got a SHOW_COMMAND_OVERLAY, and its content includes
    // the heartbeat-age line — the #264 gap. Title remains "Attachment · <name>".
    expect(dispatch).toHaveBeenCalledTimes(1);
    const action = dispatch.mock.calls[0][0] as { type: string; title: string; content: string };
    expect(action.type).toBe('SHOW_COMMAND_OVERLAY');
    expect(action.title).toBe('Attachment \u00B7 tempo-eng');
    expect(action.content).toContain('  heartbeat: 30s ago');
    // Sanity: other fields the pre-#264 handler already rendered are still there.
    expect(action.content).toContain('tempo-eng — phase: attached');
    expect(action.content).toContain('  in-flight: 0');
    expect(action.content).toContain('  attached on: main-laptop (adapter: claude-code/interactive)');

    vi.useRealTimers();
  });

  it('detached session (no currentAttachment): overlay omits heartbeat line', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    const info: AttachmentInfo = { phase: 'detached', inFlightCount: 0 };
    const dispatch = vi.fn<(a: TuiAction) => void>();
    const handler = COMMANDS['attachment-info'].handler!;
    await handler(['tempo-eng'], dispatch, makeApi(info), CTX);

    expect(dispatch).toHaveBeenCalledTimes(1);
    const action = dispatch.mock.calls[0][0] as { type: string; content: string };
    expect(action.type).toBe('SHOW_COMMAND_OVERLAY');
    expect(action.content).toBe(
      'tempo-eng — phase: detached\n  in-flight: 0',
    );
    expect(action.content).not.toContain('heartbeat:');

    vi.useRealTimers();
  });

  it('usage error when no player name provided', async () => {
    const dispatch = vi.fn<(a: TuiAction) => void>();
    const handler = COMMANDS['attachment-info'].handler!;
    await handler([], dispatch, makeApi({ phase: 'detached', inFlightCount: 0 }), CTX);

    // Usage-error path emits a 'COMMIT_STATIC' (via commitStatic helper) — we
    // only care that NO overlay was dispatched in this path; the exact error
    // action shape is already covered by other command tests.
    const overlays = dispatch.mock.calls.filter(
      ([a]) => (a as { type: string }).type === 'SHOW_COMMAND_OVERLAY',
    );
    expect(overlays.length).toBe(0);
  });
});
