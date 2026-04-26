/**
 * Unit coverage for the #274 join layer (`src/utils/hosts.ts`) and shared
 * formatter (`src/utils/format-hosts.ts`).
 *
 * Every test uses dep-injected `describePollers` and `fetchProfiles`
 * stubs, so no Temporal connection is needed. Covers architect's AC6
 * + M13 (identity-vs-profile reconciliation) + QA invariant #4.
 */
import { expect } from 'chai';
import { temporal } from '@temporalio/proto';
import type { Client } from '@temporalio/client';
import type { HostInfo, HostProfile } from '../src/types';
import {
  listHosts,
  parseIdentity,
  __resetHostsCacheForTests,
  HOST_FRESHNESS_THRESHOLD_MS,
  HOST_FANOUT_CONCURRENCY,
} from '../src/utils/hosts';
import { formatHostList } from '../src/utils/format-hosts';

type TaskQueueType = temporal.api.enums.v1.TaskQueueType;
const { TASK_QUEUE_TYPE_WORKFLOW, TASK_QUEUE_TYPE_ACTIVITY } = temporal.api.enums.v1.TaskQueueType;

const fakeClient = {} as Client;
const NOW = 1_745_000_000_000; // frozen unix ms for deterministic freshness checks

function iso(relMs: number): string {
  return new Date(NOW + relMs).toISOString();
}

// RawPoller shape — mirror of the internal type. Keep in sync with src/utils/hosts.ts.
interface RawPoller {
  identity: string;
  lastAccessTimeMs: number;
  lastAccessTimeIso: string;
}

function mkPoller(identity: string, ageMs: number): RawPoller {
  const ts = NOW - ageMs;
  return {
    identity,
    lastAccessTimeMs: ts,
    lastAccessTimeIso: new Date(ts).toISOString(),
  };
}

/**
 * Build a canned `describePollers` stub. Key on `<taskQueueName>:<type>`.
 * Missing keys → empty pollers (mimics a queue with nobody polling).
 */
function stubDescribe(table: Record<string, RawPoller[]>) {
  return async (
    _client: Client,
    _namespace: string,
    taskQueueName: string,
    taskQueueType: TaskQueueType,
  ): Promise<RawPoller[]> => {
    const key = `${taskQueueName}:${taskQueueType}`;
    return table[key] ?? [];
  };
}

describe('parseIdentity (#274 AC6d)', function () {
  it('parses the post-#274 format `claude-tempo:<hostname>:<pid>:<version>`', function () {
    expect(parseIdentity('claude-tempo:mac-alice:12345:0.26.0-beta.7')).to.deep.equal({
      hostname: 'mac-alice',
      pid: 12345,
      version: '0.26.0-beta.7',
      legacy: false,
    });
  });

  it('parses the legacy SDK default `<pid>@<hostname>`', function () {
    expect(parseIdentity('9876@win-bob')).to.deep.equal({
      hostname: 'win-bob',
      pid: 9876,
      version: 'unknown',
      legacy: true,
    });
  });

  it('returns null for opaque third-party identities (skipped silently)', function () {
    expect(parseIdentity('some-other-worker-identity')).to.equal(null);
    expect(parseIdentity('')).to.equal(null);
    // Note: `claude-tempo:too:few` is malformed (3-segment), covered by the
    // next test's rejection path — not a taxonomy-opaque case.
    expect(parseIdentity('abc@host')).to.equal(null); // non-numeric pid
    expect(parseIdentity('0@host')).to.equal(null); // pid must be > 0
  });

  it('rejects malformed post-#274 format with wrong segment count', function () {
    expect(parseIdentity('claude-tempo:only:two')).to.equal(null);
    expect(parseIdentity('claude-tempo:a:1:v:extra')).to.equal(null);
  });
});

describe('listHosts (#274 AC6)', function () {
  beforeEach(() => __resetHostsCacheForTests());

  const profileFresh: HostProfile = {
    hostname: 'mac-alice',
    version: '0.26.0-beta.7',
    defaultAgent: 'claude',
    availableAgentTypes: ['claude'],
    availablePlayerTypes: ['tempo-soloist'],
    claudeBin: 'claude',
    platform: 'darwin',
  };

  it('happy path — single host with all three worker streams → live + recruit-ready', async function () {
    const ident = 'claude-tempo:mac-alice:12345:0.26.0-beta.7';
    const table: Record<string, RawPoller[]> = {
      [`claude-tempo:${TASK_QUEUE_TYPE_WORKFLOW}`]: [mkPoller(ident, 5_000)],
      [`claude-tempo:${TASK_QUEUE_TYPE_ACTIVITY}`]: [mkPoller(ident, 3_000)],
      [`claude-tempo-mac-alice:${TASK_QUEUE_TYPE_ACTIVITY}`]: [mkPoller(ident, 1_000)],
    };
    const hosts = await listHosts(fakeClient, {
      force: true,
      deps: {
        now: () => NOW,
        describePollers: stubDescribe(table),
        fetchProfiles: async () => ({ 'mac-alice': profileFresh }),
      },
    });
    expect(hosts).to.have.length(1);
    const [h] = hosts;
    expect(h.hostname).to.equal('mac-alice');
    expect(h.freshness).to.equal('live');
    expect(h.recruitReady).to.equal(true);
    expect(h.profileStaleness).to.equal('fresh');
    expect(h.instances).to.have.length(1);
    expect(h.instances[0]).to.include({
      pid: 12345,
      version: '0.26.0-beta.7',
      hasWorkflowWorker: true,
      hasActivityWorker: true,
      hasHostQueueWorker: true,
    });
  });

  it('only one of workflow/activity present — still lists host but recruitReady=false', async function () {
    const ident = 'claude-tempo:h:1:0.26';
    const table: Record<string, RawPoller[]> = {
      [`claude-tempo:${TASK_QUEUE_TYPE_WORKFLOW}`]: [mkPoller(ident, 2_000)],
      // no activity, no per-host
    };
    const hosts = await listHosts(fakeClient, {
      force: true,
      deps: {
        now: () => NOW,
        describePollers: stubDescribe(table),
        fetchProfiles: async () => ({}),
      },
    });
    expect(hosts).to.have.length(1);
    expect(hosts[0].recruitReady).to.equal(false);
    expect(hosts[0].instances[0].hasWorkflowWorker).to.equal(true);
    expect(hosts[0].instances[0].hasActivityWorker).to.equal(false);
    expect(hosts[0].instances[0].hasHostQueueWorker).to.equal(false);
  });

  it('stale pollers (lastAccessTime > freshness threshold) → freshness=stale, recruitReady=false', async function () {
    const ident = 'claude-tempo:h:1:0.26';
    const stale = HOST_FRESHNESS_THRESHOLD_MS + 10_000; // well past threshold
    const table: Record<string, RawPoller[]> = {
      [`claude-tempo:${TASK_QUEUE_TYPE_WORKFLOW}`]: [mkPoller(ident, stale)],
      [`claude-tempo:${TASK_QUEUE_TYPE_ACTIVITY}`]: [mkPoller(ident, stale)],
      [`claude-tempo-h:${TASK_QUEUE_TYPE_ACTIVITY}`]: [mkPoller(ident, stale)],
    };
    const hosts = await listHosts(fakeClient, {
      force: true,
      deps: {
        now: () => NOW,
        describePollers: stubDescribe(table),
        fetchProfiles: async () => null,
      },
    });
    expect(hosts).to.have.length(1);
    expect(hosts[0].freshness).to.equal('stale');
    expect(hosts[0].recruitReady).to.equal(false);
  });

  it('M13 identity-vs-profile reconciliation — version mismatch → profileStaleness=stale', async function () {
    // Identity says v0.27.0, profile says v0.26.0 — identity wins (live truth).
    const ident = 'claude-tempo:h:1:0.27.0';
    const table: Record<string, RawPoller[]> = {
      [`claude-tempo:${TASK_QUEUE_TYPE_WORKFLOW}`]: [mkPoller(ident, 1_000)],
    };
    const hosts = await listHosts(fakeClient, {
      force: true,
      deps: {
        now: () => NOW,
        describePollers: stubDescribe(table),
        fetchProfiles: async () => ({
          h: { hostname: 'h', version: '0.26.0' },
        }),
      },
    });
    expect(hosts).to.have.length(1);
    expect(hosts[0].instances[0].version).to.equal('0.27.0', 'identity wins on version');
    expect(hosts[0].profileStaleness).to.equal('stale');
    expect(hosts[0].profile?.version).to.equal('0.26.0', 'stored profile version unchanged');
  });

  it('fetchProfiles returns null (maestro absent) → all hosts get profileStaleness=missing', async function () {
    const ident = 'claude-tempo:h:1:0.26';
    const table: Record<string, RawPoller[]> = {
      [`claude-tempo:${TASK_QUEUE_TYPE_WORKFLOW}`]: [mkPoller(ident, 1_000)],
    };
    const hosts = await listHosts(fakeClient, {
      force: true,
      deps: {
        now: () => NOW,
        describePollers: stubDescribe(table),
        fetchProfiles: async () => null,
      },
    });
    expect(hosts[0].profile).to.equal(undefined);
    expect(hosts[0].profileStaleness).to.equal('missing');
  });

  it('fetchProfiles empty map but maestro present — host still missing its specific profile', async function () {
    const ident = 'claude-tempo:h:1:0.26';
    const table: Record<string, RawPoller[]> = {
      [`claude-tempo:${TASK_QUEUE_TYPE_WORKFLOW}`]: [mkPoller(ident, 1_000)],
    };
    const hosts = await listHosts(fakeClient, {
      force: true,
      deps: {
        now: () => NOW,
        describePollers: stubDescribe(table),
        fetchProfiles: async () => ({}), // maestro reachable, empty map
      },
    });
    expect(hosts[0].profileStaleness).to.equal('missing');
  });

  it('multiple instances (same hostname, different pids) grouped under one HostInfo', async function () {
    const table: Record<string, RawPoller[]> = {
      [`claude-tempo:${TASK_QUEUE_TYPE_WORKFLOW}`]: [
        mkPoller('claude-tempo:h:1:0.26', 1_000),
        mkPoller('claude-tempo:h:2:0.26', 1_000),
      ],
    };
    const hosts = await listHosts(fakeClient, {
      force: true,
      deps: {
        now: () => NOW,
        describePollers: stubDescribe(table),
        fetchProfiles: async () => null,
      },
    });
    expect(hosts).to.have.length(1);
    expect(hosts[0].instances.map((i) => i.pid).sort()).to.deep.equal([1, 2]);
  });

  it('per-host fan-out scales past HOST_FANOUT_CONCURRENCY without dropping hosts (#281)', async function () {
    // 2× the cap so we know the limiter has to queue some calls. Every
    // host should still appear in the result — the cap throttles RPCs,
    // it must never silently drop work.
    const hostCount = HOST_FANOUT_CONCURRENCY * 2;
    const table: Record<string, RawPoller[]> = {};
    const expectedHostnames: string[] = [];
    for (let i = 0; i < hostCount; i++) {
      const hostname = `h${i}`;
      expectedHostnames.push(hostname);
      const ident = `claude-tempo:${hostname}:${1000 + i}:0.27.0`;
      table[`claude-tempo:${TASK_QUEUE_TYPE_WORKFLOW}`] = [
        ...(table[`claude-tempo:${TASK_QUEUE_TYPE_WORKFLOW}`] ?? []),
        mkPoller(ident, 1_000),
      ];
      table[`claude-tempo-${hostname}:${TASK_QUEUE_TYPE_ACTIVITY}`] = [mkPoller(ident, 1_000)];
    }

    let perHostQueueCalls = 0;
    const describe = async (
      _c: Client, _ns: string, taskQueueName: string, taskQueueType: TaskQueueType,
    ): Promise<RawPoller[]> => {
      if (taskQueueName.startsWith('claude-tempo-')) perHostQueueCalls++;
      return table[`${taskQueueName}:${taskQueueType}`] ?? [];
    };

    const hosts = await listHosts(fakeClient, {
      force: true,
      deps: { now: () => NOW, describePollers: describe, fetchProfiles: async () => null },
    });

    expect(hosts).to.have.length(hostCount);
    expect(hosts.map((h) => h.hostname).sort()).to.deep.equal(expectedHostnames.slice().sort());
    expect(perHostQueueCalls).to.equal(hostCount, 'every host queue is described exactly once');
  });

  it('opaque third-party identities are skipped silently', async function () {
    const table: Record<string, RawPoller[]> = {
      [`claude-tempo:${TASK_QUEUE_TYPE_WORKFLOW}`]: [
        mkPoller('claude-tempo:h:1:0.26', 1_000),
        mkPoller('some-other-worker', 1_000),
      ],
    };
    const hosts = await listHosts(fakeClient, {
      force: true,
      deps: {
        now: () => NOW,
        describePollers: stubDescribe(table),
        fetchProfiles: async () => null,
      },
    });
    expect(hosts).to.have.length(1);
    expect(hosts[0].hostname).to.equal('h');
  });

  it('legacy identity is accepted and tagged with legacy:true', async function () {
    const table: Record<string, RawPoller[]> = {
      [`claude-tempo:${TASK_QUEUE_TYPE_WORKFLOW}`]: [mkPoller('42@legacy-host', 1_000)],
    };
    const hosts = await listHosts(fakeClient, {
      force: true,
      deps: {
        now: () => NOW,
        describePollers: stubDescribe(table),
        fetchProfiles: async () => null,
      },
    });
    expect(hosts).to.have.length(1);
    expect(hosts[0].instances[0].legacy).to.equal(true);
    expect(hosts[0].instances[0].version).to.equal('unknown');
  });

  it('cache: two calls within TTL use the memoized result; force:true bypasses', async function () {
    let calls = 0;
    const describe = async (
      _c: Client, _ns: string, _q: string, _t: TaskQueueType,
    ): Promise<RawPoller[]> => {
      calls++;
      return [mkPoller('claude-tempo:h:1:0.26', 1_000)];
    };
    const deps = { now: () => NOW, describePollers: describe, fetchProfiles: async () => null };
    const first = await listHosts(fakeClient, { force: true, deps });
    const callsAfterFirst = calls;
    const second = await listHosts(fakeClient, { deps });
    expect(calls).to.equal(callsAfterFirst, 'cache hit — no additional describe calls');
    expect(second).to.deep.equal(first);

    const third = await listHosts(fakeClient, { force: true, deps });
    expect(calls).to.be.greaterThan(callsAfterFirst, 'force:true bypassed cache');
    expect(third).to.deep.equal(first);
  });

  it('empty result when no pollers', async function () {
    const hosts = await listHosts(fakeClient, {
      force: true,
      deps: {
        now: () => NOW,
        describePollers: async () => [],
        fetchProfiles: async () => null,
      },
    });
    expect(hosts).to.deep.equal([]);
  });
});

describe('formatHostList (#274 AC10a)', function () {
  const liveHost: HostInfo = {
    hostname: 'mac-alice',
    instances: [
      {
        pid: 12345,
        version: '0.26.0-beta.7',
        identity: 'claude-tempo:mac-alice:12345:0.26.0-beta.7',
        lastAccessTime: '2026-04-20T00:00:00.000Z',
        hasWorkflowWorker: true,
        hasActivityWorker: true,
        hasHostQueueWorker: true,
      },
    ],
    recruitReady: true,
    freshness: 'live',
    profile: {
      hostname: 'mac-alice',
      version: '0.26.0-beta.7',
      defaultAgent: 'claude',
      availableAgentTypes: ['claude'],
      availablePlayerTypes: ['tempo-soloist', 'tempo-critic'],
      claudeBin: 'claude',
      platform: 'darwin',
    },
    profileStaleness: 'fresh',
  };

  it('empty list renders the "no hosts" sentinel', function () {
    expect(formatHostList([])).to.equal('No hosts connected.');
  });

  it('all-stale-hidden case suggests --all', function () {
    const staleOnly: HostInfo = { ...liveHost, freshness: 'stale' };
    const out = formatHostList([staleOnly]);
    expect(out).to.include('No live hosts connected');
    expect(out).to.include('--all');
  });

  it('live host renders hostname, recruit-ready, instance, profile', function () {
    const out = formatHostList([liveHost]);
    expect(out).to.include('1 host connected');
    expect(out).to.include('mac-alice');
    expect(out).to.include('recruit-ready');
    expect(out).to.include('pid 12345');
    expect(out).to.include('version 0.26.0-beta.7');
    expect(out).to.include('workers: wf+act+host');
    expect(out).to.include('platform: darwin');
    expect(out).to.include('default agent: claude');
    expect(out).to.include('available player types: tempo-soloist, tempo-critic');
  });

  it('profile missing → renders "(profile unavailable)"', function () {
    const out = formatHostList([{ ...liveHost, profile: undefined, profileStaleness: 'missing' }]);
    expect(out).to.include('(profile unavailable)');
  });

  it('profile stale → renders the disagreement warning', function () {
    const out = formatHostList([{ ...liveHost, profileStaleness: 'stale' }]);
    expect(out).to.include('profile version disagrees with live identity');
  });

  it('legacy-identity instance is flagged', function () {
    const legacyHost: HostInfo = {
      ...liveHost,
      instances: [{ ...liveHost.instances[0], legacy: true, version: 'unknown' }],
    };
    const out = formatHostList([legacyHost]);
    expect(out).to.include('legacy-identity');
  });

  it('includeStale:true shows stale hosts', function () {
    const staleOnly: HostInfo = { ...liveHost, freshness: 'stale', recruitReady: false };
    const out = formatHostList([staleOnly], { includeStale: true });
    expect(out).to.include('(stale)');
    expect(out).to.include('not recruit-ready');
  });

  it('plural "2 hosts connected" when list has 2 live entries', function () {
    const h2: HostInfo = { ...liveHost, hostname: 'mac-bob' };
    const out = formatHostList([liveHost, h2]);
    expect(out).to.include('2 hosts connected');
  });
});
