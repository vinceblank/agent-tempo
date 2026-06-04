/**
 * Unit tests for `buildEnsembleSnapshot` — the projection layer behind
 * `/v1/state/:ensemble`. Mocks `TempoClient` so we never touch Temporal.
 */
import { describe, it, expect } from 'vitest';
import {
  buildEnsembleSnapshot,
  EnsembleNotFoundError,
  toPlayerSummaryV1,
} from '../../src/http/snapshot';
import { PR1_SENTINEL_EVENT_ID } from '../../src/http/event-types';
import type { TempoClient } from '../../src/client/interface';
import type { MaestroPlayerInfo, HostInfo } from '../../src/types';

/**
 * Build a partial TempoClient stub. Methods not provided throw with a
 * helpful message when reached — the snapshot builder shouldn't touch
 * anything outside the snapshot surface in PR-1.
 *
 * Plain object + Proxy fallback avoids `Object.assign` introspecting the
 * proxy and tripping the throw on its own keys traversal.
 */
/**
 * Issue #399 DB1a default stubs — `getEnsembleMeta` and `getPlayerWireMeta`
 * are called unconditionally by `buildEnsembleSnapshot` for every
 * snapshot. Default them to sentinel-result shapes so tests not exercising
 * W1/W2 projection don't have to stub them. Tests that DO exercise
 * those paths override via `over`.
 */
const DB1A_DEFAULTS: Partial<TempoClient> = {
  async getEnsembleMeta() {
    return { description: '', startedAt: '', currentBpm: 0, tempoSeries: [] };
  },
  async getPlayerWireMeta() { return null; },
};

function stubClient(over: Partial<TempoClient>): TempoClient {
  const merged = { ...DB1A_DEFAULTS, ...over } as Record<string, unknown>;
  return new Proxy(merged, {
    get(target, prop: string | symbol) {
      if (prop in target) return target[prop as string];
      return () => {
        throw new Error(`unstubbed TempoClient.${String(prop)}`);
      };
    },
  }) as unknown as TempoClient;
}

const sampleHost: HostInfo = {
  hostname: 'eng-host',
  instances: [{
    pid: 1,
    version: '0.27.0',
    identity: 'agent-tempo:eng-host:1:0.27.0',
    lastAccessTime: '2026-04-26T12:00:00.000Z',
    hasWorkflowWorker: true,
    hasActivityWorker: true,
    hasHostQueueWorker: true,
  }],
  recruitReady: true,
  freshness: 'live',
  profile: {
    hostname: 'eng-host',
    version: '0.27.0',
    defaultAgent: 'claude',
    platform: 'darwin',
    capabilities: [],
  },
  profileStaleness: 'fresh',
};

const samplePlayer: MaestroPlayerInfo = {
  playerId: 'tempo-eng',
  ensemble: 'demo',
  part: 'fixing tests',
  hostname: 'eng-host',
  workDir: '/repo',
  isConductor: false,
  agentType: 'claude',
  playerType: 'tempo-soloist',
  phase: 'attached',
};

describe('toPlayerSummaryV1', () => {
  it('projects MaestroPlayerInfo onto the wire-stable shape', () => {
    expect(toPlayerSummaryV1(samplePlayer)).toEqual({
      playerId: 'tempo-eng',
      ensemble: 'demo',
      hostname: 'eng-host',
      isConductor: false,
      agentType: 'claude',
      playerType: 'tempo-soloist',
      phase: 'attached',
      part: 'fixing tests',
      workDir: '/repo',
    });
  });
  it('coerces unknown agentType strings to "claude"', () => {
    const out = toPlayerSummaryV1({ ...samplePlayer, agentType: 'something-else' });
    expect(out.agentType).toBe('claude');
  });
  it('preserves "copilot" agentType', () => {
    const out = toPlayerSummaryV1({ ...samplePlayer, agentType: 'copilot' });
    expect(out.agentType).toBe('copilot');
  });
  it('omits optional fields when absent', () => {
    const minimal: MaestroPlayerInfo = {
      playerId: 'p1',
      ensemble: 'e1',
      part: '',
      hostname: 'h',
      workDir: '',
      isConductor: false,
      agentType: 'claude',
    };
    const out = toPlayerSummaryV1(minimal);
    expect(out).not.toHaveProperty('phase');
    expect(out).not.toHaveProperty('playerType');
    expect(out).not.toHaveProperty('gitBranch');
  });

  // ── 3c Tier-1 — coarse activity merge from getPlayerWireMeta ──
  it('merges coarse activity (currentTool + context) from wireMeta', () => {
    const out = toPlayerSummaryV1(samplePlayer, {
      coarse: { currentTool: 'bash', contextTokens: 1200, contextPercent: 3 },
    });
    expect(out.currentTool).toBe('bash');
    expect(out.contextTokens).toBe(1200);
    expect(out.contextPercent).toBe(3);
  });
  it('projects idle currentTool=null, omitting absent context fields', () => {
    const out = toPlayerSummaryV1(samplePlayer, { coarse: { currentTool: null } });
    expect(out.currentTool).toBeNull();
    expect(out).not.toHaveProperty('contextTokens');
    expect(out).not.toHaveProperty('contextPercent');
  });
  it('omits coarse fields entirely when wireMeta has no coarse block', () => {
    const out = toPlayerSummaryV1(samplePlayer, { lease: { expiresAt: null, leaseMs: null } });
    expect(out).not.toHaveProperty('currentTool');
    expect(out).not.toHaveProperty('contextTokens');
  });
});

describe('buildEnsembleSnapshot', () => {
  it('throws EnsembleNotFoundError when listEnsembles has no match', async () => {
    const client = stubClient({
      async listEnsembles() { return [{ name: 'other', playerCount: 1, hasConductor: true, state: 'online' }]; },
    });
    await expect(buildEnsembleSnapshot(client, 'demo')).rejects.toBeInstanceOf(EnsembleNotFoundError);
  });

  it('assembles a full snapshot with PR-1 sentinel lastEventId', async () => {
    const client = stubClient({
      async listEnsembles() {
        return [{ name: 'demo', playerCount: 1, hasConductor: true, state: 'online' }];
      },
      async getPlayers() { return [samplePlayer]; },
      async getEnsembleChat() {
        return {
          messages: [{ id: 'm1', from: 'a', to: 'b', text: 'hi', timestamp: 't', role: 'maestro-out' as const }],
          total: 1,
          hasMore: false,
          hasConductor: true,
        };
      },
      async getSchedules() { return []; },
      async isMaestroPaused() { return false; },
      async isAnySessionHeld() { return false; },
      async listHosts() { return [sampleHost]; },
    });
    const fixedNow = new Date('2026-04-26T12:34:56.000Z');
    const snap = await buildEnsembleSnapshot(client, 'demo', { now: () => fixedNow });
    expect(snap.v).toBe(1);
    expect(snap.ensemble).toBe('demo');
    expect(snap.capturedAt).toBe('2026-04-26T12:34:56.000Z');
    expect(snap.lastEventId).toBe(PR1_SENTINEL_EVENT_ID);
    expect(snap.lastEventId).toBe('0:0');
    expect(snap.state).toBe('online');
    expect(snap.hasConductor).toBe(true);
    expect(snap.flags).toEqual({ paused: false, held: false });
    expect(snap.players).toHaveLength(1);
    expect(snap.players[0].playerId).toBe('tempo-eng');
    expect(snap.chat.messages).toHaveLength(1);
    expect(snap.chat.total).toBe(1);
    expect(snap.chat.hasMore).toBe(false);
    // chat slice does NOT carry hasConductor on the wire (top-level field is authoritative)
    expect(snap.chat).not.toHaveProperty('hasConductor');
    expect(snap.schedules).toEqual([]);
    expect(snap.hostProfiles).toHaveProperty('eng-host');
    expect(snap.hostProfiles['eng-host'].defaultAgent).toBe('claude');
  });

  it('soft-fails individual queries — never 500s the whole snapshot', async () => {
    const client = stubClient({
      async listEnsembles() {
        return [{ name: 'demo', playerCount: 0, hasConductor: false, state: 'online' as const }];
      },
      async getPlayers() { throw new Error('Temporal hiccup'); },
      async getEnsembleChat() { throw new Error('hub down'); },
      async getSchedules() { throw new Error('scheduler unreachable'); },
      async isMaestroPaused() { throw new Error('hub down'); },
      async isAnySessionHeld() { throw new Error('scan failed'); },
      async listHosts() { throw new Error('describe-task-queue rate-limited'); },
    });
    const snap = await buildEnsembleSnapshot(client, 'demo');
    expect(snap.players).toEqual([]);
    expect(snap.chat).toEqual({ messages: [], total: 0, hasMore: false });
    expect(snap.schedules).toEqual([]);
    expect(snap.flags).toEqual({ paused: false, held: false });
    expect(snap.hostProfiles).toEqual({});
  });

  it('reflects paused/held flag combinations', async () => {
    const client = stubClient({
      async listEnsembles() {
        return [{ name: 'demo', playerCount: 1, hasConductor: false, state: 'paused' as const }];
      },
      async getPlayers() { return [samplePlayer]; },
      async getEnsembleChat() { return { messages: [], total: 0, hasMore: false, hasConductor: false }; },
      async getSchedules() { return []; },
      async isMaestroPaused() { return true; },
      async isAnySessionHeld() { return true; },
      async listHosts() { return []; },
    });
    const snap = await buildEnsembleSnapshot(client, 'demo');
    expect(snap.state).toBe('paused');
    expect(snap.flags).toEqual({ paused: true, held: true });
  });

  it('omits hosts without a profile from hostProfiles', async () => {
    const profileless: HostInfo = { ...sampleHost, profile: undefined, profileStaleness: 'missing' };
    const client = stubClient({
      async listEnsembles() {
        return [{ name: 'demo', playerCount: 0, hasConductor: false, state: 'online' as const }];
      },
      async getPlayers() { return []; },
      async getEnsembleChat() { return { messages: [], total: 0, hasMore: false, hasConductor: false }; },
      async getSchedules() { return []; },
      async isMaestroPaused() { return false; },
      async isAnySessionHeld() { return false; },
      async listHosts() { return [profileless]; },
    });
    const snap = await buildEnsembleSnapshot(client, 'demo');
    expect(snap.hostProfiles).toEqual({});
  });
});
