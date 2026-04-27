/**
 * Fixture: a single conductor player, no other players, no chat.
 * Exercises the "conductor-only" lobby state the dashboard renders
 * before any soloists join.
 */
import type { FixtureScenario } from './index';
import { FIXTURE_BOOT_EPOCH } from './constants';

export const singleConductor: FixtureScenario = {
  name: 'single-conductor',
  description: 'One conductor, no other players. Lobby state.',
  snapshot: {
    v: 1,
    ensemble: 'demo-conductor',
    capturedAt: '2026-04-27T00:00:00.000Z',
    lastEventId: `${FIXTURE_BOOT_EPOCH}:0`,
    state: 'online',
    hasConductor: true,
    flags: { paused: false, held: false },
    players: [{
      playerId: 'conductor',
      ensemble: 'demo-conductor',
      hostname: 'demo-host',
      isConductor: true,
      agentType: 'claude',
      playerType: 'tempo-conductor',
      phase: 'attached',
      part: 'Orchestrating the demo',
      workDir: '/repo/demo',
      gitBranch: 'main',
      lastHeartbeatAt: '2026-04-27T00:00:00.000Z',
    }],
    schedules: [],
    chat: { messages: [], total: 0, hasMore: false },
    hostProfiles: {
      'demo-host': {
        hostname: 'demo-host',
        version: '0.28.0',
        defaultAgent: 'claude',
        platform: 'linux',
        capabilities: [],
      },
    },
  },
  events: [],
};
