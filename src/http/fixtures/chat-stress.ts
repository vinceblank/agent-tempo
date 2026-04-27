/**
 * Fixture: 100 `chat.appended` events in rapid succession followed by
 * a `chat.compressed` event. Exercises the dashboard's chat-window
 * virtualisation / scroll behaviour and the "older messages dropped"
 * banner the maestro hub emits when its in-memory ring overflows.
 */
import type { FixtureScenario } from './index';
import type { TempoEvent } from '../event-types';
import { FIXTURE_BOOT_EPOCH } from './constants';

const ENSEMBLE = 'demo-chat-stress';
const STRESS_COUNT = 100;
const COMPRESS_DROP = 50;
const BASE_MS = Number(FIXTURE_BOOT_EPOCH);

const stressEvents: TempoEvent[] = Array.from({ length: STRESS_COUNT }, (_, i) => ({
  v: 1,
  type: 'chat.appended',
  eventId: `${FIXTURE_BOOT_EPOCH}:${i + 1}`,
  payload: {
    id: `msg-stress-${i + 1}`,
    from: i % 2 === 0 ? 'maestro' : 'conductor',
    to: i % 2 === 0 ? 'conductor' : 'maestro',
    text: `Stress message ${i + 1}/${STRESS_COUNT}`,
    timestamp: new Date(BASE_MS + i * 10).toISOString(),
    role: i % 2 === 0 ? 'maestro-out' : 'conductor-in',
  },
}));

const compressedEvent: TempoEvent = {
  v: 1,
  type: 'chat.compressed',
  eventId: `${FIXTURE_BOOT_EPOCH}:${STRESS_COUNT + 1}`,
  payload: {
    dropped: COMPRESS_DROP,
    since: new Date(BASE_MS).toISOString(),
  },
};

export const chatStress: FixtureScenario = {
  name: 'chat-stress',
  description: `${STRESS_COUNT} chat.appended in rapid succession, then chat.compressed (${COMPRESS_DROP} dropped). Tests dashboard chat virtualisation + ring-overflow banner.`,
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
      part: 'Chat stress demo',
      workDir: '/repo/demo',
    }],
    schedules: [],
    chat: { messages: [], total: 0, hasMore: false },
    hostProfiles: {},
  },
  events: [...stressEvents, compressedEvent],
  // Tight cadence to actually stress the consumer; not zero so timing is observable.
  eventCadenceMs: 5,
};
