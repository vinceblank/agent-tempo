/**
 * Fixture: a conductor plus 8 receivers, simulating a single
 * `broadcast` invocation that fans out to all players. All eight
 * `chat.appended` events share the same `broadcastId` so dashboard UI
 * can verify the #357 collapse — the TUI's `ConversationStream` (and
 * the dashboard's analogue) renders consecutive chat entries with the
 * same non-null `broadcastId` as a single row.
 */
import type { FixtureScenario } from './index';
import type { PlayerSummaryV1 } from '../event-types';
import type { EnsembleChatMessage } from '../../types';
import { FIXTURE_BOOT_EPOCH } from './constants';

const ENSEMBLE = 'demo-broadcast';
const BROADCAST_ID = 'bcast-87654321';
const AT = '2026-04-27T00:00:01.000Z';

const RECEIVERS = [
  'soloist-1', 'soloist-2', 'soloist-3', 'soloist-4',
  'soloist-5', 'soloist-6', 'soloist-7', 'soloist-8',
];

const players: PlayerSummaryV1[] = [
  {
    playerId: 'conductor',
    ensemble: ENSEMBLE,
    hostname: 'demo-host',
    isConductor: true,
    agentType: 'claude',
    playerType: 'tempo-conductor',
    phase: 'attached',
    part: 'Orchestrating the broadcast',
    workDir: '/repo/demo',
  },
  ...RECEIVERS.map<PlayerSummaryV1>((id) => ({
    playerId: id,
    ensemble: ENSEMBLE,
    hostname: 'demo-host',
    isConductor: false,
    agentType: 'claude',
    playerType: 'tempo-soloist',
    phase: 'attached',
    part: 'Soloing',
    workDir: '/repo/demo',
  })),
];

const broadcastChatEvents = RECEIVERS.map<EnsembleChatMessage>((id, i) => ({
  id: `msg-bcast-${i + 1}`,
  from: 'conductor',
  to: id,
  text: 'Beta-3 release rehearsal: please run /smoke and report blockers.',
  timestamp: AT,
  role: 'conductor-out',
  broadcastId: BROADCAST_ID,
}));

export const eightPlayerBroadcast: FixtureScenario = {
  name: 'eight-player-broadcast',
  description: 'Conductor + 8 receivers; one broadcast fan-out (8 chat.appended share broadcastId). Verifies #357 collapse.',
  snapshot: {
    v: 1,
    ensemble: ENSEMBLE,
    capturedAt: '2026-04-27T00:00:00.000Z',
    lastEventId: `${FIXTURE_BOOT_EPOCH}:0`,
    state: 'online',
    hasConductor: true,
    flags: { paused: false, held: false },
    players,
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
  events: broadcastChatEvents.map((msg, i) => ({
    v: 1,
    type: 'chat.appended',
    eventId: `${FIXTURE_BOOT_EPOCH}:${i + 1}`,
    payload: msg,
  })),
  // Mild cadence so the dashboard can render the collapse animation if any.
  eventCadenceMs: 25,
};
