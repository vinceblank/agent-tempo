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
import type { SessionMetadata } from '../src/types';
import { registerRecruitTool } from '../src/tools/recruit';
import { registerScheduleTool } from '../src/tools/schedule';
import { registerLoadLineupTool } from '../src/tools/load-lineup';
import { registerBroadcastTool } from '../src/tools/broadcast';
import { registerRecallTool } from '../src/tools/recall';
import { registerRestartTool } from '../src/tools/restart';
import { registerDestroyTool } from '../src/tools/destroy';
import { registerMigrateTool } from '../src/tools/migrate';
import { registerAttachmentInfoTool } from '../src/tools/attachment-info';
import { registerPlayTool } from '../src/tools/play';

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
  ensemble: 'test-ensemble-tools-mock',
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
// stop tool — removed in PR-H (#132). The v0.25.1 deprecation shim is gone;
// callers now use detach/destroy/restart directly.
// ─────────────────────────────────────────────

describe('recruit tool force-terminate existing', function () {
  it('force-terminates existing session before recruiting', async function () {
    let terminatedWith: string | undefined;
    const clientWithSession = {
      workflow: {
        getHandle: (_id: string) => ({
          describe: async () => { throw new Error('workflow not found'); },
          query: async (name: string) => {
            if (name === 'getMetadata') return { ensemble: 'test-ensemble-tools-mock', playerId: 'existing-player' } as any;
            return '';
          },
          signal: async () => {},
          terminate: async (reason: string) => { terminatedWith = reason; },
        }),
        start: async () => ({ runId: 'fake-run-id' }),
        list: async function* () {
          yield { workflowId: 'wf-existing' };
        },
      },
    } as unknown as Client;

    const call = extractHandler((server) =>
      registerRecruitTool(server, clientWithSession, testConfig, getPlayerId, fakeHandle, 'claude'),
    );

    const result = await call({ workDir: '/tmp', name: 'existing-player', force: true });
    // Should proceed past the existing session check (force-terminated it)
    expect(terminatedWith).to.include('Force-terminated');
    // Should reach the outbox submit (recruit succeeds)
    expect(result.isError).to.be.undefined;
    expect(result.content[0].text).to.include('Recruit request submitted');
  });

  it('without force, rejects when session already exists', async function () {
    const clientWithSession = {
      workflow: {
        getHandle: (_id: string) => ({
          describe: async () => { throw new Error('workflow not found'); },
          query: async (name: string) => {
            if (name === 'getMetadata') return { ensemble: 'test-ensemble-tools-mock', playerId: 'existing-player' } as any;
            return '';
          },
          signal: async () => {},
        }),
        start: async () => ({ runId: 'fake-run-id' }),
        list: async function* () {
          yield { workflowId: 'wf-existing' };
        },
      },
    } as unknown as Client;

    const call = extractHandler((server) =>
      registerRecruitTool(server, clientWithSession, testConfig, getPlayerId, fakeHandle, 'claude'),
    );

    const result = await call({ workDir: '/tmp', name: 'existing-player' });
    expect(result.isError).to.be.true;
    expect(result.content[0].text).to.include('already active');
    expect(result.content[0].text).to.include('force: true');
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

describe('load_lineup conductor section', function () {
  const { writeFileSync, mkdirSync, rmSync } = require('fs');
  const { join } = require('path');

  // Use a subdir of cwd so safeLineupPath allows access
  let tmpDir: string;

  before(function () {
    tmpDir = join(process.cwd(), `.test-lineup-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  after(function () {
    try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  });

  it('applies conductor name, type, and instructions from lineup', async function () {
    // Write a lineup YAML with conductor section
    const lineupPath = join(tmpDir, 'test-conductor.yaml');
    writeFileSync(lineupPath, [
      'name: test-conductor-lineup',
      'conductor:',
      '  name: my-conductor',
      '  instructions: "You are the lead conductor."',
      'players: []',
    ].join('\n'));

    // Track signals sent to the conductor handle
    const signals: Array<{ name: string; args: any }> = [];
    const conductorHandle = {
      workflowId: `claude-session-${testConfig.ensemble}-conductor`,
      executeUpdate: async () => 'fake-entry-id',
      signal: async (name: string, ...args: any[]) => { signals.push({ name, args: args[0] }); },
      describe: async () => ({ status: { name: 'RUNNING' } }),
    } as unknown as WorkflowHandle;

    // Fake client whose resolveSession returns null (name not taken)
    const clientForConductor = {
      workflow: {
        getHandle: () => conductorHandle,
        start: async () => ({ runId: 'fake' }),
        list: async function* () { /* no workflows */ },
      },
    } as unknown as Client;

    let updatedPlayerId = '';
    const call = extractHandler((server) =>
      registerLoadLineupTool(
        server, clientForConductor, testConfig, getPlayerId, 'claude',
        conductorHandle,
        (id: string) => { updatedPlayerId = id; },
        true, // isConductor
      ),
    );

    const result = await call({ path: lineupPath });
    expect(result.isError).to.be.undefined;
    expect(result.content[0].text).to.include('test-conductor-lineup');
    expect(result.content[0].text).to.include('Conductor:');
    expect(result.content[0].text).to.include('my-conductor');
    expect(result.content[0].text).to.include('instructions delivered');

    // Verify setName signal was sent
    const setNameSignal = signals.find(s => s.name === 'setName');
    expect(setNameSignal).to.exist;
    expect(setNameSignal!.args).to.equal('my-conductor');

    // Verify setPlayerId was called
    expect(updatedPlayerId).to.equal('my-conductor');

    // Verify instructions were sent via receiveMessage
    const msgSignal = signals.find(s => s.name === 'receiveMessage');
    expect(msgSignal).to.exist;
    expect(msgSignal!.args.text).to.equal('You are the lead conductor.');
    expect(msgSignal!.args.from).to.equal('lineup');
  });

  it('skips conductor section for non-conductor sessions', async function () {
    const lineupPath = join(tmpDir, 'test-skip.yaml');
    writeFileSync(lineupPath, [
      'name: test-skip-lineup',
      'conductor:',
      '  name: my-conductor',
      '  instructions: "Hello"',
      'players: []',
    ].join('\n'));

    const signals: Array<{ name: string; args: any }> = [];
    const handle = {
      executeUpdate: async () => 'fake-entry-id',
      signal: async (name: string, ...args: any[]) => { signals.push({ name, args: args[0] }); },
    } as unknown as WorkflowHandle;

    const call = extractHandler((server) =>
      registerLoadLineupTool(
        server, makeTestClient(), testConfig, getPlayerId, 'claude',
        handle,
        () => {},
        false, // NOT conductor
      ),
    );

    const result = await call({ path: lineupPath });
    expect(result.isError).to.be.undefined;
    expect(result.content[0].text).to.not.include('Conductor:');
    // No signals should have been sent for conductor section
    expect(signals).to.have.length(0);
  });

  // ── Issue #172 (v0.26 simplification): initial-startup seeds messages + pauses ──

  it('initialStartup=true: signals lineup instructions + banner/directive and pauses the ensemble', async function () {
    const lineupPath = join(tmpDir, 'test-initial-startup.yaml');
    writeFileSync(lineupPath, [
      'name: test-initial-startup',
      'conductor:',
      '  instructions: "You are the lead conductor."',
      'players:',
      '  - name: alice',
      '    workDir: /tmp/test',
      '    instructions: "Be helpful"',
    ].join('\n'));

    const signals: Array<{ name: string; args: any }> = [];
    const updates: Array<{ name: any; args: any }> = [];
    const conductorHandle = {
      workflowId: `claude-session-${testConfig.ensemble}-conductor`,
      executeUpdate: async (name: any, opts: any) => {
        // `name` is the UpdateDefinition object produced by defineUpdate —
        // fall back to plain-string for callers that use the string form.
        const uname = typeof name === 'string' ? name : (name?.name || 'unknown');
        updates.push({ name: uname, args: opts?.args?.[0] });
        return 'fake-entry-id';
      },
      signal: async (name: string, ...args: any[]) => { signals.push({ name, args: args[0] }); },
      describe: async () => ({ status: { name: 'RUNNING' } }),
    } as unknown as WorkflowHandle;

    const clientForConductor = {
      workflow: {
        getHandle: () => conductorHandle,
        start: async () => ({ runId: 'fake' }),
        list: async function* () { /* no workflows */ },
      },
    } as unknown as Client;

    const call = extractHandler((server) =>
      registerLoadLineupTool(
        server, clientForConductor, testConfig, getPlayerId, 'claude',
        conductorHandle,
        () => {},
        true, // isConductor
      ),
    );

    const result = await call({ path: lineupPath, initialStartup: true });
    expect(result.isError).to.be.undefined;

    // Issue #172 follow-up: the tool fires two `receiveMessage` signals in
    // a deliberate order — the `from: 'system'` directive FIRST so the LLM
    // reads the "call resume_ensemble + release FIRST" framing before the
    // lineup's role/phase briefing. Earlier messages weigh more heavily.
    //   1. banner + directive (`from: 'system'`)
    //   2. lineup instructions (`from: 'lineup'`)
    const receiveMessages = signals.filter((s) => s.name === 'receiveMessage');
    const lineupSignal = receiveMessages.find((s) => s.args?.from === 'lineup');
    expect(lineupSignal, 'lineup instructions signal should have fired').to.exist;
    expect(lineupSignal!.args.text).to.equal('You are the lead conductor.');
    expect(lineupSignal!.args.responseRequested).to.equal(false);

    const banner = receiveMessages.find((s) => s.args?.from === 'system');
    expect(banner, 'banner+directive signal should have fired').to.exist;
    expect(banner!.args.text).to.include('is ready');
    expect(banner!.args.text).to.include('Describe your task to begin');
    // The directive text itself drives the hold — the LLM reads "wait
    // silently" + "call resume_ensemble FIRST" and honors it.
    expect(banner!.args.text.toLowerCase()).to.include('resume_ensemble');
    expect(banner!.args.text.toLowerCase()).to.include('wait');
    expect(banner!.args.responseRequested).to.equal(false);

    // Lock in the ordering: system directive must fire BEFORE lineup
    // instructions. A regression that silently reorders them would
    // re-introduce the "LLM skims past the directive" failure mode.
    const systemIdx = receiveMessages.findIndex((s) => s.args?.from === 'system');
    const lineupIdx = receiveMessages.findIndex((s) => s.args?.from === 'lineup');
    expect(systemIdx).to.be.lessThan(lineupIdx, 'system directive must be signalled before lineup instructions');

    // No `setPendingStartupContext` update — the simpler design has no
    // workflow-level state for this.
    const pending = updates.find((u) => u.name === 'setPendingStartupContext');
    expect(pending, 'setPendingStartupContext must NOT be called in the simplified design').to.be.undefined;

    // Issue #172 simplification: the whole ensemble must be paused — the
    // maestro `maestroSetPaused` and scheduler `setSchedulerPaused` signals
    // should have fired. (Per-session `setPaused` signals depend on the
    // `list` generator returning sessions — this mock yields none, so only
    // the maestro + scheduler signals are observable here.)
    const maestroPause = signals.find((s) => s.name === 'maestroSetPaused');
    expect(maestroPause, 'maestro pause signal should have fired on initial startup').to.exist;
    expect(maestroPause!.args).to.equal(true);
    const schedulerPause = signals.find((s) => s.name === 'setSchedulerPaused');
    expect(schedulerPause, 'scheduler pause signal should have fired on initial startup').to.exist;
    expect(schedulerPause!.args).to.equal(true);
  });

  it('initialStartup=false (default): preserves legacy immediate-signal behavior, no banner or pause', async function () {
    const lineupPath = join(tmpDir, 'test-legacy-startup.yaml');
    writeFileSync(lineupPath, [
      'name: test-legacy-startup',
      'conductor:',
      '  instructions: "Legacy instructions"',
      'players: []',
    ].join('\n'));

    const signals: Array<{ name: string; args: any }> = [];
    const updates: Array<{ name: any; args: any }> = [];
    const conductorHandle = {
      workflowId: `claude-session-${testConfig.ensemble}-conductor`,
      executeUpdate: async (name: any, opts: any) => {
        const uname = typeof name === 'string' ? name : (name.name || 'unknown');
        updates.push({ name: uname, args: opts?.args?.[0] });
        return 'fake-entry-id';
      },
      signal: async (name: string, ...args: any[]) => { signals.push({ name, args: args[0] }); },
      describe: async () => ({ status: { name: 'RUNNING' } }),
    } as unknown as WorkflowHandle;

    const clientForConductor = {
      workflow: {
        getHandle: () => conductorHandle,
        start: async () => ({ runId: 'fake' }),
        list: async function* () { /* no workflows */ },
      },
    } as unknown as Client;

    const call = extractHandler((server) =>
      registerLoadLineupTool(
        server, clientForConductor, testConfig, getPlayerId, 'claude',
        conductorHandle,
        () => {},
        true, // isConductor
      ),
    );

    const result = await call({ path: lineupPath });
    expect(result.isError).to.be.undefined;
    expect(result.content[0].text).to.include('instructions delivered');

    // Legacy path: instructions arrive as a receiveMessage signal.
    const instructionsSignal = signals.find(
      (s) => s.name === 'receiveMessage' && s.args?.from === 'lineup',
    );
    expect(instructionsSignal, 'legacy path must signal instructions immediately').to.exist;
    expect(instructionsSignal!.args.text).to.equal('Legacy instructions');

    // Legacy path must NOT deliver the initial-startup banner+directive.
    const banner = signals.find(
      (s) => s.name === 'receiveMessage' && s.args?.from === 'system',
    );
    expect(banner, 'legacy path must not deliver the initial-startup banner').to.be.undefined;

    // setPendingStartupContext must NOT have been called.
    const pending = updates.find((u) => u.name === 'setPendingStartupContext');
    expect(pending, 'setPendingStartupContext must NOT be called').to.be.undefined;

    // Legacy path must NOT pause the ensemble — that's initial-startup only.
    const maestroPause = signals.find((s) => s.name === 'maestroSetPaused');
    expect(maestroPause, 'legacy path must not pause the ensemble').to.be.undefined;
    const schedulerPause = signals.find((s) => s.name === 'setSchedulerPaused');
    expect(schedulerPause, 'legacy path must not pause the scheduler').to.be.undefined;
  });

  it('sends hold standby to conductor with a bare conductor section (no instructions)', async function () {
    // Bare `conductor: {}` block — no instructions to deliver.
    const lineupPath = join(tmpDir, 'test-hold-bare-conductor.yaml');
    writeFileSync(lineupPath, [
      'name: test-hold-no-cond',
      'conductor: {}',
      'players:',
      '  - name: alice',
      '    workDir: /tmp/test',
    ].join('\n'));

    const signals: Array<{ name: string; args: any }> = [];
    const conductorHandle = {
      workflowId: `claude-session-${testConfig.ensemble}-conductor`,
      executeUpdate: async () => 'fake-entry-id',
      signal: async (name: string, ...args: any[]) => { signals.push({ name, args: args[0] }); },
      describe: async () => ({ status: { name: 'RUNNING' } }),
    } as unknown as WorkflowHandle;

    const clientForConductor = {
      workflow: {
        getHandle: () => conductorHandle,
        start: async () => ({ runId: 'fake' }),
        list: async function* () { /* no workflows */ },
      },
    } as unknown as Client;

    const call = extractHandler((server) =>
      registerLoadLineupTool(
        server, clientForConductor, testConfig, getPlayerId, 'claude',
        conductorHandle,
        () => {},
        true, // isConductor
      ),
    );

    const result = await call({ path: lineupPath, hold: true });
    expect(result.isError).to.be.undefined;
    expect(result.content[0].text).to.include('hold mode standby');

    // Verify the hold standby message was sent via receiveMessage
    const msgSignal = signals.find((s) => s.name === 'receiveMessage');
    expect(msgSignal).to.exist;
    expect(msgSignal!.args.from).to.equal('system');
    expect(msgSignal!.args.text).to.include('hold mode');
    expect(msgSignal!.args.text).to.include('release');
    expect(msgSignal!.args.responseRequested).to.equal(false);
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
    /** Attachment phase exposed via `ClaudeTempoAttachmentState` search attribute.
     *  Defaults to `'attached'` (the "live, deliverable" phase) when omitted. */
    phase?: 'booting' | 'attached' | 'processing' | 'awaiting' | 'draining' | 'detached' | 'gone';
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
              playerType: player?.playerType,
            } satisfies SessionMetadata;
          }
          throw new Error(`Unexpected query: ${queryName}`);
        },
        executeUpdate: async () => 'fake-entry-id',
      }),
      start: async () => ({ runId: 'fake-run-id' }),
      list: async function* () {
        // Broadcast/ensemble filtering reads phase from the
        // `ClaudeTempoAttachmentState` search attribute (v0.26).
        for (const p of players) {
          yield {
            workflowId: `claude-session-${testConfig.ensemble}-${p.playerId}`,
            searchAttributes: {
              ClaudeTempoAttachmentState: [p.phase ?? 'attached'],
            },
          };
        }
      },
    },
  } as unknown as Client;
}

describe('broadcast tool validation', function () {
  it('returns success (not error) when no active players match (empty ensemble)', async function () {
    const call = extractHandler((server) =>
      registerBroadcastTool(server, makeTestClient(), testConfig, getPlayerId, fakeHandle),
    );
    const result = await call({ message: 'hello everyone' });
    expect(result.isError).to.not.equal(true);
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
          { playerId: 'stale-player', phase: 'detached' },
          { playerId: 'active-player', phase: 'attached' },
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
          { playerId: 'stale-player', phase: 'detached' },
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

  it('excludes pending sessions', async function () {
    const call = extractHandler((server) =>
      registerBroadcastTool(
        server,
        makeClientWithPlayers([
          { playerId: 'pending-player', phase: 'booting' },
          { playerId: 'active-player', phase: 'attached' },
        ]),
        testConfig,
        getPlayerId,
        fakeHandle,
      ),
    );
    const result = await call({ message: 'hello' });
    expect(result.isError).to.not.equal(true);
    expect(result.content[0].text).to.include('active-player');
    expect(result.content[0].text).to.not.include('pending-player');
  });

  it('excludes terminated sessions', async function () {
    const call = extractHandler((server) =>
      registerBroadcastTool(
        server,
        makeClientWithPlayers([
          { playerId: 'terminated-player', phase: 'gone' },
          { playerId: 'active-player', phase: 'attached' },
        ]),
        testConfig,
        getPlayerId,
        fakeHandle,
      ),
    );
    const result = await call({ message: 'hello' });
    expect(result.isError).to.not.equal(true);
    expect(result.content[0].text).to.include('active-player');
    expect(result.content[0].text).to.not.include('terminated-player');
  });

  it('excludes pending and terminated even when includeStale is true', async function () {
    const call = extractHandler((server) =>
      registerBroadcastTool(
        server,
        makeClientWithPlayers([
          { playerId: 'pending-player', phase: 'booting' },
          { playerId: 'terminated-player', phase: 'gone' },
          { playerId: 'stale-player', phase: 'detached' },
        ]),
        testConfig,
        getPlayerId,
        fakeHandle,
      ),
    );
    const result = await call({ message: 'hello', includeStale: true });
    expect(result.isError).to.not.equal(true);
    // Only stale should be included
    expect(result.content[0].text).to.include('stale-player');
    expect(result.content[0].text).to.not.include('pending-player');
    expect(result.content[0].text).to.not.include('terminated-player');
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
      // #128 replaced the "<N> messages:" header with gh-style pagination.
      expect(result.content[0].text).to.match(/^Showing 1-5 of 25 messages\. Use offset: 5 for next page\./);
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

// (encore tool deleted in PR-D — restart replaces it.)

// ─────────────────────────────────────────────
// PR-D verb tools — happy paths over PR-A primitives
// ─────────────────────────────────────────────

/**
 * Build a test client whose single session supports the full V2 attachment
 * lifecycle surface (attachmentInfo query, requestDetach signal, forceDetach +
 * claimAttachment + destroy + enqueueSpawn updates, getMetadata/getPart/allMessages
 * queries, receiveMessage signal). Records signals + updates for assertions.
 */
function makeV2Client(opts: {
  playerId: string;
  phase?: 'booting' | 'attached' | 'processing' | 'awaiting' | 'draining' | 'detached' | 'gone';
  currentAttachmentId?: string;
  hostname?: string;
  agentType?: 'claude' | 'copilot';
} = { playerId: 'target' }) {
  const playerId = opts.playerId;
  const phase = opts.phase ?? 'detached';
  const hostname = opts.hostname ?? 'test-host';
  const agentType = opts.agentType ?? 'claude';

  const attachmentInfo = {
    phase,
    inFlightCount: 0,
    ...(opts.currentAttachmentId
      ? {
          currentAttachment: {
            attachmentId: opts.currentAttachmentId,
            hostname,
            adapterId: agentType === 'copilot' ? 'copilot' : 'claude-code',
            adapterClass: agentType === 'copilot' ? 'sdk' : 'interactive',
            claimedAt: '2026-01-01T00:00:00Z',
            lastHeartbeatAt: '2026-01-01T00:00:00Z',
            expiresAt: new Date(Date.now() + 90_000).toISOString(),
            leaseMs: 90_000,
            runId: 'old-run',
          },
        }
      : {}),
  };

  const signals: Array<{ name: string; args: unknown }> = [];
  const updates: Array<{ name: string; args: unknown }> = [];

  const asName = (nameOrDef: unknown): string =>
    typeof nameOrDef === 'string' ? nameOrDef : (nameOrDef as { name: string }).name;

  const handle = {
    workflowId: `claude-session-test-ensemble-${playerId}`,
    signals,
    updates,
    async signal(nameOrDef: unknown, args: unknown) {
      signals.push({ name: asName(nameOrDef), args });
    },
    async query(nameOrDef: unknown) {
      const name = asName(nameOrDef);
      if (name === 'getMetadata') {
        return {
          playerId,
          ensemble: 'test-ensemble-tools-mock',
          hostname,
          workDir: '/work',
          isConductor: false,
          agentType,
          adapterId: agentType === 'copilot' ? 'copilot' : 'claude-code',
          sessionId: 'sess-uuid',
        };
      }
      if (name === 'getPart') return 'working on stuff';
      if (name === 'allMessages') return [];
      if (name === 'attachmentInfo') return attachmentInfo;
      return undefined;
    },
    async executeUpdate(nameOrDef: unknown, updateOpts: { args: unknown[] }) {
      const name = asName(nameOrDef);
      updates.push({ name, args: updateOpts.args[0] });
      if (name === 'destroy') return undefined;
      if (name === 'forceDetach') return { reaped: true, previousAttachmentId: opts.currentAttachmentId };
      if (name === 'claimAttachment') {
        return {
          attachmentId: 'new-attach-abc12345',
          runId: 'new-run-xyz98765',
          expiresAt: new Date(Date.now() + 90_000).toISOString(),
          leaseMs: 90_000,
        };
      }
      if (name === 'enqueueSpawn') return { spawnEntryId: 'spawn-entry-111' };
      return undefined;
    },
  };

  const client = {
    workflow: {
      getHandle: (_id: string) => handle,
      list: async function* () { yield { workflowId: handle.workflowId }; },
    },
  } as unknown as Client;

  return { client, handle };
}

describe('attachment_info tool', function () {
  it('formats phase + attachment details for an attached session', async function () {
    const { client } = makeV2Client({
      playerId: 'alice',
      phase: 'attached',
      currentAttachmentId: 'attach-abc',
      hostname: 'host-1',
    });
    const call = extractHandler((server) =>
      registerAttachmentInfoTool(server, client, testConfig),
    );
    const result = await call({ playerId: 'alice' });
    expect(result.isError).to.not.equal(true);
    expect(result.content[0].text).to.include('alice');
    expect(result.content[0].text).to.include('attached');
    expect(result.content[0].text).to.include('host-1');
  });
});

/**
 * Build a fake caller-workflow handle that records `submitOutbox` entries.
 * PR-D verb tools (detach/destroy/restart/migrate) now enqueue instead of
 * calling directly — tests assert the entry shape on this capture.
 */
function makeCaptureHandle(): { handle: WorkflowHandle; entries: Array<{ name: string; args: unknown }> } {
  const entries: Array<{ name: string; args: unknown }> = [];
  const asName = (nameOrDef: unknown): string =>
    typeof nameOrDef === 'string' ? nameOrDef : (nameOrDef as { name: string }).name;
  const handle = {
    executeUpdate: async (nameOrDef: unknown, opts: { args: unknown[] }) => {
      entries.push({ name: asName(nameOrDef), args: opts.args[0] });
      return `entry-${entries.length}`;
    },
  } as unknown as WorkflowHandle;
  return { handle, entries };
}

describe('destroy tool (outbox-queued, QA B2)', function () {
  it('enqueues DestroyOutboxEntry with reason + notifyConductor', async function () {
    const { client } = makeV2Client({ playerId: 'dave' });
    const { handle, entries } = makeCaptureHandle();
    const call = extractHandler((server) =>
      registerDestroyTool(server, client, testConfig, getPlayerId, handle),
    );
    const result = await call({ playerId: 'dave', reason: 'debug cleanup' });
    expect(result.isError).to.not.equal(true);
    expect(entries).to.have.length(1);
    const entry = entries[0].args as any;
    expect(entry.type).to.equal('destroy');
    expect(entry.targetPlayerId).to.equal('dave');
    expect(entry.reason).to.equal('debug cleanup');
    expect(entry.notifyConductor).to.be.true;
  });

  it('rejects self-destroy before enqueueing', async function () {
    const { client } = makeV2Client({ playerId: TEST_PLAYER_ID });
    const { handle, entries } = makeCaptureHandle();
    const call = extractHandler((server) =>
      registerDestroyTool(server, client, testConfig, getPlayerId, handle),
    );
    const result = await call({ playerId: TEST_PLAYER_ID });
    expect(result.isError).to.be.true;
    expect(entries).to.have.length(0);
  });
});

describe('restart tool (outbox-queued, QA B3)', function () {
  it('enqueues RestartOutboxEntry with invokerPlayerId + defaults', async function () {
    const { client } = makeV2Client({ playerId: 'eve' });
    const { handle, entries } = makeCaptureHandle();
    const call = extractHandler((server) =>
      registerRestartTool(server, client, testConfig, getPlayerId, handle),
    );
    const result = await call({ playerId: 'eve' });
    expect(result.isError).to.not.equal(true);
    const entry = entries[0].args as any;
    expect(entry.type).to.equal('restart');
    expect(entry.targetPlayerId).to.equal('eve');
    expect(entry.invokerPlayerId).to.equal(TEST_PLAYER_ID);
    expect(entry.host).to.be.undefined;
    expect(entry.fresh).to.be.undefined;
    expect(entry.force).to.be.undefined;
  });

  it('forwards force + fresh + host + contextMessages to the entry', async function () {
    const { client } = makeV2Client({ playerId: 'frank' });
    const { handle, entries } = makeCaptureHandle();
    const call = extractHandler((server) =>
      registerRestartTool(server, client, testConfig, getPlayerId, handle),
    );
    await call({ playerId: 'frank', fresh: true, force: true, host: 'h1', contextMessages: 20 });
    const entry = entries[0].args as any;
    expect(entry.fresh).to.be.true;
    expect(entry.force).to.be.true;
    expect(entry.host).to.equal('h1');
    expect(entry.contextMessages).to.equal(20);
  });

  // (contextMessages max-range enforcement is a Zod schema concern handled at
  //  MCP-level validation; the extractHandler harness bypasses the schema so
  //  unit-testing that bound would be testing the wrong layer. See
  //  RESTART_CONTEXT_MESSAGES_MAX in src/utils/validation.ts.)
});

describe('migrate tool (outbox-queued, QA B3)', function () {
  it('enqueues RestartOutboxEntry with required host', async function () {
    const { client } = makeV2Client({ playerId: 'ian' });
    const { handle, entries } = makeCaptureHandle();
    const call = extractHandler((server) =>
      registerMigrateTool(server, client, testConfig, getPlayerId, handle),
    );
    const result = await call({ playerId: 'ian', host: 'other-host' });
    expect(result.isError).to.not.equal(true);
    const entry = entries[0].args as any;
    expect(entry.type).to.equal('restart');
    expect(entry.host).to.equal('other-host');
    expect(entry.targetPlayerId).to.equal('ian');
  });

  it('rejects empty host before enqueueing', async function () {
    const { client } = makeV2Client({ playerId: 'jen' });
    const { handle, entries } = makeCaptureHandle();
    const call = extractHandler((server) =>
      registerMigrateTool(server, client, testConfig, getPlayerId, handle),
    );
    const result = await call({ playerId: 'jen', host: '   ' });
    expect(result.isError).to.be.true;
    expect(result.content[0].text).to.include('host');
    expect(entries).to.have.length(0);
  });
});

// ─────────────────────────────────────────────
// resume_ensemble tool — `release` arg (Issue #172 final fix)
// ─────────────────────────────────────────────

/**
 * Build a fake client that yields the given player IDs from `workflow.list()`
 * and captures every signal sent to any handle. Used to verify the
 * `resume_ensemble` tool fans out (or doesn't fan out) `releaseHeld`.
 */
function makeResumeClient(players: string[]): {
  client: Client;
  signals: Array<{ workflowId: string; name: string; payload: unknown }>;
} {
  const signals: Array<{ workflowId: string; name: string; payload: unknown }> = [];
  const client = {
    workflow: {
      getHandle: (workflowId: string) => ({
        // Temporal's `handle.signal` accepts either a string signal name OR a
        // SignalDefinition `{ name, type }`. Normalize to the string form so
        // tests can filter on `s.name === 'signalName'` regardless of which
        // form the tool uses.
        signal: async (nameOrDef: string | { name: string }, ...args: unknown[]) => {
          const name = typeof nameOrDef === 'string' ? nameOrDef : nameOrDef.name;
          signals.push({ workflowId, name, payload: args[0] });
        },
        // `scanEnsembleSessions` calls `getMetadata` + `getPart` on each
        // listed workflow; return minimal valid shapes keyed off the
        // workflowId so the scan doesn't swallow the session.
        query: async (queryName: string) => {
          const playerId = workflowId.replace(`claude-session-${testConfig.ensemble}-`, '');
          if (queryName === 'getMetadata') {
            return {
              playerId,
              ensemble: testConfig.ensemble,
              hostname: 'test-host',
              workDir: '/tmp',
              isConductor: false,
              agentType: 'claude',
            } satisfies SessionMetadata;
          }
          if (queryName === 'getPart') return 'no description';
          throw new Error(`Unexpected query: ${queryName}`);
        },
      }),
      list: async function* () {
        for (const p of players) {
          yield {
            workflowId: `claude-session-${testConfig.ensemble}-${p}`,
            searchAttributes: { ClaudeTempoPlayerId: [p] },
          };
        }
      },
    },
  } as unknown as Client;
  return { client, signals };
}

describe('play tool — release arg (Issue #172, renamed from resume_ensemble per #287)', function () {
  it('default (release omitted): unpause signals only, NO releaseHeld fan-out', async function () {
    const { client, signals } = makeResumeClient(['alice', 'bob']);
    const call = extractHandler((server) =>
      registerPlayTool(server, client, testConfig, getPlayerId),
    );

    const result = await call({});
    expect(result.isError).to.not.equal(true);

    // Should signal maestro (unpause), each session's setPaused(false), and scheduler unpause.
    const maestroUnpause = signals.find((s) => s.name === 'maestroSetPaused');
    expect(maestroUnpause, 'maestro should be unpaused').to.exist;
    expect(maestroUnpause!.payload).to.equal(false);

    const schedulerUnpause = signals.find((s) => s.name === 'setSchedulerPaused');
    expect(schedulerUnpause, 'scheduler should be unpaused').to.exist;
    expect(schedulerUnpause!.payload).to.equal(false);

    const setPausedCalls = signals.filter((s) => s.name === 'setPaused');
    expect(setPausedCalls).to.have.lengthOf(2); // one per session
    for (const sp of setPausedCalls) expect(sp.payload).to.equal(false);

    // Key assertion: NO releaseHeld should have fired in the default path.
    const releaseHeldCalls = signals.filter((s) => s.name === 'releaseHeld');
    expect(releaseHeldCalls, 'release must be opt-in — no releaseHeld without release: true').to.have.lengthOf(0);
  });

  it('release: false explicitly: identical to default — no releaseHeld', async function () {
    const { client, signals } = makeResumeClient(['alice']);
    const call = extractHandler((server) =>
      registerPlayTool(server, client, testConfig, getPlayerId),
    );

    await call({ release: false });
    const releaseHeldCalls = signals.filter((s) => s.name === 'releaseHeld');
    expect(releaseHeldCalls).to.have.lengthOf(0);
  });

  it('release: true: fans out releaseHeld to every active session', async function () {
    const { client, signals } = makeResumeClient(['alice', 'bob', 'carol']);
    const call = extractHandler((server) =>
      registerPlayTool(server, client, testConfig, getPlayerId),
    );

    const result = await call({ release: true });
    expect(result.isError).to.not.equal(true);

    // All three should receive both setPaused(false) AND releaseHeld.
    const setPausedCalls = signals.filter((s) => s.name === 'setPaused');
    expect(setPausedCalls).to.have.lengthOf(3);

    const releaseHeldCalls = signals.filter((s) => s.name === 'releaseHeld');
    expect(releaseHeldCalls).to.have.lengthOf(3);

    // Each of alice/bob/carol should have been targeted exactly once for release.
    const targeted = new Set(
      releaseHeldCalls.map((s) =>
        s.workflowId.replace(`claude-session-${testConfig.ensemble}-`, ''),
      ),
    );
    expect(targeted).to.deep.equal(new Set(['alice', 'bob', 'carol']));

    // The ordering per-session should be setPaused THEN releaseHeld — the
    // handler must not leave sessions in a weird in-between state. We verify
    // the first setPaused call appears before the first releaseHeld call.
    const firstSetPausedIdx = signals.findIndex((s) => s.name === 'setPaused');
    const firstReleaseIdx = signals.findIndex((s) => s.name === 'releaseHeld');
    expect(firstSetPausedIdx).to.be.lessThan(firstReleaseIdx);

    // Success message should mention release.
    expect(result.content[0].text.toLowerCase()).to.include('release');
  });

  it('release: true with no active sessions: still unpauses maestro + scheduler, no fan-out', async function () {
    const { client, signals } = makeResumeClient([]);
    const call = extractHandler((server) =>
      registerPlayTool(server, client, testConfig, getPlayerId),
    );

    const result = await call({ release: true });
    expect(result.isError).to.not.equal(true);

    expect(signals.some((s) => s.name === 'maestroSetPaused')).to.be.true;
    expect(signals.some((s) => s.name === 'setSchedulerPaused')).to.be.true;
    expect(signals.filter((s) => s.name === 'releaseHeld')).to.have.lengthOf(0);
  });
});
