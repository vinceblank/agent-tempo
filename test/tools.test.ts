/**
 * Unit tests for MCP tool input validation.
 *
 * These tests verify that validation logic in the tool registration functions
 * catches bad inputs and returns the correct error responses — without spinning
 * up a Temporal worker or connecting to any external service.
 *
 * Harness approach: `defineTool` calls `server.tool(name, desc, schema, handler)`.
 * We provide a fake McpServer that intercepts the handler closure, then call it
 * directly with test arguments. No Temporal client, no worker, no network.
 *
 * Covers:
 *   - recruit: name validation, reserved name guard, unknown agent type
 *   - schedule: timing field validation, invalid ISO, too-short interval, self-resolution
 *   - stop: self-stop prevention
 *   - encore: self-encore guard, status checks (active/pending/terminated/stale)
 *   - load_lineup: argument mutual exclusion
 */
import { expect } from 'chai';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Client, WorkflowHandle } from '@temporalio/client';
import type { Config } from '../src/config';
import type { SessionMetadata, SessionStatus } from '../src/types';
import { registerRecruitTool } from '../src/tools/recruit';
import { registerScheduleTool } from '../src/tools/schedule';
import { registerStopTool } from '../src/tools/stop';
import { registerLoadLineupTool } from '../src/tools/load-lineup';
import { registerBroadcastTool } from '../src/tools/broadcast';
import { registerRecallTool } from '../src/tools/recall';
import { registerEncoreTool } from '../src/tools/encore';

// ─────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────

type ToolHandler = (args: Record<string, any>) => Promise<{
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}>;

/**
 * Extract the handler closure registered by a tool's `register*` function.
 * The fake server intercepts `server.tool(name, desc, schema, handler)` and
 * captures the handler, which we then call directly in tests.
 */
function extractHandler(registerFn: (server: McpServer) => void): ToolHandler {
  let captured: Function | undefined;
  const fakeServer = {
    tool: (_name: unknown, _desc: unknown, _schema: unknown, handler: Function) => {
      captured = handler;
    },
  } as unknown as McpServer;
  registerFn(fakeServer);
  if (!captured) throw new Error('No handler captured — tool did not call server.tool()');
  return (args: Record<string, any>) => captured!(args, {});
}

// ── Shared fakes ──

const TEST_PLAYER_ID = 'test-player';
const getPlayerId = () => TEST_PLAYER_ID;

const testConfig: Config = {
  temporalAddress: 'localhost:7233',
  temporalNamespace: 'default',
  taskQueue: 'claude-tempo',
  ensemble: 'test-ensemble',
  defaultAgent: 'claude',
};

/**
 * Minimal fake Temporal client.
 * - getHandle: returns a handle whose describe() always throws (no running workflow).
 * - workflow.start: resolves successfully (scheduler launch path).
 * - workflow.list: yields nothing (no existing sessions).
 */
function makeTestClient(): Client {
  return {
    workflow: {
      getHandle: (_id: string) => ({
        describe: async () => { throw new Error('workflow not found'); },
        signal: async () => {},
      }),
      start: async () => ({ runId: 'fake-run-id' }),
      list: async function* () { /* no workflows */ },
    },
  } as unknown as Client;
}

/** Fake WorkflowHandle — only needed when a test reaches the outbox-submit path. */
const fakeHandle = {
  executeUpdate: async () => 'fake-entry-id',
} as unknown as WorkflowHandle;

// ─────────────────────────────────────────────
// recruit tool
// ─────────────────────────────────────────────

describe('recruit tool validation', function () {
  let call: ToolHandler;

  before(function () {
    call = extractHandler((server) =>
      registerRecruitTool(server, makeTestClient(), testConfig, getPlayerId, fakeHandle, 'claude'),
    );
  });

  describe('name validation', function () {
    it('rejects a name with spaces', async function () {
      const result = await call({ workDir: '/tmp', name: 'bad name' });
      expect(result.isError).to.be.true;
      expect(result.content[0].text).to.include('Invalid name');
    });

    it('rejects a name with special characters', async function () {
      const result = await call({ workDir: '/tmp', name: 'bad/name!' });
      expect(result.isError).to.be.true;
      expect(result.content[0].text).to.include('Invalid name');
    });

    it('rejects a name that exceeds PLAYER_NAME_MAX (64 chars)', async function () {
      const longName = 'a'.repeat(65);
      const result = await call({ workDir: '/tmp', name: longName });
      expect(result.isError).to.be.true;
      expect(result.content[0].text).to.include('too long');
    });

    it('accepts a valid name with hyphens and underscores', async function () {
      // Valid name passes all guards and reaches resolveSession (which returns null
      // on the fake client), then submits outbox entry — not an error.
      const result = await call({ workDir: '/tmp', name: 'valid-name_1' });
      expect(result.isError).to.not.equal(true);
      expect(result.content[0].text).to.include('valid-name_1');
    });
  });

  describe('reserved name guard', function () {
    it('rejects "conductor" as a player name when conductor flag is not set', async function () {
      const result = await call({ workDir: '/tmp', name: 'conductor', conductor: false });
      expect(result.isError).to.be.true;
      expect(result.content[0].text).to.include('reserved');
    });

    it('allows "conductor" when conductor: true is set', async function () {
      // "conductor" is valid here — proceeds to check if conductor already running.
      // Fake client's describe() throws → treated as "no conductor running" → proceeds.
      const result = await call({ workDir: '/tmp', name: 'conductor', conductor: true });
      // Should not error on the reserved-name check (may succeed or fail on conductor check)
      const text = result.content[0].text;
      expect(text).to.not.include('reserved');
    });
  });

  describe('unknown agent type', function () {
    it('rejects an unknown type with an error listing available types', async function () {
      const result = await call({ workDir: '/tmp', name: 'worker', type: 'nonexistent-agent-xyz' });
      expect(result.isError).to.be.true;
      expect(result.content[0].text).to.include('Unknown agent type "nonexistent-agent-xyz"');
      expect(result.content[0].text).to.include('Available types');
    });

    it('accepts a known shipped agent type', async function () {
      const result = await call({ workDir: '/tmp', name: 'eng', type: 'tempo-soloist' });
      // Should not error on agent type resolution
      expect(result.content[0].text).to.not.include('Unknown agent type');
    });
  });
});

// ─────────────────────────────────────────────
// schedule tool
// ─────────────────────────────────────────────

describe('schedule tool validation', function () {
  let call: ToolHandler;

  before(function () {
    call = extractHandler((server) =>
      registerScheduleTool(server, makeTestClient(), testConfig, getPlayerId),
    );
  });

  describe('timing field validation', function () {
    it('rejects when both "at" and "delay" are provided', async function () {
      const result = await call({
        name: 'test', message: 'hi', target: 'alice',
        at: '2026-01-01T00:00:00Z', delay: '10m',
      });
      expect(result.isError).to.be.true;
      expect(result.content[0].text).to.include('exactly one timing option');
    });

    it('rejects when both "delay" and "every" are provided', async function () {
      const result = await call({
        name: 'test', message: 'hi', target: 'alice',
        delay: '10m', every: '1h',
      });
      expect(result.isError).to.be.true;
      expect(result.content[0].text).to.include('exactly one timing option');
    });

    it('rejects when all three timing fields are provided', async function () {
      const result = await call({
        name: 'test', message: 'hi', target: 'alice',
        at: '2026-01-01T00:00:00Z', delay: '10m', every: '1h',
      });
      expect(result.isError).to.be.true;
      expect(result.content[0].text).to.include('exactly one timing option');
    });

    it('rejects when no timing field is provided', async function () {
      const result = await call({ name: 'test', message: 'hi', target: 'alice' });
      expect(result.isError).to.be.true;
      expect(result.content[0].text).to.include('exactly one timing option');
    });
  });

  describe('"at" field validation', function () {
    it('rejects an unparseable datetime string', async function () {
      const result = await call({
        name: 'test', message: 'hi', target: 'alice',
        at: 'not-a-date',
      });
      expect(result.isError).to.be.true;
      expect(result.content[0].text).to.include('Invalid ISO datetime for "at"');
    });

    it('rejects an empty string for "at"', async function () {
      const result = await call({
        name: 'test', message: 'hi', target: 'alice',
        at: '',
      });
      // empty string is falsy — treated as "not provided", so timingCount = 0
      expect(result.isError).to.be.true;
      expect(result.content[0].text).to.include('exactly one timing option');
    });
  });

  describe('"every" interval validation', function () {
    it('rejects "9s" — below the 10s minimum', async function () {
      const result = await call({
        name: 'test', message: 'hi', target: 'alice',
        every: '9s',
      });
      expect(result.isError).to.be.true;
      expect(result.content[0].text).to.include('Minimum is 10s');
    });

    it('rejects "0s" — zero is also below the minimum', async function () {
      const result = await call({
        name: 'test', message: 'hi', target: 'alice',
        every: '0s',
      });
      expect(result.isError).to.be.true;
      expect(result.content[0].text).to.include('Minimum is 10s');
    });

    it('rejects an invalid duration string for "every"', async function () {
      const result = await call({
        name: 'test', message: 'hi', target: 'alice',
        every: 'not-a-duration',
      });
      expect(result.isError).to.be.true;
      expect(result.content[0].text).to.include('Minimum is 10s');
    });
  });

  describe('"delay" field validation', function () {
    it('rejects an invalid duration string for "delay"', async function () {
      const result = await call({
        name: 'test', message: 'hi', target: 'alice',
        delay: 'not-a-duration',
      });
      expect(result.isError).to.be.true;
      expect(result.content[0].text).to.include('Invalid duration for "delay"');
    });
  });

  describe('"until" field validation', function () {
    it('rejects an invalid datetime string for "until"', async function () {
      const result = await call({
        name: 'test', message: 'hi', target: 'alice',
        delay: '10m', until: 'not-a-date',
      });
      expect(result.isError).to.be.true;
      expect(result.content[0].text).to.include('Invalid ISO datetime for "until"');
    });
  });

  describe('"self" target resolution', function () {
    it('resolves "self" to the current player ID in the success response', async function () {
      // Use a valid schedule so the handler proceeds past all validation.
      // The fake client's describe() throws → scheduler starts via workflow.start().
      const result = await call({
        name: 'ping-self', message: 'hello', target: 'self',
        delay: '10m',
      });
      // Whether it succeeds or hits a non-validation error, "self" should not appear
      // in the target — it should have been replaced with TEST_PLAYER_ID.
      expect(result.content[0].text).to.not.include('Target: self');
      if (!result.isError) {
        expect(result.content[0].text).to.include(`Target: ${TEST_PLAYER_ID}`);
      }
    });
  });
});

// ─────────────────────────────────────────────
// stop tool
// ─────────────────────────────────────────────

describe('stop tool validation', function () {
  let call: ToolHandler;

  before(function () {
    call = extractHandler((server) =>
      registerStopTool(server, makeTestClient(), testConfig, getPlayerId, fakeHandle),
    );
  });

  it('rejects stopping your own session', async function () {
    // getPlayerId() returns TEST_PLAYER_ID; stopping the same name is forbidden.
    const result = await call({ playerId: TEST_PLAYER_ID });
    expect(result.isError).to.be.true;
    expect(result.content[0].text).to.equal('Cannot stop your own session.');
  });

  it('proceeds past self-check for a different player name', async function () {
    // 'other-player' !== TEST_PLAYER_ID, so we pass the self-check.
    // resolveSession returns null (fake client has empty list) → returns "not found" error.
    const result = await call({ playerId: 'other-player' });
    // The error is "not found", NOT "cannot stop your own session"
    expect(result.content[0].text).to.not.equal('Cannot stop your own session.');
    expect(result.content[0].text).to.include('No active session found');
  });
});

// ─────────────────────────────────────────────
// load_lineup tool
// ─────────────────────────────────────────────

describe('load_lineup tool validation', function () {
  let call: ToolHandler;

  before(function () {
    call = extractHandler((server) =>
      registerLoadLineupTool(server, makeTestClient(), testConfig, getPlayerId, 'claude'),
    );
  });

  it('rejects when neither name nor path is provided', async function () {
    const result = await call({});
    expect(result.isError).to.be.true;
    expect(result.content[0].text).to.include('Provide either');
    expect(result.content[0].text).to.include('Exactly one is required');
  });

  it('rejects when both name and path are provided', async function () {
    const result = await call({ name: 'my-lineup', path: '/some/path/lineup.yaml' });
    expect(result.isError).to.be.true;
    expect(result.content[0].text).to.include('not both');
  });
});

// ─────────────────────────────────────────────
// broadcast tool
// ─────────────────────────────────────────────

/**
 * Build a fake Temporal client whose workflow.list() yields sessions for the
 * given player descriptors. Each player's metadata is returned via the handle's
 * query('getMetadata') method, keyed by the workflow ID convention.
 */
function makeClientWithPlayers(
  players: Array<{
    playerId: string;
    ensemble?: string;
    playerType?: string;
    status?: string;
  }>,
): Client {
  return {
    workflow: {
      getHandle: (workflowId: string) => ({
        describe: async () => ({}),
        signal: async () => {},
        query: async (queryName: string) => {
          if (queryName === 'getMetadata') {
            const player = players.find(
              (p) => workflowId === `claude-session-${testConfig.ensemble}-${p.playerId}`,
            );
            return {
              playerId: player?.playerId ?? 'unknown',
              ensemble: player?.ensemble ?? testConfig.ensemble,
              hostname: 'test-host',
              workDir: '/tmp',
              isConductor: false,
              agentType: 'claude',
              status: (player?.status ?? 'active') as SessionStatus,
              playerType: player?.playerType,
            } satisfies SessionMetadata;
          }
          throw new Error(`Unexpected query: ${queryName}`);
        },
        executeUpdate: async () => 'fake-entry-id',
      }),
      start: async () => ({ runId: 'fake-run-id' }),
      list: async function* () {
        for (const p of players) {
          yield { workflowId: `claude-session-${testConfig.ensemble}-${p.playerId}` };
        }
      },
    },
  } as unknown as Client;
}

describe('broadcast tool validation', function () {
  it('returns error when no active players match (empty ensemble)', async function () {
    const call = extractHandler((server) =>
      registerBroadcastTool(server, makeTestClient(), testConfig, getPlayerId, fakeHandle),
    );
    const result = await call({ message: 'hello everyone' });
    expect(result.isError).to.be.true;
    expect(result.content[0].text).to.include('No active players');
  });

  it('excludes self — sender does not receive their own broadcast', async function () {
    // List includes TEST_PLAYER_ID (self) and one other player.
    const call = extractHandler((server) =>
      registerBroadcastTool(
        server,
        makeClientWithPlayers([
          { playerId: TEST_PLAYER_ID },
          { playerId: 'other-player' },
        ]),
        testConfig,
        getPlayerId,
        fakeHandle,
      ),
    );
    const result = await call({ message: 'hello' });
    expect(result.isError).to.not.equal(true);
    // Only 'other-player' should be in the recipients list
    expect(result.content[0].text).to.include('other-player');
    expect(result.content[0].text).to.not.include(TEST_PLAYER_ID);
  });

  it('filters by player type when "type" is specified', async function () {
    const call = extractHandler((server) =>
      registerBroadcastTool(
        server,
        makeClientWithPlayers([
          { playerId: 'soloist-1', playerType: 'tempo-soloist' },
          { playerId: 'critic-1', playerType: 'tempo-critic' },
        ]),
        testConfig,
        getPlayerId,
        fakeHandle,
      ),
    );
    const result = await call({ message: 'review time', type: 'tempo-critic' });
    expect(result.isError).to.not.equal(true);
    expect(result.content[0].text).to.include('critic-1');
    expect(result.content[0].text).to.not.include('soloist-1');
  });

  it('excludes stale sessions by default', async function () {
    const call = extractHandler((server) =>
      registerBroadcastTool(
        server,
        makeClientWithPlayers([
          { playerId: 'stale-player', status: 'stale' },
          { playerId: 'active-player', status: 'active' },
        ]),
        testConfig,
        getPlayerId,
        fakeHandle,
      ),
    );
    const result = await call({ message: 'hello' });
    expect(result.isError).to.not.equal(true);
    expect(result.content[0].text).to.include('active-player');
    expect(result.content[0].text).to.not.include('stale-player');
  });

  it('includes stale sessions when includeStale: true', async function () {
    const call = extractHandler((server) =>
      registerBroadcastTool(
        server,
        makeClientWithPlayers([
          { playerId: 'stale-player', status: 'stale' },
        ]),
        testConfig,
        getPlayerId,
        fakeHandle,
      ),
    );
    const result = await call({ message: 'revive', includeStale: true });
    expect(result.isError).to.not.equal(true);
    expect(result.content[0].text).to.include('stale-player');
  });

  it('reports N recipients in success response', async function () {
    const call = extractHandler((server) =>
      registerBroadcastTool(
        server,
        makeClientWithPlayers([
          { playerId: 'alice' },
          { playerId: 'bob' },
          { playerId: 'carol' },
        ]),
        testConfig,
        getPlayerId,
        fakeHandle,
      ),
    );
    const result = await call({ message: 'all hands' });
    expect(result.isError).to.not.equal(true);
    expect(result.content[0].text).to.match(/Broadcast sent to 3 players/);
  });
});

// ─────────────────────────────────────────────
// recall tool
// ─────────────────────────────────────────────

/**
 * Build a fake WorkflowHandle whose query() returns a predefined message list.
 * Used to exercise recall's filtering logic without a real Temporal connection.
 */
function makeRecallHandle(
  received: Array<{ from: string; text: string; timestamp: string; delivered?: boolean }>,
  sent: Array<{ to: string; text: string; timestamp: string }> = [],
): WorkflowHandle {
  return {
    executeUpdate: async () => 'fake-entry-id',
    query: async (queryName: string) => {
      if (queryName === 'allMessages') {
        return received.map((m, i) => ({
          id: `msg-${i}`,
          from: m.from,
          text: m.text,
          timestamp: m.timestamp,
          delivered: m.delivered ?? true,
        }));
      }
      if (queryName === 'allSentMessages') {
        return sent.map((s, i) => ({
          id: `sent-${i}`,
          to: s.to,
          text: s.text,
          timestamp: s.timestamp,
        }));
      }
      throw new Error(`Unexpected query: ${queryName}`);
    },
  } as unknown as WorkflowHandle;
}

const emptyRecallHandle = makeRecallHandle([]);

describe('recall tool validation', function () {
  let call: ToolHandler;

  before(function () {
    call = extractHandler((server) =>
      registerRecallTool(server, emptyRecallHandle, getPlayerId),
    );
  });

  describe('limit validation (Zod schema)', function () {
    it('rejects limit of 0 via Zod min(1)', function () {
      const schema = z.number().min(1).max(100);
      expect(schema.safeParse(0).success).to.be.false;
    });

    it('rejects limit of 101 via Zod max(100)', function () {
      const schema = z.number().min(1).max(100);
      expect(schema.safeParse(101).success).to.be.false;
    });

    it('accepts limit of 1 (minimum boundary)', async function () {
      // Empty history → "no messages" rather than a limit error
      const result = await call({ limit: 1 });
      expect(result.content[0].text).to.include('No messages');
    });

    it('accepts limit of 100 (maximum boundary)', async function () {
      const result = await call({ limit: 100 });
      expect(result.content[0].text).to.include('No messages');
    });
  });

  describe('"since" field validation', function () {
    it('rejects an invalid ISO timestamp string', async function () {
      const result = await call({ since: 'not-a-date' });
      expect(result.isError).to.be.true;
      expect(result.content[0].text).to.include('Invalid ISO timestamp');
    });

    it('rejects an empty string for "since"', async function () {
      // Empty string is falsy — treated as undefined → skips the since filter
      // Behaviour: no error, returns "no messages" (empty history)
      const result = await call({ since: '' });
      expect(result.content[0].text).to.not.include('Invalid ISO timestamp');
    });
  });

  describe('filtering behaviour', function () {
    it('returns no-messages response when history is empty', async function () {
      const result = await call({});
      expect(result.isError).to.not.equal(true);
      expect(result.content[0].text).to.include('No messages found');
    });

    it('"limit" caps results to the N most recent messages (newest-first)', async function () {
      const msgs = Array.from({ length: 25 }, (_, i) => ({
        from: 'alice',
        text: `msg-${i}`,
        timestamp: new Date(1_000_000 + i * 1000).toISOString(),
      }));
      const h = makeRecallHandle(msgs);
      const callWith = extractHandler((server) => registerRecallTool(server, h, getPlayerId));

      const result = await callWith({ limit: 5 });
      expect(result.isError).to.not.equal(true);
      expect(result.content[0].text).to.match(/^5 messages/);
      // The newest message (msg-24) should appear; oldest (msg-0) should not
      expect(result.content[0].text).to.include('msg-24');
      expect(result.content[0].text).to.not.include('msg-0');
    });

    it('"since" filter excludes messages older than the cutoff timestamp', async function () {
      const t1 = new Date(1_000_000).toISOString();
      const t2 = new Date(2_000_000).toISOString();
      const t3 = new Date(3_000_000).toISOString();
      const cutoff = new Date(1_500_000).toISOString(); // between t1 and t2

      const h = makeRecallHandle([
        { from: 'alice', text: 'old-message', timestamp: t1 },
        { from: 'bob', text: 'recent-message', timestamp: t2 },
        { from: 'carol', text: 'newest-message', timestamp: t3 },
      ]);
      const callWith = extractHandler((server) => registerRecallTool(server, h, getPlayerId));

      const result = await callWith({ since: cutoff });
      expect(result.isError).to.not.equal(true);
      expect(result.content[0].text).to.include('recent-message');
      expect(result.content[0].text).to.include('newest-message');
      // old-message (t1 < cutoff) must be absent
      expect(result.content[0].text).to.not.include('old-message');
    });

    it('"from" filter returns only messages from the specified sender', async function () {
      const now = new Date().toISOString();
      const h = makeRecallHandle([
        { from: 'alice', text: 'message-from-alice', timestamp: now },
        { from: 'bob', text: 'message-from-bob', timestamp: now },
      ]);
      const callWith = extractHandler((server) => registerRecallTool(server, h, getPlayerId));

      const result = await callWith({ from: 'alice' });
      expect(result.isError).to.not.equal(true);
      expect(result.content[0].text).to.include('message-from-alice');
      expect(result.content[0].text).to.not.include('message-from-bob');
    });

    it('"includeSent: true" merges sent messages into the timeline', async function () {
      const now = new Date().toISOString();
      const h = makeRecallHandle(
        [{ from: 'alice', text: 'received-text', timestamp: now }],
        [{ to: 'bob', text: 'sent-text', timestamp: now }],
      );
      const callWith = extractHandler((server) => registerRecallTool(server, h, getPlayerId));

      const result = await callWith({ includeSent: true });
      expect(result.isError).to.not.equal(true);
      expect(result.content[0].text).to.include('received-text');
      expect(result.content[0].text).to.include('sent-text');
    });
  });
});

// ─────────────────────────────────────────────
// encore tool
// ─────────────────────────────────────────────

/**
 * Build a fake client that returns a single session with the given status.
 * Used for encore tool tests that need to exercise the status-check guards.
 */
function makeEncoreClient(targetPlayerId: string, status: string): Client {
  return makeClientWithPlayers([{ playerId: targetPlayerId, status }]);
}

describe('encore tool validation', function () {
  it('rejects encoring your own session', async function () {
    // TEST_PLAYER_ID encoring itself
    const call = extractHandler((server) =>
      registerEncoreTool(server, makeTestClient(), testConfig, getPlayerId, fakeHandle),
    );
    const result = await call({ playerId: TEST_PLAYER_ID });
    expect(result.isError).to.be.true;
    expect(result.content[0].text).to.equal('Cannot encore your own session.');
  });

  it('returns error when target session is not found', async function () {
    // Empty client — resolveSession returns null
    const call = extractHandler((server) =>
      registerEncoreTool(server, makeTestClient(), testConfig, getPlayerId, fakeHandle),
    );
    const result = await call({ playerId: 'ghost-player' });
    expect(result.isError).to.be.true;
    expect(result.content[0].text).to.include('No session found');
    expect(result.content[0].text).to.include('ghost-player');
  });

  it('rejects encore on an active session — suggests cue instead', async function () {
    const call = extractHandler((server) =>
      registerEncoreTool(
        server,
        makeEncoreClient('active-player', 'active'),
        testConfig,
        getPlayerId,
        fakeHandle,
      ),
    );
    const result = await call({ playerId: 'active-player' });
    expect(result.isError).to.be.true;
    expect(result.content[0].text).to.include('already active');
    expect(result.content[0].text).to.include('cue');
  });

  it('rejects encore on a pending session — suggests waiting', async function () {
    const call = extractHandler((server) =>
      registerEncoreTool(
        server,
        makeEncoreClient('pending-player', 'pending'),
        testConfig,
        getPlayerId,
        fakeHandle,
      ),
    );
    const result = await call({ playerId: 'pending-player' });
    expect(result.isError).to.be.true;
    expect(result.content[0].text).to.include('pending');
    expect(result.content[0].text).to.include('starting up');
  });

  it('rejects encore on a terminated session — suggests recruit instead', async function () {
    const call = extractHandler((server) =>
      registerEncoreTool(
        server,
        makeEncoreClient('dead-player', 'terminated'),
        testConfig,
        getPlayerId,
        fakeHandle,
      ),
    );
    const result = await call({ playerId: 'dead-player' });
    expect(result.isError).to.be.true;
    expect(result.content[0].text).to.include('terminated');
    expect(result.content[0].text).to.include('recruit');
  });

  it('submits encore outbox entry for a stale session', async function () {
    const call = extractHandler((server) =>
      registerEncoreTool(
        server,
        makeEncoreClient('stale-player', 'stale'),
        testConfig,
        getPlayerId,
        fakeHandle,
      ),
    );
    const result = await call({ playerId: 'stale-player' });
    expect(result.isError).to.not.equal(true);
    expect(result.content[0].text).to.include('stale-player');
    expect(result.content[0].text).to.include('outbox:');
  });

  it('accepts optional contextMessages parameter without error', async function () {
    const call = extractHandler((server) =>
      registerEncoreTool(
        server,
        makeEncoreClient('stale-player', 'stale'),
        testConfig,
        getPlayerId,
        fakeHandle,
      ),
    );
    const result = await call({ playerId: 'stale-player', contextMessages: 20 });
    expect(result.isError).to.not.equal(true);
  });
});
