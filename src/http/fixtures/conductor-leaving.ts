/**
 * Fixture: an ensemble with a conductor + one soloist; the conductor
 * detaches mid-stream. Exercises the dashboard's "conductor left" UI
 * (#358 analog) — the ensemble continues to exist, but `hasConductor`
 * flips to false after the `player.removed` event lands.
 */
import type { FixtureScenario } from './index';
import { FIXTURE_BOOT_EPOCH } from './constants';

const ENSEMBLE = 'demo-conductor-leaving';

export const conductorLeaving: FixtureScenario = {
  name: 'conductor-leaving',
  description: 'Conductor + 1 soloist; conductor leaves mid-stream (player.phase_changed → player.removed).',
  snapshot: {
    v: 1,
    ensemble: ENSEMBLE,
    capturedAt: '2026-04-27T00:00:00.000Z',
    lastEventId: `${FIXTURE_BOOT_EPOCH}:0`,
    state: 'online',
    hasConductor: true,
    flags: { paused: false, held: false },
    players: [
      {
        playerId: 'conductor',
        ensemble: ENSEMBLE,
        hostname: 'demo-host',
        isConductor: true,
        agentType: 'claude',
        playerType: 'tempo-conductor',
        phase: 'attached',
        part: 'About to leave',
        workDir: '/repo/demo',
      },
      {
        playerId: 'tempo-eng',
        ensemble: ENSEMBLE,
        hostname: 'demo-host',
        isConductor: false,
        agentType: 'claude',
        playerType: 'tempo-engineer',
        phase: 'processing',
        part: 'Implementing PR-3',
        workDir: '/repo/demo',
        processingSince: '2026-04-26T23:55:00.000Z',
      },
    ],
    schedules: [],
    chat: { messages: [], total: 0, hasMore: false },
    hostProfiles: {
      'demo-host': {
        hostname: 'demo-host', version: '0.28.0',
        defaultAgent: 'claude', platform: 'linux', capabilities: [],
      },
    },
  },
  events: [
    {
      v: 1,
      type: 'player.phase_changed',
      eventId: `${FIXTURE_BOOT_EPOCH}:1`,
      payload: {
        playerId: 'conductor',
        ensemble: ENSEMBLE,
        phase: 'detached',
        at: '2026-04-27T00:00:01.000Z',
      },
    },
    {
      v: 1,
      type: 'player.removed',
      eventId: `${FIXTURE_BOOT_EPOCH}:2`,
      payload: {
        playerId: 'conductor',
        ensemble: ENSEMBLE,
        removedAt: '2026-04-27T00:00:02.000Z',
        reason: 'gone',
      },
    },
  ],
  eventCadenceMs: 500,
};
