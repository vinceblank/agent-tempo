/**
 * Vitest integration coverage for the TUI `/migrate` handler's
 * `--yes-steal=<hostname>` deliberate-action gate (#580).
 *
 * The shared MCP-side guard (`enforceYesStealGuard` in
 * `src/tools/restart.ts`) already has Mocha coverage at
 * `test/yes-steal-guard.test.ts`. This file covers the gap the issue
 * tracked: that the TUI handler enforces the same §16.5 Option B
 * property before forwarding through `TempoClient.migrate()`.
 *
 * Invocation goes through the public `COMMANDS` registry rather than
 * importing `handleMigrate` directly, so we exercise the same dispatch
 * surface the App uses at runtime. `localHostname` is injected via
 * `CommandContext` so tests don't depend on the host the runner is on.
 */
import { describe, it, expect, vi } from 'vitest';
import { COMMANDS, type CommandContext } from '../../src/tui/commands';
import type { AttachmentInfo } from '../../src/types';
import type { TempoClient, RestartClientResult, RestartClientOpts } from '../../src/client';
import type { TuiAction } from '../../src/tui/store';

interface MigrateCall {
  ensemble: string;
  playerId: string;
  host: string;
  opts: RestartClientOpts;
}

interface ApiStubResult {
  api: TempoClient;
  migrateCalls: MigrateCall[];
  attachmentInfoCalls: Array<{ ensemble: string; playerId: string }>;
}

/**
 * Build a canned TempoClient stub — only `attachmentInfo` (for the gate
 * lookup) and `migrate` (for the success path) should be touched. Any
 * other property access throws to catch handler drift.
 */
function makeApi(info: AttachmentInfo | Error): ApiStubResult {
  const migrateCalls: MigrateCall[] = [];
  const attachmentInfoCalls: Array<{ ensemble: string; playerId: string }> = [];
  const unusedStub = vi.fn((..._args: unknown[]) => {
    throw new Error('TempoClient method not expected during /migrate test');
  });
  const api = new Proxy({} as TempoClient, {
    get(_target, prop: string) {
      if (prop === 'attachmentInfo') {
        return vi.fn(async (ensemble: string, playerId: string) => {
          attachmentInfoCalls.push({ ensemble, playerId });
          if (info instanceof Error) throw info;
          return info;
        });
      }
      if (prop === 'migrate') {
        return vi.fn(
          async (
            ensemble: string,
            playerId: string,
            host: string,
            opts: RestartClientOpts = {},
          ): Promise<RestartClientResult> => {
            migrateCalls.push({ ensemble, playerId, host, opts });
            return { playerId, host, entryId: 'outbox-stub-1' };
          },
        );
      }
      return unusedStub;
    },
  });
  return { api, migrateCalls, attachmentInfoCalls };
}

function ctxWith(localHostname: string): CommandContext {
  return { activeEnsemble: 'demo-ensemble', localHostname };
}

function attachedOn(hostname: string): AttachmentInfo {
  return {
    phase: 'attached',
    inFlightCount: 0,
    currentAttachment: {
      attachmentId: 'att-1',
      hostname,
      adapterId: 'claude-code',
      adapterClass: 'interactive',
      claimedAt: '2026-05-12T03:00:00.000Z',
      lastHeartbeatAt: '2026-05-12T03:00:30.000Z',
      expiresAt: '2026-05-12T03:03:00.000Z',
      leaseMs: 180_000,
      runId: 'run-1',
    },
  };
}

function notificationErrors(dispatch: ReturnType<typeof vi.fn>): string[] {
  const out: string[] = [];
  for (const call of dispatch.mock.calls) {
    const action = call[0] as {
      type: string;
      notification?: { kind?: string; content?: string };
    };
    if (
      action.type === 'ADD_NOTIFICATION' &&
      action.notification?.kind === 'error' &&
      typeof action.notification?.content === 'string'
    ) {
      out.push(action.notification.content);
    }
  }
  return out;
}

describe('/migrate --yes-steal handler — §16.5 Option B gate (#580)', () => {
  const handler = COMMANDS.migrate.handler!;

  it('rejects cross-host --force without --yes-steal (matches §8 Q5 format)', async () => {
    const { api, migrateCalls } = makeApi(attachedOn('host-B'));
    const dispatch = vi.fn<(a: TuiAction) => void>();

    await handler(['alice', 'host-a', '--force'], dispatch, api, ctxWith('host-A'));

    expect(migrateCalls).toHaveLength(0);
    const errors = notificationErrors(dispatch);
    expect(errors).toHaveLength(1);
    // §8 Q5 format properties:
    expect(errors[0]).toContain('session "alice" is attached to host "host-B"');
    expect(errors[0]).toContain('--yes-steal');
    // Copy-paste-ready remediation line:
    expect(errors[0]).toContain('/migrate alice host-a --force --yes-steal=host-B');
    // Safety rationale:
    expect(errors[0]).toContain('prevents accidental cross-host session takeover');
  });

  it('rejects cross-host --force with mismatched --yes-steal value', async () => {
    const { api, migrateCalls } = makeApi(attachedOn('host-B'));
    const dispatch = vi.fn<(a: TuiAction) => void>();

    await handler(
      ['alice', 'host-a', '--force', '--yes-steal=host-Z'],
      dispatch,
      api,
      ctxWith('host-A'),
    );

    expect(migrateCalls).toHaveLength(0);
    const errors = notificationErrors(dispatch);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('--yes-steal mismatch');
    expect(errors[0]).toContain('"host-B"');
    expect(errors[0]).toContain('"host-Z"');
    expect(errors[0]).toContain('Re-run with --yes-steal=host-B');
  });

  it('rejects bare --yes-steal (no value) with a friendly hint', async () => {
    const { api, migrateCalls } = makeApi(attachedOn('host-B'));
    const dispatch = vi.fn<(a: TuiAction) => void>();

    await handler(
      ['alice', 'host-a', '--force', '--yes-steal'],
      dispatch,
      api,
      ctxWith('host-A'),
    );

    expect(migrateCalls).toHaveLength(0);
    const errors = notificationErrors(dispatch);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('--yes-steal requires a hostname');
    // The safety property must be re-stated so the operator understands WHY:
    expect(errors[0]).toContain('type the host name being stolen from');
  });

  it('forwards confirmStealFromHost through migrate() when --yes-steal matches current host', async () => {
    const { api, migrateCalls } = makeApi(attachedOn('host-B'));
    const dispatch = vi.fn<(a: TuiAction) => void>();

    await handler(
      ['alice', 'host-a', '--force', '--yes-steal=host-B'],
      dispatch,
      api,
      ctxWith('host-A'),
    );

    expect(migrateCalls).toHaveLength(1);
    expect(migrateCalls[0]).toMatchObject({
      ensemble: 'demo-ensemble',
      playerId: 'alice',
      host: 'host-a',
      opts: {
        fresh: false,
        force: true,
        invokerPlayerId: 'tui',
        confirmStealFromHost: 'host-B',
      },
    });
    // No error notifications on the success path.
    expect(notificationErrors(dispatch)).toHaveLength(0);
  });

  it('no-op gate: same-host --force migrate does NOT require --yes-steal', async () => {
    // The §16.5 property only applies to cross-host steals. A migrate
    // targeting the same host the session is already on is just a
    // re-spawn — fine to allow without the deliberate-action prompt.
    const { api, migrateCalls } = makeApi(attachedOn('host-A'));
    const dispatch = vi.fn<(a: TuiAction) => void>();

    await handler(['alice', 'host-a', '--force'], dispatch, api, ctxWith('host-A'));

    expect(migrateCalls).toHaveLength(1);
    expect(migrateCalls[0].opts.confirmStealFromHost).toBeUndefined();
    expect(notificationErrors(dispatch)).toHaveLength(0);
  });

  it('no-op gate: --force on a detached target (no currentAttachment) bypasses the prompt', async () => {
    // Nothing to "steal" from — the gate only fires when a live attachment
    // is present on another host. Detached / gone sessions skip the check.
    const { api, migrateCalls } = makeApi({ phase: 'detached', inFlightCount: 0 });
    const dispatch = vi.fn<(a: TuiAction) => void>();

    await handler(['alice', 'host-a', '--force'], dispatch, api, ctxWith('host-A'));

    expect(migrateCalls).toHaveLength(1);
    expect(migrateCalls[0].opts.confirmStealFromHost).toBeUndefined();
    expect(notificationErrors(dispatch)).toHaveLength(0);
  });

  it('no-op gate: graceful (non-force) migrate skips the attachmentInfo lookup entirely', async () => {
    // Graceful detach + claim always passes the §16.5 property — only
    // FORCE steals demand the deliberate-action confirmation. We assert
    // that `attachmentInfo` is not even called on the graceful path, so
    // the gate is short-circuited (one fewer query per migrate call).
    const { api, migrateCalls, attachmentInfoCalls } = makeApi(attachedOn('host-B'));
    const dispatch = vi.fn<(a: TuiAction) => void>();

    await handler(['alice', 'host-a'], dispatch, api, ctxWith('host-A'));

    expect(migrateCalls).toHaveLength(1);
    expect(migrateCalls[0].opts.force).toBe(false);
    expect(attachmentInfoCalls).toHaveLength(0);
    expect(notificationErrors(dispatch)).toHaveLength(0);
  });

  it('attachmentInfo lookup failure does NOT block the call (fail-open per handler comment)', async () => {
    // If we can't read the phase (transient query error, etc.), the
    // handler falls through and lets the downstream MCP-tool guard or
    // workflow handle the state. This matches the §8 Q5 design comment
    // ("If we can't read the phase, let the downstream algorithm handle…")
    // mirrored in `enforceYesStealGuard`'s try/catch.
    const { api, migrateCalls } = makeApi(new Error('attachmentInfo query timeout'));
    const dispatch = vi.fn<(a: TuiAction) => void>();

    await handler(['alice', 'host-a', '--force'], dispatch, api, ctxWith('host-A'));

    expect(migrateCalls).toHaveLength(1);
    expect(notificationErrors(dispatch)).toHaveLength(0);
  });

  it('usage error includes the new --yes-steal flag', async () => {
    const { api, migrateCalls } = makeApi(attachedOn('host-A'));
    const dispatch = vi.fn<(a: TuiAction) => void>();

    await handler(['alice'], dispatch, api, ctxWith('host-A')); // missing <host>

    expect(migrateCalls).toHaveLength(0);
    const errors = notificationErrors(dispatch);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('Usage:');
    expect(errors[0]).toContain('--yes-steal=<hostname>');
  });
});
