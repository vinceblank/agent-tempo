/**
 * Unit tests for `enforceYesStealGuard` — the shared MCP-tool-side
 * `--yes-steal` guard used by both `restart` and `migrate` tools
 * (design §16.5 Option B, brief §8 answer 5).
 *
 * No Temporal connection — the guard is fed a mock Client that returns
 * a fixture `attachmentInfo` query result. The rule under test:
 *
 *   force + target attached to different host + no confirmStealFromHost → error
 *   force + target attached to different host + wrong confirmStealFromHost → error
 *   force + target attached to different host + matching confirmStealFromHost → allow
 *   force + target attached to local host → allow
 *   no force → allow (regardless of target host)
 *   no target resolved → allow (downstream handles the error)
 */
import { expect } from 'chai';
import { enforceYesStealGuard } from '../src/tools/restart';
import type { AttachmentInfo } from '../src/types';

const asName = (n: unknown) => typeof n === 'string' ? n : (n as any).name;

function makeClient(opts: {
  found?: boolean;
  info?: AttachmentInfo;
  queryError?: Error;
} = {}): any {
  const found = opts.found !== false; // default: found
  const handle = {
    workflowId: 'claude-session-e1-alice',
    async query(name: unknown) {
      if (opts.queryError) throw opts.queryError;
      if (asName(name) === 'attachmentInfo') return opts.info;
      if (asName(name) === 'getMetadata') {
        return { ensemble: 'e1', playerId: 'alice' };
      }
      return undefined;
    },
  };
  return {
    workflow: {
      getHandle: () => handle,
      async *list() {
        if (found) yield { workflowId: handle.workflowId };
      },
    },
  };
}

function info(currentHost: string | undefined): AttachmentInfo {
  return {
    phase: 'attached',
    inFlightCount: 0,
    ...(currentHost !== undefined ? {
      currentAttachment: {
        attachmentId: 'a1',
        hostname: currentHost,
        adapterId: 'claude-code',
        adapterClass: 'interactive',
        claimedAt: '2026-04-12T00:00:00Z',
        lastHeartbeatAt: '2026-04-13T00:00:00Z',
        expiresAt: '2026-04-13T01:30:00Z',
        leaseMs: 90_000,
        runId: 'r1',
      },
    } : {}),
  };
}

describe('enforceYesStealGuard (§16.5 Option B)', function () {
  it('allows non-force restarts regardless of host', async function () {
    const client = makeClient({ info: info('remote-host') });
    const err = await enforceYesStealGuard(client, 'e1', 'alice', { force: false }, 'local');
    expect(err).to.be.null;
  });

  it('allows force-restart when target is on the same host', async function () {
    const client = makeClient({ info: info('local') });
    const err = await enforceYesStealGuard(
      client, 'e1', 'alice', { force: true }, 'local',
    );
    expect(err).to.be.null;
  });

  it('allows force-restart when target has no current attachment', async function () {
    const client = makeClient({ info: info(undefined) });
    const err = await enforceYesStealGuard(
      client, 'e1', 'alice', { force: true }, 'local',
    );
    expect(err).to.be.null;
  });

  it('rejects force-restart across hosts without confirmStealFromHost', async function () {
    const client = makeClient({ info: info('remote-host') });
    const err = await enforceYesStealGuard(
      client, 'e1', 'alice', { force: true }, 'local',
    );
    expect(err).to.be.a('string');
    expect(err!).to.include('remote-host');
    expect(err!).to.include('confirmStealFromHost');
    expect(err!).to.include('"remote-host"');
  });

  it('rejects force-restart with mismatched confirmStealFromHost', async function () {
    const client = makeClient({ info: info('remote-host') });
    const err = await enforceYesStealGuard(
      client, 'e1', 'alice',
      { force: true, confirmStealFromHost: 'wrong-host' },
      'local',
    );
    expect(err).to.be.a('string');
    expect(err!).to.include('mismatch');
    expect(err!).to.include('"remote-host"');
    expect(err!).to.include('"wrong-host"');
  });

  it('allows force-restart across hosts with matching confirmStealFromHost', async function () {
    const client = makeClient({ info: info('remote-host') });
    const err = await enforceYesStealGuard(
      client, 'e1', 'alice',
      { force: true, confirmStealFromHost: 'remote-host' },
      'local',
    );
    expect(err).to.be.null;
  });

  it('allows when target session is not found (let downstream handle it)', async function () {
    const client = makeClient({ found: false });
    const err = await enforceYesStealGuard(
      client, 'e1', 'alice', { force: true, confirmStealFromHost: 'anything' }, 'local',
    );
    expect(err).to.be.null;
  });

  it('allows when attachmentInfo query throws (let downstream handle it)', async function () {
    const client = makeClient({ queryError: new Error('workflow-gone') });
    const err = await enforceYesStealGuard(
      client, 'e1', 'alice', { force: true }, 'local',
    );
    expect(err).to.be.null;
  });
});
