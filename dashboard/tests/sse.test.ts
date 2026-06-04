/**
 * SSE projection tests — architect's risk #3 (PR-4).
 *
 * Walks every entry in `SSE_EVENT_KINDS` and verifies that the
 * dashboard's `applyEvent` reducer projects the event into the cached
 * snapshot correctly. Comprehensive coverage is mandatory — if a kind
 * is mishandled the dashboard can repeat #358-class bugs (a conductor
 * removed but `hasConductor` left stuck on `true`, etc.).
 */
import { describe, it, expect } from 'vitest';
import { SSE_EVENT_KINDS } from 'agent-tempo/http/event-types';
import type {
  TempoEvent,
  EnsembleStateV1,
  PlayerSummaryV1,
} from 'agent-tempo/http/event-types';
import type { EnsembleChatMessage, HostProfile } from 'agent-tempo/types';
import { applyEvent } from '../src/lib/sse';
import { makeSnapshot } from './fixtures/mock-client';

const epoch = '1735000000000';
const id = (seq: number) => `${epoch}:${seq}`;

const conductor: PlayerSummaryV1 = {
  playerId: 'maestro',
  ensemble: 'demo',
  hostname: 'host-a',
  isConductor: true,
  agentType: 'claude',
  phase: 'attached',
  part: 'conducting',
  workDir: '/repo',
};

const soloist: PlayerSummaryV1 = {
  playerId: 'soloist-1',
  ensemble: 'demo',
  hostname: 'host-a',
  isConductor: false,
  agentType: 'claude',
  phase: 'attached',
  part: 'soloing',
  workDir: '/repo',
};

const baseSnapshot: EnsembleStateV1 = makeSnapshot({
  ensemble: 'demo',
  hasConductor: true,
  players: [conductor, soloist],
});

describe('applyEvent — coverage of SSE_EVENT_KINDS', () => {
  it('every wire kind is exercised by this test file', () => {
    // Defence against drift: if a new kind is added to SSE_EVENT_KINDS,
    // the developer must add a test for it (or remove from KIND_COVERAGE
    // with a written rationale).
    const KIND_COVERAGE: Record<typeof SSE_EVENT_KINDS[number], boolean> = {
      snapshot: true,
      gap: true,
      throttled: true,
      heartbeat: true,
      'ensemble.created': true,
      'ensemble.destroyed': true,
      'player.added': true,
      'player.removed': true,
      'player.phase_changed': true,
      'chat.appended': true,
      'chat.compressed': true,
      'flags.changed': true,
      'schedules.changed': true,
      'host_profile.changed': true,
      'player.activity': true,
    };
    for (const kind of SSE_EVENT_KINDS) {
      expect(KIND_COVERAGE[kind]).toBe(true);
    }
  });
});

describe('applyEvent — player.activity (3c Tier-1, coarse — dashboard ignores for now)', () => {
  it('returns the same reference (graceful-ignore until Phase-5 dashboard rendering)', () => {
    const ev: TempoEvent = {
      v: 1, type: 'player.activity', eventId: id(7),
      payload: {
        playerId: 'soloist', ensemble: 'demo', currentTool: 'bash',
        contextTokens: 1200, contextPercent: 3, at: '2026-04-27T00:00:00.000Z',
      },
    };
    expect(applyEvent(baseSnapshot, ev)).toBe(baseSnapshot);
  });
});

describe('applyEvent — snapshot prelude', () => {
  it('replaces the cache wholesale', () => {
    const fresh = makeSnapshot({ ensemble: 'other', players: [conductor] });
    const ev: TempoEvent = { v: 1, type: 'snapshot', eventId: id(0), payload: fresh };
    expect(applyEvent(undefined, ev)).toBe(fresh);
    expect(applyEvent(baseSnapshot, ev)).toBe(fresh);
  });
});

describe('applyEvent — connection-health events', () => {
  it('heartbeat and throttled return the same reference', () => {
    const heartbeat: TempoEvent = {
      v: 1, type: 'heartbeat', eventId: id(1),
      payload: { at: '2026-04-27T00:00:00.000Z' },
    };
    expect(applyEvent(baseSnapshot, heartbeat)).toBe(baseSnapshot);

    const throttled: TempoEvent = {
      v: 1, type: 'throttled', eventId: id(2),
      payload: { droppedSince: '2026-04-27T00:00:00.000Z', count: 3 },
    };
    expect(applyEvent(baseSnapshot, throttled)).toBe(baseSnapshot);
  });

  it('gap returns prev (consumer triggers re-fetch separately)', () => {
    const ev: TempoEvent = {
      v: 1, type: 'gap', eventId: id(3),
      payload: { from: id(0), to: id(50), reason: 'overflow' },
    };
    expect(applyEvent(baseSnapshot, ev)).toBe(baseSnapshot);
  });
});

describe('applyEvent — ensemble lifecycle', () => {
  it('ensemble.created is a no-op in per-ensemble cache', () => {
    const ev: TempoEvent = {
      v: 1, type: 'ensemble.created', eventId: id(4),
      payload: { ensemble: 'demo', createdAt: '2026-04-27T00:00:00.000Z', hasConductor: true },
    };
    expect(applyEvent(baseSnapshot, ev)).toBe(baseSnapshot);
  });

  it('ensemble.destroyed flips state offline + zeros players', () => {
    const ev: TempoEvent = {
      v: 1, type: 'ensemble.destroyed', eventId: id(5),
      payload: { ensemble: 'demo', destroyedAt: '2026-04-27T00:00:00.000Z' },
    };
    const next = applyEvent(baseSnapshot, ev);
    expect(next?.state).toBe('offline');
    expect(next?.hasConductor).toBe(false);
    expect(next?.players).toHaveLength(0);
  });
});

describe('applyEvent — players (#358 risk surface)', () => {
  it('player.added appends and updates hasConductor when conductor joins', () => {
    const empty = makeSnapshot({ players: [], hasConductor: false });
    const ev: TempoEvent = { v: 1, type: 'player.added', eventId: id(6), payload: conductor };
    const next = applyEvent(empty, ev);
    expect(next?.players).toHaveLength(1);
    expect(next?.hasConductor).toBe(true);
  });

  it('player.added de-dupes by playerId on replay', () => {
    const ev: TempoEvent = { v: 1, type: 'player.added', eventId: id(7), payload: soloist };
    const next = applyEvent(baseSnapshot, ev);
    expect(next?.players).toHaveLength(2); // unchanged — soloist already present
  });

  it('player.removed flips hasConductor false when the conductor leaves', () => {
    const ev: TempoEvent = {
      v: 1, type: 'player.removed', eventId: id(8),
      payload: {
        playerId: 'maestro', ensemble: 'demo',
        removedAt: '2026-04-27T00:00:00.000Z', reason: 'gone',
      },
    };
    const next = applyEvent(baseSnapshot, ev);
    expect(next?.players.find((p) => p.playerId === 'maestro')).toBeUndefined();
    expect(next?.hasConductor).toBe(false); // The #358 analog assertion.
  });

  it('player.removed preserves hasConductor=true when a soloist leaves but conductor stays', () => {
    const ev: TempoEvent = {
      v: 1, type: 'player.removed', eventId: id(9),
      payload: {
        playerId: 'soloist-1', ensemble: 'demo',
        removedAt: '2026-04-27T00:00:00.000Z', reason: 'destroyed',
      },
    };
    const next = applyEvent(baseSnapshot, ev);
    expect(next?.hasConductor).toBe(true);
    expect(next?.players).toHaveLength(1);
  });

  it('player.phase_changed updates phase + heartbeat without re-ordering players', () => {
    const ev: TempoEvent = {
      v: 1, type: 'player.phase_changed', eventId: id(10),
      payload: {
        playerId: 'soloist-1', ensemble: 'demo',
        phase: 'processing',
        processingSince: '2026-04-27T00:00:01.000Z',
        at: '2026-04-27T00:00:01.000Z',
      },
    };
    const next = applyEvent(baseSnapshot, ev);
    expect(next?.players[1].phase).toBe('processing');
    expect(next?.players[1].processingSince).toBe('2026-04-27T00:00:01.000Z');
    expect(next?.players[0].playerId).toBe('maestro'); // order preserved
  });
});

describe('applyEvent — chat', () => {
  const msg: EnsembleChatMessage = {
    id: 'msg-1', from: 'maestro', to: 'soloist-1',
    text: 'hi', timestamp: '2026-04-27T00:00:00.000Z',
    role: 'maestro-out',
  };

  it('chat.appended pushes onto the list and bumps total', () => {
    const ev: TempoEvent = { v: 1, type: 'chat.appended', eventId: id(11), payload: msg };
    const next = applyEvent(baseSnapshot, ev);
    expect(next?.chat.messages).toHaveLength(1);
    expect(next?.chat.total).toBe(1);
  });

  it('chat.compressed drops local window and surfaces hasMore', () => {
    const seeded = makeSnapshot({
      chat: { messages: [msg], total: 60, hasMore: false },
    });
    const ev: TempoEvent = {
      v: 1, type: 'chat.compressed', eventId: id(12),
      payload: { dropped: 50, since: '2026-04-27T00:00:00.000Z' },
    };
    const next = applyEvent(seeded, ev);
    expect(next?.chat.messages).toHaveLength(0);
    expect(next?.chat.total).toBe(10);
    expect(next?.chat.hasMore).toBe(true);
  });
});

describe('applyEvent — flags + schedules + host profile', () => {
  it('flags.changed mirrors paused/held into the snapshot', () => {
    const ev: TempoEvent = {
      v: 1, type: 'flags.changed', eventId: id(13),
      payload: { ensemble: 'demo', paused: true, held: false, at: '2026-04-27T00:00:00.000Z' },
    };
    const next = applyEvent(baseSnapshot, ev);
    expect(next?.flags.paused).toBe(true);
    expect(next?.state).toBe('paused');
  });

  it('schedules.changed swaps the schedules array', () => {
    const ev: TempoEvent = {
      v: 1, type: 'schedules.changed', eventId: id(14),
      payload: {
        ensemble: 'demo',
        schedules: [{
          name: 's', target: 'maestro', message: 'tick', createdBy: 'maestro',
          nextFireAt: '2026-04-27T00:00:01.000Z',
          firedCount: 0, type: 'once',
        }],
        at: '2026-04-27T00:00:00.000Z',
      },
    };
    const next = applyEvent(baseSnapshot, ev);
    expect(next?.schedules).toHaveLength(1);
    expect(next?.schedules[0].name).toBe('s');
  });

  it('host_profile.changed merges into hostProfiles map', () => {
    const profile: HostProfile = {
      hostname: 'host-b', version: '0.28.0',
      defaultAgent: 'claude', platform: 'linux', capabilities: [],
    };
    const ev: TempoEvent = {
      v: 1, type: 'host_profile.changed', eventId: id(15), payload: profile,
    };
    const next = applyEvent(baseSnapshot, ev);
    expect(next?.hostProfiles['host-b']).toEqual(profile);
  });
});

describe('applyEvent — no baseline edge case', () => {
  it('returns prev when there is no baseline yet (events before snapshot)', () => {
    const ev: TempoEvent = {
      v: 1, type: 'chat.appended', eventId: id(16),
      payload: {
        id: 'msg', from: 'maestro', to: 'soloist-1', text: 'x',
        timestamp: '2026-04-27T00:00:00.000Z', role: 'maestro-out',
      },
    };
    expect(applyEvent(undefined, ev)).toBeUndefined();
  });
});
