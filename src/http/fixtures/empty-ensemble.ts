/**
 * Fixture: an ensemble with no players, no chat, no schedules. Useful
 * for verifying empty-state UI rendering.
 */
import type { FixtureScenario } from './index';
import { FIXTURE_BOOT_EPOCH } from './constants';

export const emptyEnsemble: FixtureScenario = {
  name: 'empty-ensemble',
  description: 'No players, no chat, no schedules. Empty-state UI exercise.',
  snapshot: {
    v: 1,
    ensemble: 'demo-empty',
    capturedAt: '2026-04-27T00:00:00.000Z',
    lastEventId: `${FIXTURE_BOOT_EPOCH}:0`,
    state: 'online',
    hasConductor: false,
    flags: { paused: false, held: false },
    players: [],
    schedules: [],
    chat: { messages: [], total: 0, hasMore: false },
    hostProfiles: {},
  },
  events: [],
};
