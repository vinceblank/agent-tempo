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
function fakeFetch(body: unknown, status = 200): { fetchFn: ActionFetch; calls: Array<{ url: string; method: string; body?: string }> } {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  const fetchFn: ActionFetch = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body });
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

describe('#742 — mission-control /attachment-info', () => {
  const info = {
    phase: 'processing',
    inFlightCount: 2,
    currentAttachment: {
      hostname: 'alpha',
      adapterId: 'ad-1',
      adapterClass: 'claude-code',
      attachmentId: 'att-9',
      expiresAt: '2026-07-01T00:00:00Z',
      lastHeartbeatAt: '2026-07-01T00:00:00Z',
    },
  };

  it('GET /attachment-info?playerId= → formatAttachmentInfoForDisplay output', async () => {
    const { fetchFn, calls } = fakeFetch(info);
    const ctrl = makeController(fetchFn);
    const r = await ctrl.attachmentInfoText('bob');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.text).toContain('bob — phase: processing');
      expect(r.text).toContain('in-flight: 2');
      expect(r.text).toContain('attached on: alpha');
    }
    expect(calls[0].method).toBe('GET');
    expect(calls[0].url).toContain('/v1/ensembles/demo/attachment-info?playerId=bob');
  });

  it('cmdAttachmentInfo with no arg → usage hint, no fetch', async () => {
    const { fetchFn, calls } = fakeFetch(info);
    const ctrl = makeController(fetchFn);
    const { ctx, notified } = fakeCtx();
    await ctrl.cmdAttachmentInfo('', ctx);
    expect(notified[0]).toContain('Usage: /attachment-info');
    expect(calls).toHaveLength(0);
  });

  it('surfaces the daemon error on a non-2xx', async () => {
    const { fetchFn } = fakeFetch({ error: 'session-not-found' }, 404);
    const ctrl = makeController(fetchFn);
    const r = await ctrl.attachmentInfoText('ghost');
    expect(r.ok).toBe(false);
  });
});

describe('#742 — mission-control /recall', () => {
  const timeline = {
    received: [{ from: 'alice', text: 'hello there', timestamp: '2026-07-01T00:00:00Z', delivered: true }],
    sent: [{ to: 'alice', text: 'hi back', timestamp: '2026-07-01T00:01:00Z' }],
  };

  it('POST /recall {full:true} → formatRecall output (received + sent)', async () => {
    const { fetchFn, calls } = fakeFetch(timeline);
    const ctrl = makeController(fetchFn);
    const r = await ctrl.recallText('alice');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.text).toContain('of 2 messages'); // 1 received + 1 sent
      expect(r.text).toContain('hello there');
      expect(r.text).toContain('hi back');
    }
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toContain('/v1/ensembles/demo/recall');
    expect(calls[0].body).toContain('"full":true');
  });

  it('cmdRecall with no arg → usage hint, no fetch', async () => {
    const { fetchFn, calls } = fakeFetch(timeline);
    const ctrl = makeController(fetchFn);
    const { ctx, notified } = fakeCtx();
    await ctrl.cmdRecall('', ctx);
    expect(notified[0]).toContain('Usage: /recall');
    expect(calls).toHaveLength(0);
  });

  it('surfaces the daemon error on a non-2xx', async () => {
    const { fetchFn } = fakeFetch({ error: 'session-not-found' }, 404);
    const ctrl = makeController(fetchFn);
    const r = await ctrl.recallText('ghost');
    expect(r.ok).toBe(false);
  });
});

describe('#742 — mission-control /schedule + /unschedule', () => {
  const schedules = [
    { name: 'nightly', target: 'tempo-eng', type: 'cron', cronExpression: '0 9 * * *', timezone: 'UTC', nextFireAt: '2026-07-01T09:00:00Z', firedCount: 3, message: 'stand up', createdBy: 'op' },
    { name: 'ping', target: 'tempo-qa', type: 'interval', interval: 300_000, nextFireAt: '2026-07-01T00:05:00Z', firedCount: 0, message: 'health check', createdBy: 'op' },
  ];

  it('GET /schedules → one rendered line per entry (MCP `schedules` shape)', async () => {
    const { fetchFn, calls } = fakeFetch(schedules);
    const ctrl = makeController(fetchFn);
    const r = await ctrl.schedulesText();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.text).toContain('nightly → tempo-eng');
      expect(r.text).toContain('cron: 0 9 * * *');
      expect(r.text).toContain('ping → tempo-qa');
      expect(r.text).toContain('every 5m');
    }
    expect(calls[0].method).toBe('GET');
    expect(calls[0].url).toContain('/v1/ensembles/demo/schedules');
  });

  it('schedulesText: empty list → "No active schedules."', async () => {
    const { fetchFn } = fakeFetch([]);
    const ctrl = makeController(fetchFn);
    const r = await ctrl.schedulesText();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toBe('No active schedules.');
  });

  it('cmdSchedule delete <name> → POST /unschedule', async () => {
    const { fetchFn, calls } = fakeFetch({ ok: true });
    const ctrl = makeController(fetchFn);
    const { ctx } = fakeCtx();
    await ctrl.cmdSchedule('delete nightly', ctx);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toContain('/v1/ensembles/demo/unschedule');
    expect(calls[0].body).toContain('"name":"nightly"');
  });

  it('cmdUnschedule <name> → POST /unschedule', async () => {
    const { fetchFn, calls } = fakeFetch({ ok: true });
    const ctrl = makeController(fetchFn);
    const { ctx } = fakeCtx();
    await ctrl.cmdUnschedule('ping', ctx);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toContain('/v1/ensembles/demo/unschedule');
    expect(calls[0].body).toContain('"name":"ping"');
  });

  it('cmdSchedule create → points at the MCP tool / CLI, no fetch (no thin-shim create)', async () => {
    const { fetchFn, calls } = fakeFetch({ ok: true });
    const ctrl = makeController(fetchFn);
    const { ctx, notified } = fakeCtx();
    await ctrl.cmdSchedule('create', ctx);
    expect(notified[0]).toContain('MCP `schedule` tool');
    expect(calls).toHaveLength(0);
  });
});
