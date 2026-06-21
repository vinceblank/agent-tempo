/**
 * #742 — mission-control read-view parity commands (the P0 gap closure that
 * lets the Ink TUI be deleted). Each gap wires a daemon HTTP route → a
 * `MissionControlActions` method → a `Controller` text-builder that reuses the
 * SAME shared formatter the CLI/MCP surfaces use. These unit tests drive the
 * actions+controller text-builders over an injected fake `fetch` (no daemon),
 * asserting the route is hit and the shared formatter's output flows through.
 */
import { describe, it, expect } from 'vitest';
import { MissionControlActions, type ActionFetch } from '../../src/pi/mission-control/actions';
import { Controller } from '../../src/pi/mission-control/extension';
import type { HostInfo } from '../../src/types';
import type { McExtensionContext } from '../../src/pi/mission-control/pi-ui';

/** Fake extension context capturing `ui.notify` messages. */
function fakeCtx(): { ctx: McExtensionContext; notified: string[] } {
  const notified: string[] = [];
  const ctx = { hasUI: true, ui: { notify: (m: string) => notified.push(m) } } as unknown as McExtensionContext;
  return { ctx, notified };
}

/** Fake fetch returning a fixed JSON body; records the URLs/methods hit. */
function fakeFetch(body: unknown, status = 200): { fetchFn: ActionFetch; calls: Array<{ url: string; method: string }> } {
  const calls: Array<{ url: string; method: string }> = [];
  const fetchFn: ActionFetch = async (url, init) => {
    calls.push({ url, method: init.method });
    return { status, text: async () => JSON.stringify(body) };
  };
  return { fetchFn, calls };
}

function makeController(fetchFn: ActionFetch, ensemble = 'demo'): Controller {
  const actions = new MissionControlActions({ ensemble, baseUrl: 'http://127.0.0.1:9999', adminToken: 'tok', fetchFn });
  return new Controller(ensemble, actions, 'test-host');
}

const liveHost: HostInfo = {
  hostname: 'alpha',
  freshness: 'live',
  recruitReady: true,
  instances: [{ pid: 1234, version: '1.7.0', hasWorkflowWorker: true, hasActivityWorker: true, hasHostQueueWorker: false }],
  profile: { platform: 'linux', availableAgentTypes: ['claude'] },
} as unknown as HostInfo;

const staleHost: HostInfo = {
  hostname: 'beta',
  freshness: 'stale',
  recruitReady: false,
  instances: [{ pid: 5678, version: '1.7.0', hasWorkflowWorker: true, hasActivityWorker: false, hasHostQueueWorker: false }],
} as unknown as HostInfo;

describe('#742 gap 5 — mission-control /hosts', () => {
  it('hosts: GET /v1/hosts → formatHostList output (live only by default)', async () => {
    const { fetchFn, calls } = fakeFetch([liveHost, staleHost]);
    const ctrl = makeController(fetchFn);
    const r = await ctrl.hostsText(false);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.text).toContain('alpha');
      expect(r.text).toContain('recruit-ready');
      expect(r.text).not.toContain('beta'); // stale hidden without --all
    }
    expect(calls[0].method).toBe('GET');
    expect(calls[0].url).toContain('/v1/hosts');
    // NOT ensemble-scoped — the host registry route carries no ensemble segment.
    expect(calls[0].url).not.toContain('/v1/ensembles/');
  });

  it('hosts --all: includes stale hosts', async () => {
    const { fetchFn } = fakeFetch([liveHost, staleHost]);
    const ctrl = makeController(fetchFn);
    const r = await ctrl.hostsText(true);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.text).toContain('alpha');
      expect(r.text).toContain('beta');
      expect(r.text).toContain('(stale)');
    }
  });

  it('hosts: surfaces the daemon error on a non-2xx', async () => {
    const { fetchFn } = fakeFetch({ error: 'boom' }, 503);
    const ctrl = makeController(fetchFn);
    const r = await ctrl.hostsText(false);
    expect(r.ok).toBe(false);
  });
});

describe('#742 gap 9 — mission-control /status', () => {
  it('status: notifies the full board render (no fetch — board IS the snapshot)', () => {
    const { fetchFn } = fakeFetch({});
    const ctrl = makeController(fetchFn);
    const { ctx, notified } = fakeCtx();
    ctrl.cmdStatus(ctx);
    expect(notified).toHaveLength(1);
    expect(notified[0]).toContain('MISSION CONTROL'); // renderBoard header
  });
});

describe('#742 gap 8 — mission-control /go (release)', () => {
  it('release(player): POSTs the dedicated /release route with playerId', async () => {
    const { fetchFn, calls } = fakeFetch({ ok: true });
    const ctrl = makeController(fetchFn);
    const { ctx } = fakeCtx();
    await ctrl.cmdGo('bob', ctx);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toContain('/v1/ensembles/demo/release');
  });

  it('release(): no playerId → ensemble-wide release (empty body, still /release route)', async () => {
    const { fetchFn, calls } = fakeFetch({ ok: true });
    const actions = new MissionControlActions({ ensemble: 'demo', baseUrl: 'http://127.0.0.1:9999', adminToken: 't', fetchFn });
    const r = await actions.release();
    expect(r.ok).toBe(true);
    expect(calls[0].url).toContain('/release');
    // distinct from play — does NOT hit the /play route
    expect(calls[0].url).not.toContain('/play');
  });
});
