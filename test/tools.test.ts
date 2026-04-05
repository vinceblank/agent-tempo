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
 *   - load_lineup: argument mutual exclusion
 */
import { expect } from 'chai';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Client, WorkflowHandle } from '@temporalio/client';
import type { Config } from '../src/config';
import { registerRecruitTool } from '../src/tools/recruit';
import { registerScheduleTool } from '../src/tools/schedule';
import { registerStopTool } from '../src/tools/stop';
import { registerLoadLineupTool } from '../src/tools/load-lineup';

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
