/**
 * #791 — e2e smoke: the command-center board boots and is fully usable on an
 * UNAUTHENTICATED loopback daemon (no read token, no admin token, no API key).
 *
 * The architect's beta.2 verification was that the board is pure-SSE, works
 * tokenless on a loopback daemon, and operator controls POST without auth. This
 * locks that contract at the daemon ↔ board seam — the honest end-to-end layer
 * below Pi, which can't boot a TUI in CI:
 *
 *   1. Board RENDER source — the board's snapshot reads (`/v1/health`,
 *      `/v1/state/:e`, `/v1/ensembles`) succeed with NO Authorization header.
 *   2. Operator CONTROLS — a `MissionControlActions` client built with NO admin
 *      token drives pause/play against the live loopback server; both pass the
 *      auth tier guard (202) and reach the underlying client, proving the
 *      "No auth" tier from #791.
 *
 * The LLM PLANNER tier (ask / handoff / recruit) is intentionally NOT exercised
 * here — it needs a Claude subscription (`/login`) or an API key by design. Its
 * graceful degradation + the `/login` pointer live in the launch banner, covered
 * by tests/cli/command-center-access-tiers.test.ts.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { startHttpServer, type HttpServerHandle } from '../../src/http/server';
import { MissionControlActions, ADMIN_TOKEN_ENV } from '../../src/pi/mission-control/actions';
import type { TempoClient } from '../../src/client/interface';
import type { MaestroPlayerInfo, HostInfo } from '../../src/types';

const samplePlayer: MaestroPlayerInfo = {
  playerId: 'tempo-eng',
  ensemble: 'demo',
  part: 'fixing things',
  hostname: 'eng-host',
  workDir: '/repo',
  isConductor: false,
  agentType: 'claude',
  phase: 'attached',
};

const sampleHost: HostInfo = {
  hostname: 'eng-host',
  instances: [{
    pid: 1, version: '0.27.0', identity: 'agent-tempo:eng-host:1:0.27.0',
    lastAccessTime: '2026-04-26T12:00:00.000Z',
    hasWorkflowWorker: true, hasActivityWorker: true, hasHostQueueWorker: true,
  }],
  recruitReady: true,
  freshness: 'live',
  profile: {
    hostname: 'eng-host', version: '0.27.0', defaultAgent: 'claude',
    platform: 'linux', capabilities: [],
  },
  profileStaleness: 'fresh',
};

/** Records operator-write calls so the smoke can assert the action reached the client. */
interface WriteCalls { pause: string[]; play: Array<{ ensemble: string; release?: boolean }>; }

function makeFakeClient(calls: WriteCalls): TempoClient {
  const base: Partial<TempoClient> = {
    // ── snapshot / read surface (board render source) ──
    async listEnsembles() {
      return [{ name: 'demo', playerCount: 1, hasConductor: true, state: 'online' }];
    },
    async getPlayers() { return [samplePlayer]; },
    async getEnsembleChat() {
      return { messages: [], total: 0, hasMore: false, hasConductor: true };
    },
    async getSchedules() { return []; },
    async isMaestroPaused() { return false; },
    async isAnySessionHeld() { return false; },
    async listHosts() { return [sampleHost]; },
    async getEnsembleMeta() {
      return { description: '', startedAt: '', currentBpm: 0, tempoSeries: [] };
    },
    async getPlayerWireMeta() { return null; },
    // ── operator write surface ──
    async pause(ensemble: string) { calls.pause.push(ensemble); },
    async play(ensemble: string, opts?: { release?: boolean }) {
      calls.play.push({ ensemble, release: opts?.release });
    },
  };
  return new Proxy(base as Record<string, unknown>, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      return () => { throw new Error(`unstubbed TempoClient.${String(prop)}`); };
    },
  }) as unknown as TempoClient;
}

interface Booted { handle: HttpServerHandle; url: string; portFile: string; }

let tmpDir: string;
let savedAdminToken: string | undefined;
beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-cc-unauth-'));
  // Force the genuinely-unauthenticated path: no admin token anywhere, so the
  // MissionControlActions client sends NO Authorization header.
  savedAdminToken = process.env[ADMIN_TOKEN_ENV];
  delete process.env[ADMIN_TOKEN_ENV];
});
afterAll(() => {
  if (savedAdminToken !== undefined) process.env[ADMIN_TOKEN_ENV] = savedAdminToken;
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

let booted: Booted[] = [];
afterEach(async () => {
  for (const b of booted) { try { await b.handle.close(); } catch { /* ignore */ } }
  booted = [];
});

async function boot(calls: WriteCalls): Promise<Booted> {
  const portFile = path.join(tmpDir, `daemon-${process.hrtime.bigint().toString(36)}.port`);
  const handle = await startHttpServer({
    client: makeFakeClient(calls),
    namespace: 'default',
    taskQueue: 'agent-tempo-test',
    version: '0.27.0-test',
    bindAddr: '127.0.0.1', // loopback → full trust, no bearer required
    port: 0,               // ephemeral
    // NB: NO readToken, NO adminToken — the unauthenticated daemon posture.
    portFilePath: portFile,
  });
  const b: Booted = { handle, url: `http://${handle.bindAddr}:${handle.port}`, portFile };
  booted.push(b);
  return b;
}

const noCalls = (): WriteCalls => ({ pause: [], play: [] });

describe('#791 command-center — unauthenticated board boots end-to-end', () => {
  it('board RENDER reads succeed with NO Authorization header', async () => {
    const b = await boot(noCalls());

    const health = await fetch(`${b.url}/v1/health`);
    expect(health.status).toBe(200);

    const ensembles = await fetch(`${b.url}/v1/ensembles`);
    expect(ensembles.status).toBe(200);

    // The board's initial render snapshot.
    const state = await fetch(`${b.url}/v1/state/demo`);
    expect(state.status).toBe(200);
    const body = await state.json() as { ensemble: string; players: unknown[] };
    expect(body.ensemble).toBe('demo');
    expect(body.players).toHaveLength(1);
  });

  it('operator CONTROLS POST tokenlessly (pause/play → 202, reach the client)', async () => {
    const calls = noCalls();
    const b = await boot(calls);

    // The board's real write client — built with NO admin token.
    const actions = new MissionControlActions({ ensemble: 'demo', baseUrl: b.url });
    expect(actions.ready).toBe(true);

    const paused = await actions.pause();
    expect(paused.ok, paused.ok ? '' : (paused as { error: string }).error).toBe(true);
    expect((paused as { status: number }).status).toBe(202);

    const played = await actions.play();
    expect(played.ok).toBe(true);
    expect((played as { status: number }).status).toBe(202);

    // Proof the tokenless writes actually reached the daemon's client layer
    // (passed the auth tier guard), not just returned a no-op success.
    expect(calls.pause).toEqual(['demo']);
    expect(calls.play).toEqual([{ ensemble: 'demo', release: undefined }]);
  });

  it('the read surface works through MissionControlActions without a token', async () => {
    const b = await boot(noCalls());
    const actions = new MissionControlActions({ ensemble: 'demo', baseUrl: b.url });

    const res = await actions.listEnsembles();
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.ensembles.map((e) => e.name)).toContain('demo');
    }
  });
});
