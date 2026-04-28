/**
 * Fixture: a normal stream interrupted by a `gap` event mid-stream.
 * Exercises the dashboard's reconnect / re-fetch flow — when a `gap`
 * arrives, consumers SHOULD drop their cache and re-pull
 * `/v1/state/:ensemble` (per SSE-PROTOCOL.md §7.2).
 */
import type { FixtureScenario } from './index';
import { FIXTURE_BOOT_EPOCH } from './constants';

const ENSEMBLE = 'demo-reconnect';

export const sseReconnect: FixtureScenario = {
  name: 'sse-reconnect',
  description: 'Two chat events, then a gap (overflow), then more chat. Tests the dashboard reconnect / re-fetch path.',
  snapshot: {
    v: 1,
    ensemble: ENSEMBLE,
    capturedAt: '2026-04-27T00:00:00.000Z',
    lastEventId: `${FIXTURE_BOOT_EPOCH}:0`,
    state: 'online',
    hasConductor: true,
    flags: { paused: false, held: false },
    players: [{
      playerId: 'conductor',
      ensemble: ENSEMBLE,
      hostname: 'demo-host',
      isConductor: true,
      agentType: 'claude',
      phase: 'attached',
      part: 'Reconnect demo',
      workDir: '/repo/demo',
    }],
    schedules: [],
    chat: { messages: [], total: 0, hasMore: false },
    hostProfiles: {},
    description: '',
    startedAt: '',
    currentBpm: 0,
    tempoSeries: [],
  },
  events: [
    {
      v: 1,
      type: 'chat.appended',
      eventId: `${FIXTURE_BOOT_EPOCH}:1`,
      payload: {
        id: 'msg-1', from: 'maestro', to: 'conductor',
        text: 'Hello before the gap.',
        timestamp: '2026-04-27T00:00:01.000Z',
        role: 'maestro-out',
      },
    },
    {
      v: 1,
      type: 'chat.appended',
      eventId: `${FIXTURE_BOOT_EPOCH}:2`,
      payload: {
        id: 'msg-2', from: 'conductor', to: 'maestro',
        text: 'About to drop a gap...',
        timestamp: '2026-04-27T00:00:02.000Z',
        role: 'conductor-in',
      },
    },
    {
      v: 1,
      type: 'gap',
      eventId: `${FIXTURE_BOOT_EPOCH}:3`,
      payload: { from: `${FIXTURE_BOOT_EPOCH}:2`, to: `${FIXTURE_BOOT_EPOCH}:50`, reason: 'overflow' },
    },
    {
      v: 1,
      type: 'chat.appended',
      eventId: `${FIXTURE_BOOT_EPOCH}:51`,
      payload: {
        id: 'msg-51', from: 'maestro', to: 'conductor',
        text: 'After the gap — dashboard should have re-fetched.',
        timestamp: '2026-04-27T00:00:05.000Z',
        role: 'maestro-out',
      },
    },
  ],
  eventCadenceMs: 250,
};
