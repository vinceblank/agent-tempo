/**
 * Unit tests for `ensureDevNamespace` (ADR 0014 §6.2).
 *
 * Coverage:
 *   - Happy path: registerNamespace succeeds → status `'created'`.
 *   - Steady state: server returns `ALREADY_EXISTS` → status
 *     `'already-exists'`. Tested for both string-code and gRPC numeric-code
 *     (6) shapes the SDK has surfaced across versions.
 *   - Permission denied: server returns `PERMISSION_DENIED` → status
 *     `'permission-denied'`; daemon stays alive, hint logged.
 *   - Unknown error: any other failure → status `'error'`; daemon stays alive.
 *   - The `workflowExecutionRetentionPeriod` is 1 day per design §6.2.
 *
 * No Temporal connection is opened: we pass a stub `workflowService` and
 * assert on call shape + result. Pairs the daemon-boot test pattern.
 */
import { expect } from 'chai';
import { ensureDevNamespace } from '../src/daemon';
import { DEV_TEMPORAL_NAMESPACE } from '../src/config';

interface RegisterCall {
  namespace: string;
  description?: string;
  retentionSeconds?: number | string;
}

/**
 * Build a stub `Connection`-shaped object whose `workflowService.registerNamespace`
 * either resolves (`success` mode) or rejects with the configured error.
 */
function makeStubConnection(opts: {
  reject?: unknown;
  recordedCalls: RegisterCall[];
}) {
  return {
    workflowService: {
      registerNamespace: async (req: {
        namespace: string;
        description?: string;
        workflowExecutionRetentionPeriod?: { seconds?: number | string | { toNumber(): number } };
      }) => {
        const seconds = req.workflowExecutionRetentionPeriod?.seconds;
        opts.recordedCalls.push({
          namespace: req.namespace,
          description: req.description,
          retentionSeconds:
            typeof seconds === 'object' && seconds !== null && 'toNumber' in seconds
              ? seconds.toNumber()
              : (seconds as number | string | undefined),
        });
        if (opts.reject !== undefined) {
          throw opts.reject;
        }
      },
    },
  };
}

describe('ensureDevNamespace (ADR 0014 §6.2)', function () {
  it('happy path — registerNamespace succeeds, status="created"', async function () {
    const calls: RegisterCall[] = [];
    const conn = makeStubConnection({ recordedCalls: calls });
    const logged: unknown[][] = [];
    const result = await ensureDevNamespace(
      conn as unknown as Parameters<typeof ensureDevNamespace>[0],
      DEV_TEMPORAL_NAMESPACE,
      (...args) => logged.push(args),
    );
    expect(result).to.deep.equal({ ok: true, status: 'created' });
    expect(calls).to.have.lengthOf(1);
    expect(calls[0].namespace).to.equal(DEV_TEMPORAL_NAMESPACE);
    // 1-day retention per design §6.2.
    expect(calls[0].retentionSeconds).to.equal(86_400);
    expect(calls[0].description).to.match(/auto-created/i);
    // A log line confirming the registration is part of the operator UX.
    expect(logged.flat().join(' ')).to.match(/registered Temporal namespace/i);
  });

  it('idempotent — ALREADY_EXISTS string code returns status="already-exists"', async function () {
    const calls: RegisterCall[] = [];
    const err: { code: string; message: string } = {
      code: 'ALREADY_EXISTS',
      message: 'Namespace claude-tempo-dev is already registered.',
    };
    const conn = makeStubConnection({ recordedCalls: calls, reject: err });
    const result = await ensureDevNamespace(
      conn as unknown as Parameters<typeof ensureDevNamespace>[0],
      DEV_TEMPORAL_NAMESPACE,
      () => { /* silent */ },
    );
    expect(result).to.deep.equal({ ok: true, status: 'already-exists' });
  });

  it('idempotent — gRPC numeric code 6 (ALREADY_EXISTS) returns status="already-exists"', async function () {
    const calls: RegisterCall[] = [];
    // Some SDK versions surface the gRPC numeric status code instead of
    // the string. Both shapes must collapse to the same happy path.
    const err = Object.assign(new Error('already exists'), { code: 6 });
    const conn = makeStubConnection({ recordedCalls: calls, reject: err });
    const result = await ensureDevNamespace(
      conn as unknown as Parameters<typeof ensureDevNamespace>[0],
      DEV_TEMPORAL_NAMESPACE,
      () => { /* silent */ },
    );
    expect(result).to.deep.equal({ ok: true, status: 'already-exists' });
  });

  it('idempotent — substring fallback ("already exists" in message) returns status="already-exists"', async function () {
    const calls: RegisterCall[] = [];
    // Bare Error with no `.code` — the substring match is the last line of
    // defense for SDK transports that swallow gRPC metadata.
    const err = new Error('namespace claude-tempo-dev already exists');
    const conn = makeStubConnection({ recordedCalls: calls, reject: err });
    const result = await ensureDevNamespace(
      conn as unknown as Parameters<typeof ensureDevNamespace>[0],
      DEV_TEMPORAL_NAMESPACE,
      () => { /* silent */ },
    );
    expect(result.status).to.equal('already-exists');
  });

  it('permission denied — status="permission-denied", daemon continues, hint logged', async function () {
    const calls: RegisterCall[] = [];
    const err = Object.assign(new Error('caller is not allowed to register namespaces'), {
      code: 'PERMISSION_DENIED',
    });
    const logged: unknown[][] = [];
    const conn = makeStubConnection({ recordedCalls: calls, reject: err });
    const result = await ensureDevNamespace(
      conn as unknown as Parameters<typeof ensureDevNamespace>[0],
      DEV_TEMPORAL_NAMESPACE,
      (...args) => logged.push(args),
    );
    expect(result.ok).to.equal(false);
    expect(result.status).to.equal('permission-denied');
    // Operator gets an actionable hint pointing at the manual-create command.
    const flat = logged.flat().join(' ');
    expect(flat).to.match(/permission denied/i);
    expect(flat).to.match(/temporal operator namespace create/i);
  });

  it('unknown error — status="error", daemon continues without throwing', async function () {
    const calls: RegisterCall[] = [];
    const err = new Error('connection reset by peer');
    const conn = makeStubConnection({ recordedCalls: calls, reject: err });
    const result = await ensureDevNamespace(
      conn as unknown as Parameters<typeof ensureDevNamespace>[0],
      DEV_TEMPORAL_NAMESPACE,
      () => { /* silent */ },
    );
    expect(result.ok).to.equal(false);
    expect(result.status).to.equal('error');
    expect(result.message).to.match(/connection reset/i);
  });

  it('does not throw on rejection — caller can always proceed to worker bootstrap', async function () {
    // Hard contract: ensureDevNamespace never throws. The daemon's main()
    // calls it before createWorkers(); a thrown exception would crash the
    // boot sequence instead of degrading to a clearer "Namespace not
    // found" error from Temporal.
    const calls: RegisterCall[] = [];
    const conn = makeStubConnection({
      recordedCalls: calls,
      reject: new Error('boom'),
    });
    let threw = false;
    try {
      await ensureDevNamespace(
        conn as unknown as Parameters<typeof ensureDevNamespace>[0],
        DEV_TEMPORAL_NAMESPACE,
        () => { /* silent */ },
      );
    } catch {
      threw = true;
    }
    expect(threw).to.equal(false);
  });
});
