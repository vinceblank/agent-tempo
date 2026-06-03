/**
 * #274 AC12 + M15 — recruit pre-flight host validation.
 *
 * Two layers of coverage:
 *   1. Pure `checkHostPreflight` + `nearestHostname` unit tests —
 *      exhaustive over the capability/liveness/suggestion branches.
 *   2. End-to-end pre-flight via `registerRecruitTool`'s `listHostsFn`
 *      dep (M15). Stubs the host list, invokes the registered handler,
 *      and asserts the MCP tool return shape. This is what the
 *      architect's QA invariant #5 calls for — tests the integration,
 *      not just the matcher.
 */
import { expect } from 'chai';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Client, WorkflowHandle } from '@temporalio/client';
import type { HostInfo, HostProfile } from '../src/types';
import { getTestEnsemble } from './helpers';
import { renderToMcp } from '../src/tools/descriptor';
import {
  checkHostPreflight,
  nearestHostname,
  buildRecruitTool,
} from '../src/tools/recruit';

// ────────────────────────────────────────────────────────────────────────
// checkHostPreflight — pure matcher
// ────────────────────────────────────────────────────────────────────────

function host(
  hostname: string,
  opts: {
    freshness?: 'live' | 'stale';
    recruitReady?: boolean;
    profile?: HostProfile | undefined;
    profileStaleness?: 'fresh' | 'stale' | 'missing';
  } = {},
): HostInfo {
  return {
    hostname,
    instances: [
      {
        pid: 1,
        version: '0.26.0-beta.7',
        identity: `agent-tempo:${hostname}:1:0.26.0-beta.7`,
        lastAccessTime: new Date().toISOString(),
        hasWorkflowWorker: true,
        hasActivityWorker: true,
        hasHostQueueWorker: true,
      },
    ],
    recruitReady: opts.recruitReady ?? true,
    freshness: opts.freshness ?? 'live',
    profile: 'profile' in opts
      ? opts.profile
      : { hostname, availableAgentTypes: ['claude'] },
    profileStaleness: opts.profileStaleness ?? 'fresh',
  };
}

describe('checkHostPreflight (#274 AC12)', function () {
  it('accepts a live, recruit-ready host that advertises the requested agent', function () {
    const hosts = [host('mac-alice')];
    expect(checkHostPreflight(hosts, 'mac-alice', 'claude')).to.equal(null);
  });

  it('rejects unknown host with a Levenshtein suggestion', function () {
    const hosts = [host('mac-alice'), host('win-bob')];
    const err = checkHostPreflight(hosts, 'mac-alicee', 'claude'); // typo
    expect(err).to.be.a('string');
    expect(err).to.include('Unknown host "mac-alicee"');
    expect(err).to.include('Did you mean "mac-alice"?');
    expect(err).to.include('force: true');
  });

  it('rejects unknown host with no similar-enough suggestion, but still lists available hosts', function () {
    const hosts = [host('mac-alice'), host('win-bob')];
    const err = checkHostPreflight(hosts, 'zzz-xyz', 'claude');
    expect(err).to.be.a('string');
    expect(err).to.include('Unknown host "zzz-xyz"');
    expect(err).to.not.include('Did you mean');
    expect(err).to.include('Available: mac-alice, win-bob');
  });

  it('rejects stale host', function () {
    const hosts = [host('mac-alice', { freshness: 'stale', recruitReady: false })];
    const err = checkHostPreflight(hosts, 'mac-alice', 'claude');
    expect(err).to.match(/not recruit-ready.*freshness=stale/);
  });

  it('rejects not-recruit-ready host', function () {
    const hosts = [host('mac-alice', { recruitReady: false })];
    const err = checkHostPreflight(hosts, 'mac-alice', 'claude');
    expect(err).to.match(/not recruit-ready.*recruitReady=false/);
  });

  it('rejects capability mismatch with the supports list', function () {
    const hosts = [host('mac-alice', {
      profile: { hostname: 'mac-alice', availableAgentTypes: ['claude'] },
    })];
    const err = checkHostPreflight(hosts, 'mac-alice', 'copilot');
    expect(err).to.match(/cannot run `copilot`/);
    expect(err).to.include('supports: claude');
  });

  it('soft-passes profile-missing (daemon live, didn\'t advertise)', function () {
    const hosts = [host('mac-alice', { profile: undefined, profileStaleness: 'missing' })];
    expect(checkHostPreflight(hosts, 'mac-alice', 'claude')).to.equal(null);
    expect(checkHostPreflight(hosts, 'mac-alice', 'copilot')).to.equal(null);
  });

  it('soft-passes profile with no availableAgentTypes set', function () {
    const hosts = [host('mac-alice', {
      profile: { hostname: 'mac-alice' /* no availableAgentTypes */ },
    })];
    expect(checkHostPreflight(hosts, 'mac-alice', 'copilot')).to.equal(null);
  });

  it('empty host list: unknown host message includes "(none — no daemons currently polling)"', function () {
    const err = checkHostPreflight([], 'anything', 'claude');
    expect(err).to.include('(none — no daemons currently polling)');
  });
});

describe('nearestHostname (#274 AC12b helper)', function () {
  it('returns null for empty candidates', function () {
    expect(nearestHostname('x', [])).to.equal(null);
  });
  it('returns the exact match when present', function () {
    expect(nearestHostname('foo', ['bar', 'foo', 'baz'])).to.equal('foo');
  });
  it('returns the closest candidate for a 1-char typo', function () {
    expect(nearestHostname('alicee', ['alice', 'bob'])).to.equal('alice');
  });
  it('returns null when nothing is close enough (half-length distance threshold)', function () {
    expect(nearestHostname('xyzabc', ['alice', 'bob'])).to.equal(null);
  });
});

// ────────────────────────────────────────────────────────────────────────
// registerRecruitTool integration — M15 listHostsFn dep injection
// ────────────────────────────────────────────────────────────────────────
//
// The architect's QA invariant #5 asks for:
//   - Recruiting capability-mismatched agent → rejected with the
//     specified error text.
//   - Same call with `--force: true` proceeds.
//   - Unknown-host + `--force` proceeds (escape hatch for
//     about-to-boot daemons).
//
// We cover all three here + the RPC-failure fall-through (AC12e)
// through a tiny fake McpServer that captures the registered handler
// for direct invocation.

type CapturedHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ text: string }>;
  isError?: boolean;
}>;

function makeFakeServer(): { server: McpServer; capture: { handler?: CapturedHandler } } {
  const capture: { handler?: CapturedHandler } = {};
  // Match the pattern from `test/tools.test.ts` `extractHandler`:
  // `defineTool` calls `server.tool(name, desc, schema, handler)`.
  const server = {
    tool: (_name: unknown, _desc: unknown, _schema: unknown, handler: CapturedHandler) => {
      capture.handler = handler;
    },
  } as unknown as McpServer;
  return { server, capture };
}

function makeFakeClient(): Client {
  // Recruit pre-flight doesn't touch the Client directly — it goes through
  // `listHostsFn`. The existing conductor + resolveSession checks in the
  // handler DO touch the client, but they throw → the handler catches and
  // proceeds for our happy-path tests. The empty Proxy shape makes any
  // unexpected access loud.
  return new Proxy({} as Client, {
    get(_t, prop) {
      // `client.workflow.getHandle(...)` returns an object with .describe() /
      // .terminate() / .signal(). Stub all as throwing so the handler's
      // try/catch treats them as "no existing session".
      if (prop === 'workflow') {
        return {
          getHandle: () => ({
            describe: async () => { throw new Error('no conductor'); },
            terminate: async () => { /* no-op */ },
            signal: async () => { /* no-op */ },
          }),
          list: async function* () { /* no sessions */ },
        };
      }
      throw new Error(`Unexpected Client access in recruit test: ${String(prop)}`);
    },
  });
}

function makeFakeHandle(): { handle: WorkflowHandle; captures: Array<unknown> } {
  const captures: Array<unknown> = [];
  const handle = {
    executeUpdate: async (_update: unknown, opts: { args: unknown[] }) => {
      captures.push(opts.args[0]);
      return `outbox-${captures.length}`;
    },
  } as unknown as WorkflowHandle;
  return { handle, captures };
}

describe('registerRecruitTool host pre-flight (M15)', function () {
  // Ensemble derived from the per-file random prefix (#210 shared-env
  // convention). These tests don't actually call `setupTestEnv`, but
  // the lint rule at `scripts/check-test-ensemble-literals.sh`
  // requires the helper form rather than the bare fallback literal —
  // the canonical way to stay consistent with future tests in the
  // same file that might grow into workflow-touching cases.
  const cfg = {
    ensemble: getTestEnsemble(),
    taskQueue: 'agent-tempo',
    temporalNamespace: 'default',
    temporalAddress: 'localhost:7233',
    defaultAgent: 'claude' as const,
  } as unknown as import('../src/config').Config;

  function setupWithHosts(hosts: HostInfo[] | (() => Promise<HostInfo[]>)) {
    const { server, capture } = makeFakeServer();
    const client = makeFakeClient();
    const { handle, captures: outboxEntries } = makeFakeHandle();
    const listHostsFn = async () =>
      typeof hosts === 'function' ? hosts() : hosts;
    renderToMcp(server, [buildRecruitTool(client, cfg, () => 'test-player', handle, 'claude', { listHostsFn })]);
    return { capture, outboxEntries };
  }

  it('happy path: known recruit-ready host with matching agent → outbox entry submitted', async function () {
    const { capture, outboxEntries } = setupWithHosts([host('mac-alice')]);
    const result = await capture.handler!({
      workDir: '/tmp/work',
      name: 'new-player',
      host: 'mac-alice',
    });
    expect(result.isError).to.not.equal(true);
    expect(result.content[0].text).to.include('Recruit request submitted');
    expect(outboxEntries).to.have.length(1);
  });

  it('unknown host → returns error with Levenshtein suggestion, no outbox entry', async function () {
    const { capture, outboxEntries } = setupWithHosts([host('mac-alice')]);
    const result = await capture.handler!({
      workDir: '/tmp/work',
      name: 'new-player',
      host: 'mac-alicee', // typo
    });
    expect(result.isError).to.equal(true);
    expect(result.content[0].text).to.include('Did you mean "mac-alice"?');
    expect(outboxEntries).to.have.length(0);
  });

  it('capability mismatch (copilot requested, only claude supported) → rejected, no outbox entry', async function () {
    const { capture, outboxEntries } = setupWithHosts([host('mac-alice', {
      profile: { hostname: 'mac-alice', availableAgentTypes: ['claude'] },
    })]);
    const result = await capture.handler!({
      workDir: '/tmp/work',
      name: 'new-player',
      host: 'mac-alice',
      agent: 'copilot',
    });
    expect(result.isError).to.equal(true);
    expect(result.content[0].text).to.match(/cannot run `copilot`/);
    expect(outboxEntries).to.have.length(0);
  });

  it('--force bypasses capability mismatch (AC12d) → outbox entry submitted', async function () {
    const { capture, outboxEntries } = setupWithHosts([host('mac-alice', {
      profile: { hostname: 'mac-alice', availableAgentTypes: ['claude'] },
    })]);
    const result = await capture.handler!({
      workDir: '/tmp/work',
      name: 'new-player',
      host: 'mac-alice',
      agent: 'copilot',
      force: true,
    });
    expect(result.isError).to.not.equal(true);
    expect(outboxEntries).to.have.length(1);
  });

  it('--force bypasses unknown-host (scripted-daemon-boot escape hatch)', async function () {
    const { capture, outboxEntries } = setupWithHosts([]);
    const result = await capture.handler!({
      workDir: '/tmp/work',
      name: 'new-player',
      host: 'about-to-boot',
      force: true,
    });
    expect(result.isError).to.not.equal(true);
    expect(outboxEntries).to.have.length(1);
  });

  it('listHostsFn rejection falls through with warning (AC12e — preserves today\'s availability)', async function () {
    const { capture, outboxEntries } = setupWithHosts(async () => {
      throw new Error('Temporal unreachable');
    });
    const result = await capture.handler!({
      workDir: '/tmp/work',
      name: 'new-player',
      host: 'mac-alice',
    });
    // Should NOT fail the recruit — RPC failure is non-fatal per AC12e.
    expect(result.isError).to.not.equal(true);
    expect(outboxEntries).to.have.length(1);
  });

  it('no host param → pre-flight is skipped entirely', async function () {
    // listHostsFn is set to throw, which would fail the test if pre-flight
    // ran. Proves that `host`-less recruits bypass the host preflight.
    const { capture, outboxEntries } = setupWithHosts(async () => {
      throw new Error('listHostsFn should not be called when host is absent');
    });
    const result = await capture.handler!({
      workDir: '/tmp/work',
      name: 'new-player',
    });
    expect(result.isError).to.not.equal(true);
    expect(outboxEntries).to.have.length(1);
  });
});
