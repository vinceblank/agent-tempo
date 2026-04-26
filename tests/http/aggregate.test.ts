/**
 * Unit tests for the aggregate poll loop and its diff helpers.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  AggregateRunner,
  canonicalize,
  diffEnsembleSet,
  diffEnsembleSnapshot,
  diffHostProfiles,
  hashOf,
  type AggregateEnsembleSnapshot,
} from '../../src/http/aggregate';
import type { TempoClient } from '../../src/client/interface';
import type { HostInfo, MaestroPlayerInfo, HostProfile } from '../../src/types';

// ── Pure-function diff tests ────────────────────────────────────────────

describe('canonicalize', () => {
  it('produces identical output for objects with permuted keys', () => {
    expect(canonicalize({ a: 1, b: 2 })).toBe(canonicalize({ b: 2, a: 1 }));
    expect(canonicalize({ x: { a: 1, b: 2 } })).toBe(canonicalize({ x: { b: 2, a: 1 } }));
  });
  it('preserves array order', () => {
    expect(canonicalize([1, 2, 3])).toBe('[1,2,3]');
    expect(canonicalize([1, 2, 3])).not.toBe(canonicalize([3, 2, 1]));
  });
  it('handles primitives + null', () => {
    expect(canonicalize(null)).toBe('null');
    expect(canonicalize(42)).toBe('42');
    expect(canonicalize('s')).toBe('"s"');
  });
});

describe('hashOf', () => {
  it('returns 64 hex chars (SHA-256)', () => {
    const h = hashOf({ a: 1 });
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
  it('matches across permuted keys', () => {
    expect(hashOf({ a: 1, b: 2 })).toBe(hashOf({ b: 2, a: 1 }));
  });
});

describe('diffEnsembleSet', () => {
  it('emits ensemble.created for new names', () => {
    const { events, names } = diffEnsembleSet(
      new Set(['a']),
      [{ ensemble: 'a', hasConductor: false, flags: { paused: false, held: false }, players: [], schedules: [], chat: [] },
       { ensemble: 'b', hasConductor: true, flags: { paused: false, held: false }, players: [], schedules: [], chat: [] }],
      '2026-04-26T00:00:00.000Z',
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: 'ensemble.created',
      payload: { ensemble: 'b', createdAt: '2026-04-26T00:00:00.000Z', hasConductor: true },
    });
    expect(names.has('a')).toBe(true);
    expect(names.has('b')).toBe(true);
  });
  it('emits ensemble.destroyed for removed names', () => {
    const { events, names } = diffEnsembleSet(
      new Set(['a', 'b']),
      [{ ensemble: 'a', hasConductor: false, flags: { paused: false, held: false }, players: [], schedules: [], chat: [] }],
      '2026-04-26T00:00:00.000Z',
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: 'ensemble.destroyed',
      payload: { ensemble: 'b', destroyedAt: '2026-04-26T00:00:00.000Z' },
    });
    expect(names).toEqual(new Set(['a']));
  });
  it('emits both on simultaneous join/leave', () => {
    const { events } = diffEnsembleSet(
      new Set(['a']),
      [{ ensemble: 'b', hasConductor: false, flags: { paused: false, held: false }, players: [], schedules: [], chat: [] }],
      '2026-04-26T00:00:00.000Z',
    );
    const types = events.map((e) => e.type);
    expect(types).toContain('ensemble.created');
    expect(types).toContain('ensemble.destroyed');
  });
});

describe('diffHostProfiles', () => {
  const profileA: HostProfile = { hostname: 'hA', version: '1', defaultAgent: 'claude', platform: 'linux', capabilities: [] };
  const profileB: HostProfile = { hostname: 'hB', version: '1', defaultAgent: 'claude', platform: 'darwin', capabilities: [] };

  it('emits per-host on first sight', () => {
    const { events, hashes } = diffHostProfiles(new Map(), { hA: profileA, hB: profileB });
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.type === 'host_profile.changed')).toBe(true);
    expect(hashes.size).toBe(2);
  });
  it('skips unchanged profiles', () => {
    const initial = diffHostProfiles(new Map(), { hA: profileA });
    const second = diffHostProfiles(initial.hashes, { hA: profileA });
    expect(second.events).toHaveLength(0);
  });
  it('emits when capabilities flip', () => {
    const initial = diffHostProfiles(new Map(), { hA: profileA });
    const second = diffHostProfiles(initial.hashes, {
      hA: { ...profileA, capabilities: ['copilot'] },
    });
    expect(second.events).toHaveLength(1);
  });
});

describe('diffEnsembleSnapshot', () => {
  const baseTrack = () => ({
    playerPhases: new Map<string, string | undefined>(),
    flags: null as { paused: boolean; held: boolean } | null,
    schedulesHash: null as string | null,
    chatIds: new Set<string>(),
    chatIdOrder: [] as string[],
  });
  const at = '2026-04-26T00:00:00.000Z';

  it('emits player.added for new players, flags + schedules baseline on first poll', () => {
    const track = baseTrack();
    const next: AggregateEnsembleSnapshot = {
      ensemble: 'demo', hasConductor: true,
      flags: { paused: false, held: false },
      players: [
        { playerId: 'a', ensemble: 'demo', hostname: 'h', isConductor: false, agentType: 'claude', part: '', workDir: '', phase: 'attached' },
      ],
      schedules: [],
      chat: [],
    };
    const events = diffEnsembleSnapshot(null, next, track, at);
    const types = events.map((e) => e.type);
    expect(types).toContain('player.added');
    expect(types).toContain('flags.changed');
    expect(types).toContain('schedules.changed');
    expect(track.playerPhases.get('a')).toBe('attached');
    expect(track.flags).toEqual({ paused: false, held: false });
    expect(track.schedulesHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('emits player.phase_changed when phase shifts', () => {
    const track = baseTrack();
    track.playerPhases.set('a', 'attached');
    track.flags = { paused: false, held: false };
    track.schedulesHash = hashOf([]);
    const next: AggregateEnsembleSnapshot = {
      ensemble: 'demo', hasConductor: true,
      flags: { paused: false, held: false },
      players: [
        { playerId: 'a', ensemble: 'demo', hostname: 'h', isConductor: false, agentType: 'claude', part: '', workDir: '', phase: 'processing' },
      ],
      schedules: [],
      chat: [],
    };
    const prev = { ...next, players: [{ ...next.players[0], phase: 'attached' as const }] };
    const events = diffEnsembleSnapshot(prev, next, track, at);
    expect(events.find((e) => e.type === 'player.phase_changed')).toBeDefined();
    expect(track.playerPhases.get('a')).toBe('processing');
  });

  it('emits player.removed when a player drops', () => {
    const track = baseTrack();
    track.playerPhases.set('gone-one', 'attached');
    track.flags = { paused: false, held: false };
    track.schedulesHash = hashOf([]);
    const prev: AggregateEnsembleSnapshot = {
      ensemble: 'demo', hasConductor: false,
      flags: { paused: false, held: false },
      players: [
        { playerId: 'gone-one', ensemble: 'demo', hostname: 'h', isConductor: false, agentType: 'claude', part: '', workDir: '' },
      ],
      schedules: [], chat: [],
    };
    const next: AggregateEnsembleSnapshot = { ...prev, players: [] };
    const events = diffEnsembleSnapshot(prev, next, track, at);
    const removed = events.find((e) => e.type === 'player.removed');
    expect(removed).toBeDefined();
    expect((removed!.payload as { playerId: string }).playerId).toBe('gone-one');
    expect(track.playerPhases.has('gone-one')).toBe(false);
  });

  it('does NOT re-emit flags / schedules when unchanged across polls', () => {
    const track = baseTrack();
    track.flags = { paused: true, held: false };
    track.schedulesHash = hashOf([]);
    const next: AggregateEnsembleSnapshot = {
      ensemble: 'demo', hasConductor: false,
      flags: { paused: true, held: false },
      players: [], schedules: [], chat: [],
    };
    const events = diffEnsembleSnapshot(next, next, track, at);
    expect(events.map((e) => e.type)).not.toContain('flags.changed');
    expect(events.map((e) => e.type)).not.toContain('schedules.changed');
  });

  it('emits chat.appended only for new ids; remembers what we have seen', () => {
    const track = baseTrack();
    track.flags = { paused: false, held: false };
    track.schedulesHash = hashOf([]);
    const msg = (id: string) => ({
      id, from: 'a', to: 'b', text: id, timestamp: '', role: 'maestro-out' as const,
    });
    const first: AggregateEnsembleSnapshot = {
      ensemble: 'demo', hasConductor: false,
      flags: { paused: false, held: false },
      players: [], schedules: [], chat: [msg('1'), msg('2')],
    };
    const evs1 = diffEnsembleSnapshot(null, first, track, at);
    expect(evs1.filter((e) => e.type === 'chat.appended')).toHaveLength(2);
    // Second poll: re-sees both messages plus a new one.
    const second: AggregateEnsembleSnapshot = { ...first, chat: [msg('1'), msg('2'), msg('3')] };
    const evs2 = diffEnsembleSnapshot(first, second, track, at);
    const chatEvs = evs2.filter((e) => e.type === 'chat.appended');
    expect(chatEvs).toHaveLength(1);
    expect((chatEvs[0].payload as { id: string }).id).toBe('3');
  });
});

// ── Runner integration tests ────────────────────────────────────────────

const samplePlayer: MaestroPlayerInfo = {
  playerId: 'p1', ensemble: 'demo', part: 'work', hostname: 'h',
  workDir: '/r', isConductor: false, agentType: 'claude', phase: 'attached',
};
const sampleHost: HostInfo = {
  hostname: 'h', instances: [], recruitReady: true, freshness: 'live',
  profile: { hostname: 'h', version: '1', defaultAgent: 'claude', platform: 'linux', capabilities: [] },
  profileStaleness: 'fresh',
};

function fakeClient(over: Partial<TempoClient> = {}): TempoClient {
  const base: Partial<TempoClient> = {
    async listEnsembles() { return [{ name: 'demo', playerCount: 1, hasConductor: true, state: 'online' }]; },
    async getPlayers() { return [samplePlayer]; },
    async getEnsembleChat() { return { messages: [], total: 0, hasMore: false, hasConductor: true }; },
    async getSchedules() { return []; },
    async isMaestroPaused() { return false; },
    async isAnySessionHeld() { return false; },
    async listHosts() { return [sampleHost]; },
  };
  return new Proxy({ ...base, ...over }, {
    get(target: Record<string, unknown>, prop: string) {
      if (prop in target) return target[prop];
      return () => { throw new Error(`unstubbed TempoClient.${String(prop)}`); };
    },
  }) as unknown as TempoClient;
}

describe('AggregateRunner', () => {
  it('emits ensemble.created on first tick + player.added on the per-ensemble bus', async () => {
    const runner = new AggregateRunner({ client: fakeClient(), bootEpoch: 1714, pollIntervalMs: 60_000 });
    const globalSub = runner.globalBus().subscribe();

    // Tick once — the ensemble bus is created lazily during applyDiff.
    await runner.tick();
    const ensembleSub = runner.getEnsembleBus('demo')?.subscribe();
    expect(ensembleSub).toBeDefined();

    // Drain the global bus.
    const globalEvents: string[] = [];
    while (globalSub.pending.length > 0) globalEvents.push(globalSub.pending.shift()!.type);
    expect(globalEvents).toContain('ensemble.created');
    expect(globalEvents).toContain('host_profile.changed');

    // Per-ensemble events landed in the ring even though we subscribed after.
    const replayed = runner.getEnsembleBus('demo')!.replayFrom(-1);
    const types = replayed.map((e) => e.type);
    expect(types).toContain('player.added');
    expect(types).toContain('flags.changed');
    expect(types).toContain('schedules.changed');

    runner.close();
  });

  it('skip-with-warn when prior tick still in flight (§8 backpressure)', async () => {
    let release: () => void = () => {};
    const stall = new Promise<void>((res) => { release = res; });
    const client = fakeClient({
      async listEnsembles() {
        await stall;
        return [];
      },
    });
    const runner = new AggregateRunner({ client, bootEpoch: 1, pollIntervalMs: 60_000 });
    const t1 = runner.tick();      // first call — stalls inside listEnsembles
    // Second call while first still in flight — must skip without throwing.
    await runner.tick();
    expect(runner._skipCount).toBe(1);
    release();
    await t1;
    runner.close();
  });

  it('tears down per-ensemble buses when the ensemble disappears', async () => {
    let names = ['demo', 'other'];
    const client = fakeClient({
      async listEnsembles() {
        return names.map((n) => ({ name: n, playerCount: 0, hasConductor: false, state: 'online' as const }));
      },
      async getPlayers() { return []; },
    });
    const runner = new AggregateRunner({ client, bootEpoch: 1, pollIntervalMs: 60_000 });
    await runner.tick();
    expect(runner.getEnsembleBus('demo')).not.toBeNull();
    expect(runner.getEnsembleBus('other')).not.toBeNull();
    names = ['demo'];
    await runner.tick();
    expect(runner.getEnsembleBus('demo')).not.toBeNull();
    expect(runner.getEnsembleBus('other')).toBeNull();
    runner.close();
  });
});
