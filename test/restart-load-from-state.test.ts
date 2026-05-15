/**
 * #334 PR-2 — `restart` × `loadFromState` integration tests.
 *
 * Drives `deliverRestart` directly against a mock Temporal `Client` (mirrors
 * `test/restart-agent-type-propagation.test.ts`'s activity-level mock pattern)
 * so we can assert the Step 5 saved-state branch without standing up a full
 * Temporal test environment. The mock captures `signal` and `executeUpdate`
 * calls so each assertion can inspect what `deliverRestart` did during the
 * run.
 *
 * Coverage matrix (design §4.4):
 *
 *   loadFromState: undefined (control)        → transcript replay only
 *   loadFromState: true,  slot populated      → saved state, transcript suppressed
 *   loadFromState: 'foo', slot populated      → saved state at named slot
 *   loadFromState: true,  slot empty          → graceful fallback to transcript replay
 *   loadFromState: true,  transcript: 'replay' → STACK: state + transcript
 *   loadFromState: true,  fresh: true         → state seeded, replay skipped per `fresh`
 *
 * Verifies the `from: 'self-restart'` system identity and the slot-key /
 * savedAt / savedBy fields are surfaced in the payload header.
 */
import { expect } from 'chai';
import { createOutboxActivities } from '../src/activities/outbox';
import { Config } from '../src/config';
import type { PlayerStateEntry } from '../src/types';

// ── Mock infrastructure ──────────────────────────────────────────────────

const asName = (n: unknown) => (typeof n === 'string' ? n : (n as any).name);

interface CapturedSignal {
  name: string;
  payload: any;
}

interface CapturedUpdate {
  name: string;
  args: unknown;
}

interface MockSessionFixture {
  workflowId: string;
  metadata: Record<string, any>;
  /** Slot map exposed via `playerStateQuery({ key })`. Missing keys → null. */
  playerState?: Record<string, PlayerStateEntry>;
  /** Recent messages exposed via `allMessages` query. */
  messages?: Array<{ from: string; text: string }>;
  /** Last-known `getPart` value. Default: empty. */
  part?: string;
  attachmentInfo?: Record<string, any>;
}

function makeClient(fixture: MockSessionFixture) {
  const signals: CapturedSignal[] = [];
  const updates: CapturedUpdate[] = [];
  const info = fixture.attachmentInfo ?? {
    phase: 'detached',
    inFlightCount: 0,
  };

  const handle = {
    workflowId: fixture.workflowId,
    async query(name: unknown, args?: any) {
      const n = asName(name);
      if (n === 'getMetadata') return fixture.metadata;
      if (n === 'attachmentInfo') return info;
      if (n === 'getPart') return fixture.part ?? '';
      if (n === 'allMessages') return fixture.messages ?? [];
      if (n === 'playerState') {
        const key = (args as { key?: string })?.key ?? 'main';
        return fixture.playerState?.[key] ?? null;
      }
      return undefined;
    },
    async signal(name: unknown, payload?: unknown) {
      signals.push({ name: asName(name), payload });
    },
    async executeUpdate(name: unknown, opts: { args: unknown[] }) {
      const n = asName(name);
      updates.push({ name: n, args: opts.args[0] });
      if (n === 'claimAttachment') {
        return { attachmentId: 'a-fresh-1', runId: 'r-fresh-1' };
      }
      if (n === 'enqueueSpawn') {
        return { spawnEntryId: 'spawn-1' };
      }
      if (n === 'forceDetach') {
        return { reaped: false };
      }
      return {};
    },
  };

  const client = {
    workflow: {
      getHandle: () => handle,
      async *list() {
        yield { workflowId: fixture.workflowId };
      },
    },
  };

  return { client, signals, updates };
}

const testConfig: Config = {
  temporalAddress: 'localhost:7233',
  temporalNamespace: 'default',
  taskQueue: 'agent-tempo',
  ensemble: 'test-ensemble-restart-loadstate',
  defaultAgent: 'claude',
};

const baseMetadata = {
  ensemble: 'test-ensemble-restart-loadstate',
  playerId: 'soloist',
  hostname: 'test-host',
  workDir: '/tmp/test-work',
  isConductor: false,
  agentType: 'claude' as const,
};

const sampleEntry: PlayerStateEntry = {
  content: '## Current task\nWriting #334 PR-2',
  savedAt: '2026-05-01T12:00:00.000Z',
  savedBy: 'soloist',
};

/** Helper — pull every `receiveMessage` signal from the captured list. */
function receiveMessages(signals: CapturedSignal[]): Array<{ from: string; text: string }> {
  return signals
    .filter((s) => s.name === 'receiveMessage')
    .map((s) => s.payload as { from: string; text: string });
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('deliverRestart × loadFromState (#334 PR-2)', function () {
  // Control — establishes the baseline so the `loadFromState` rows below
  // can be verified as substituting (or stacking) for the existing replay.
  it('control: no loadFromState → existing transcript-replay behaviour preserved', async function () {
    const { client, signals } = makeClient({
      workflowId: 'agent-session-test-ensemble-soloist',
      metadata: baseMetadata,
      messages: [{ from: 'tempo-conductor', text: 'hello' }],
      playerState: { main: sampleEntry },
    });
    const activities = createOutboxActivities(client as any, testConfig);
    await activities.deliverRestart({
      ensemble: testConfig.ensemble,
      targetPlayerId: 'soloist',
      invokerPlayerId: 'tempo-conductor',
    });

    const msgs = receiveMessages(signals);
    expect(msgs).to.have.lengthOf(1);
    expect(msgs[0].from).to.equal('tempo-conductor');
    expect(msgs[0].text).to.include('Restart');
    expect(msgs[0].text).to.not.include('Restored state');
  });

  it('loadFromState:true with populated slot → seeds saved state, suppresses transcript replay', async function () {
    const { client, signals } = makeClient({
      workflowId: 'agent-session-test-ensemble-soloist',
      metadata: baseMetadata,
      messages: [{ from: 'tempo-conductor', text: 'hello' }],
      playerState: { main: sampleEntry },
    });
    const activities = createOutboxActivities(client as any, testConfig);
    await activities.deliverRestart({
      ensemble: testConfig.ensemble,
      targetPlayerId: 'soloist',
      invokerPlayerId: 'tempo-conductor',
      loadFromState: true,
    });

    const msgs = receiveMessages(signals);
    // Exactly one message — the saved state. No transcript replay.
    expect(msgs).to.have.lengthOf(1);
    expect(msgs[0].from).to.equal('self-restart');
    expect(msgs[0].text).to.include('Restored state — "main"');
    expect(msgs[0].text).to.include(sampleEntry.savedAt);
    expect(msgs[0].text).to.include(sampleEntry.savedBy);
    expect(msgs[0].text).to.include(sampleEntry.content);
  });

  it('loadFromState:"someKey" with populated slot → seeds the named slot', async function () {
    const customEntry: PlayerStateEntry = {
      content: 'bookmark payload',
      savedAt: '2026-05-01T13:00:00.000Z',
      savedBy: 'soloist',
    };
    const { client, signals } = makeClient({
      workflowId: 'agent-session-test-ensemble-soloist',
      metadata: baseMetadata,
      playerState: { main: sampleEntry, bookmark: customEntry },
    });
    const activities = createOutboxActivities(client as any, testConfig);
    await activities.deliverRestart({
      ensemble: testConfig.ensemble,
      targetPlayerId: 'soloist',
      invokerPlayerId: 'tempo-conductor',
      loadFromState: 'bookmark',
    });

    const msgs = receiveMessages(signals);
    expect(msgs).to.have.lengthOf(1);
    expect(msgs[0].from).to.equal('self-restart');
    expect(msgs[0].text).to.include('Restored state — "bookmark"');
    expect(msgs[0].text).to.include('bookmark payload');
    // Crucially — the 'main' slot was NOT used.
    expect(msgs[0].text).to.not.include(sampleEntry.content);
  });

  it('loadFromState:true with EMPTY slot → graceful fallback to transcript replay', async function () {
    const { client, signals } = makeClient({
      workflowId: 'agent-session-test-ensemble-soloist',
      metadata: baseMetadata,
      messages: [{ from: 'tempo-conductor', text: 'pre-restart context' }],
      playerState: {}, // empty — nothing at 'main'
    });
    const activities = createOutboxActivities(client as any, testConfig);
    await activities.deliverRestart({
      ensemble: testConfig.ensemble,
      targetPlayerId: 'soloist',
      invokerPlayerId: 'tempo-conductor',
      loadFromState: true,
    });

    const msgs = receiveMessages(signals);
    // No saved-state delivery (slot was empty), but transcript replay still
    // happens — the fallback path. Exactly one message; from is the invoker.
    expect(msgs).to.have.lengthOf(1);
    expect(msgs[0].from).to.equal('tempo-conductor');
    expect(msgs[0].from).to.not.equal('self-restart');
    expect(msgs[0].text).to.include('Restart');
    expect(msgs[0].text).to.include('pre-restart context');
  });

  it('loadFromState:true + transcript:"replay" → STACK: saved state first, transcript second', async function () {
    const { client, signals } = makeClient({
      workflowId: 'agent-session-test-ensemble-soloist',
      metadata: baseMetadata,
      messages: [{ from: 'tempo-conductor', text: 'transcript line' }],
      playerState: { main: sampleEntry },
    });
    const activities = createOutboxActivities(client as any, testConfig);
    await activities.deliverRestart({
      ensemble: testConfig.ensemble,
      targetPlayerId: 'soloist',
      invokerPlayerId: 'tempo-conductor',
      loadFromState: true,
      transcript: 'replay',
    });

    const msgs = receiveMessages(signals);
    expect(msgs).to.have.lengthOf(2);
    // Order matters: saved state delivered FIRST per design §4.4.
    expect(msgs[0].from).to.equal('self-restart');
    expect(msgs[0].text).to.include('Restored state');
    expect(msgs[1].from).to.equal('tempo-conductor');
    expect(msgs[1].text).to.include('Restart');
    expect(msgs[1].text).to.include('transcript line');
  });

  it('loadFromState:true + fresh:true → state seeded, transcript skipped (fresh wins)', async function () {
    const { client, signals } = makeClient({
      workflowId: 'agent-session-test-ensemble-soloist',
      metadata: baseMetadata,
      messages: [{ from: 'tempo-conductor', text: 'noise' }],
      playerState: { main: sampleEntry },
    });
    const activities = createOutboxActivities(client as any, testConfig);
    await activities.deliverRestart({
      ensemble: testConfig.ensemble,
      targetPlayerId: 'soloist',
      invokerPlayerId: 'tempo-conductor',
      loadFromState: true,
      fresh: true,
    });

    const msgs = receiveMessages(signals);
    // Saved state still delivered, but the existing `fresh` flag short-circuits
    // the replay block — even via the `transcript: 'replay'` opt-in path,
    // since `fresh` gates the whole replay block.
    expect(msgs).to.have.lengthOf(1);
    expect(msgs[0].from).to.equal('self-restart');
  });

  it('loadFromState:true + fresh:true + EMPTY slot → no messages at all', async function () {
    const { client, signals } = makeClient({
      workflowId: 'agent-session-test-ensemble-soloist',
      metadata: baseMetadata,
      messages: [{ from: 'tempo-conductor', text: 'noise' }],
      playerState: {},
    });
    const activities = createOutboxActivities(client as any, testConfig);
    await activities.deliverRestart({
      ensemble: testConfig.ensemble,
      targetPlayerId: 'soloist',
      invokerPlayerId: 'tempo-conductor',
      loadFromState: true,
      fresh: true,
    });

    const msgs = receiveMessages(signals);
    // Slot empty → would fall back to replay, but `fresh: true` skips it.
    // No messages delivered at all (the player gets a clean slate).
    expect(msgs).to.have.lengthOf(0);
  });
});
