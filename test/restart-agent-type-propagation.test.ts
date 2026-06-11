/**
 * Issue #184 — agent type regression on forced-fresh restart.
 *
 * `deliverRestart` used to drop `agentDefinition`/`agentDefinitionPath`/
 * `nativeResolvable` at outbox-entry time. The fix re-resolves the player
 * type from `metadata.playerType` against `metadata.workDir` (not the
 * daemon's cwd) and threads the three fields into `enqueueSpawnUpdate`.
 *
 * These tests drive `deliverRestart` directly against a mock Temporal
 * `Client` that captures the `enqueueSpawn` update payload, so we can
 * assert the three fields are present and correct without standing up a
 * full Temporal test environment. Modeled after
 * `test/restart-host-routing.test.ts` (tool-level capture) but one layer
 * deeper — at the activity boundary.
 */
import { expect } from 'chai';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createOutboxActivities } from '../src/activities/outbox';
import { Config } from '../src/config';

// ── Mock infrastructure ──────────────────────────────────────────────

const asName = (n: unknown) => (typeof n === 'string' ? n : (n as any).name);

interface MockSessionFixture {
  workflowId: string;
  metadata: Record<string, any>;
  attachmentInfo?: Record<string, any>;
}

/** Build a mock Temporal Client that yields one session and captures updates. */
function makeClient(fixture: MockSessionFixture) {
  const captured: Array<{ name: string; args: unknown }> = [];
  const info = fixture.attachmentInfo ?? {
    phase: 'detached',
    inFlightCount: 0,
  };

  const handle = {
    workflowId: fixture.workflowId,
    async query(name: unknown) {
      const n = asName(name);
      if (n === 'getMetadata') return fixture.metadata;
      if (n === 'attachmentInfo') return info;
      if (n === 'getPart') return '';
      if (n === 'allMessages') return [];
      return undefined;
    },
    async signal(_name: unknown, _payload?: unknown) {
      // metadata updates + receiveMessage are no-ops in this test; we only
      // care about the shape of the `enqueueSpawn` update.
    },
    async executeUpdate(nameOrDef: unknown, opts: { args: unknown[] }) {
      const n = asName(nameOrDef);
      captured.push({ name: n, args: opts.args[0] });
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

  return { client, captured };
}

const testConfig: Config = {
  temporalAddress: 'localhost:7233',
  temporalNamespace: 'default',
  taskQueue: 'agent-tempo',
  ensemble: 'test-ensemble-restart-agent-mock',
  defaultAgent: 'claude',
  costProfile: 'local',
};

function findEnqueue(captured: Array<{ name: string; args: unknown }>) {
  return captured.find((c) => c.name === 'enqueueSpawn');
}

// ── Tests ────────────────────────────────────────────────────────────

describe('deliverRestart agent type propagation (#184)', function () {
  // 1) End-to-end propagation against a real known player type. The actual
  //    tier (user vs shipped) depends on the test user's ~/.claude/agents — we
  //    don't care here; we only assert that whatever the resolver finds flows
  //    intact into the `enqueueSpawn` payload. Test 2 pins the tier semantics
  //    with a hermetic fixture.
  it('threads resolved agent definition into enqueueSpawn payload', async function () {
    const { client, captured } = makeClient({
      workflowId: 'agent-session-test-ensemble-soloist',
      metadata: {
        ensemble: 'test-ensemble-restart-agent-mock',
        playerId: 'soloist',
        hostname: 'test-host',
        workDir: join(tmpdir(), `cw-soloist-${Date.now()}`), // intentionally nonexistent
        isConductor: false,
        agentType: 'claude',
        playerType: 'tempo-soloist',
      },
    });

    const activities = createOutboxActivities(client as any, testConfig);
    const result = await activities.deliverRestart({
      ensemble: 'test-ensemble-restart-agent-mock',
      targetPlayerId: 'soloist',
      invokerPlayerId: 'tempo-conductor',
      fresh: true,
    });
    expect(result.success).to.be.true;

    const enq = findEnqueue(captured);
    expect(enq, 'enqueueSpawn was called').to.exist;
    const args = enq!.args as any;
    expect(args.agentDefinition, 'agentDefinition propagated').to.equal('tempo-soloist');
    expect(args.agentDefinitionPath, 'agentDefinitionPath propagated').to.be.a('string');
    expect(args.agentDefinitionPath).to.match(/tempo-soloist\.md$/);
    expect(args.nativeResolvable, 'nativeResolvable propagated as boolean').to.be.a('boolean');
  });

  // 2) Project-tier player type — seeded inside a throwaway workDir so the
  //    resolver walks `<workDir>/.claude/agents/` first. Confirms the fix
  //    uses `metadata.workDir` (NOT `process.cwd()`) as the resolve root:
  //    if it used the daemon's cwd, this fixture wouldn't be found.
  it('resolves project-tier agent by metadata.workDir (not process.cwd())', async function () {
    const fixtureRoot = join(tmpdir(), `ct-184-${Date.now()}`);
    const agentsDir = join(fixtureRoot, '.claude', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    const agentFile = join(agentsDir, 'my-tempo-engineer.md');
    writeFileSync(
      agentFile,
      '---\nname: my-tempo-engineer\ndescription: test fixture\n---\n\nbody\n',
      'utf8',
    );

    try {
      const { client, captured } = makeClient({
        workflowId: 'agent-session-test-ensemble-eng',
        metadata: {
          ensemble: 'test-ensemble-restart-agent-mock',
          playerId: 'eng',
          hostname: 'test-host',
          workDir: fixtureRoot, // project-tier seeded here
          isConductor: false,
          agentType: 'claude',
          playerType: 'my-tempo-engineer',
        },
      });

      const activities = createOutboxActivities(client as any, testConfig);
      const result = await activities.deliverRestart({
        ensemble: 'test-ensemble-restart-agent-mock',
        targetPlayerId: 'eng',
        invokerPlayerId: 'tempo-conductor',
        fresh: true,
      });
      expect(result.success).to.be.true;

      const enq = findEnqueue(captured);
      expect(enq, 'enqueueSpawn was called').to.exist;
      const args = enq!.args as any;
      expect(args.agentDefinition).to.equal('my-tempo-engineer');
      expect(args.agentDefinitionPath).to.equal(agentFile);
      expect(args.nativeResolvable, 'project tier IS native-resolvable').to.equal(true);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  // 3) #306: `/restart` must ALWAYS spawn fresh — never `--resume <id>`. The
  //    prior transcript `.jsonl` isn't guaranteed to have been flushed to disk
  //    before the hard-terminate, so `claude --resume <uuid>` errors out with
  //    "No conversation found with session ID" and drops to shell. Both the
  //    `fresh: true` and the default (non-fresh) paths must mint a new UUID
  //    and pass `resume: false` to `enqueueSpawn`.
  it('/restart ALWAYS mints a new sessionId + passes resume: false (#306)', async function () {
    const priorSessionId = '11111111-1111-1111-1111-111111111111';

    for (const freshFlag of [true, false]) {
      const { client, captured } = makeClient({
        workflowId: 'agent-session-test-ensemble-fresh',
        metadata: {
          ensemble: 'test-ensemble-restart-agent-mock',
          playerId: 'bob',
          hostname: 'test-host',
          workDir: tmpdir(),
          isConductor: false,
          agentType: 'claude',
          sessionId: priorSessionId,
        },
      });

      const activities = createOutboxActivities(client as any, testConfig);
      await activities.deliverRestart({
        ensemble: 'test-ensemble-restart-agent-mock',
        targetPlayerId: 'bob',
        invokerPlayerId: 'tempo-conductor',
        fresh: freshFlag,
      });

      const enq = findEnqueue(captured);
      expect(enq, `enqueueSpawn captured (fresh=${freshFlag})`).to.exist;
      const args = enq!.args as any;
      // Never `--resume` — the invariant.
      expect(args.resume, `resume is false (fresh=${freshFlag})`).to.equal(false);
      // Always a fresh UUID — never the stored one.
      expect(args.sessionId, `sessionId present (fresh=${freshFlag})`).to.be.a('string');
      expect(args.sessionId).to.not.equal(priorSessionId);
      // Sanity — new UUID shape.
      expect(args.sessionId).to.match(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    }
  });

  // 4) Regression guard — sessions without a `playerType` (legacy / lineup-less
  //    recruits) must not gain spurious agent fields. The enqueueSpawn payload
  //    should omit all three fields.
  it('omits agent fields when metadata has no playerType', async function () {
    const { client, captured } = makeClient({
      workflowId: 'agent-session-test-ensemble-plain',
      metadata: {
        ensemble: 'test-ensemble-restart-agent-mock',
        playerId: 'plain',
        hostname: 'test-host',
        workDir: tmpdir(),
        isConductor: false,
        agentType: 'claude',
        // no playerType
      },
    });

    const activities = createOutboxActivities(client as any, testConfig);
    await activities.deliverRestart({
      ensemble: 'test-ensemble-restart-agent-mock',
      targetPlayerId: 'plain',
      invokerPlayerId: 'tempo-conductor',
      fresh: true,
    });

    const enq = findEnqueue(captured);
    expect(enq).to.exist;
    const args = enq!.args as any;
    expect(args.agentDefinition).to.be.undefined;
    expect(args.agentDefinitionPath).to.be.undefined;
    expect(args.nativeResolvable).to.be.undefined;
  });
});
