/**
 * Direct unit tests for `src/tools/restart.ts` Zod-schema additions in
 * #334 PR-2 — `loadFromState` and `transcript` fields. Mirrors the
 * `tests/tools/save-state.test.ts` harness style: fake `McpServer` captures
 * the schemas + handler, fake `WorkflowHandle` records `executeUpdate` calls.
 *
 * Coverage:
 *   - Zod accepts `loadFromState: true` / `loadFromState: 'someKey'`
 *   - Zod rejects invalid slot-key strings (regex / length)
 *   - Zod accepts `transcript: 'suppress' | 'replay'`, rejects others
 *   - Both fields propagate through `submitOutbox` payload to the workflow
 *   - Result message reflects the queued restart
 */
import { describe, it, expect } from 'vitest';
import type { Client } from '@temporalio/client';
import type { Config } from '../../src/config';
import { renderToMcp } from '../../src/tools/descriptor';
import { buildRestartTool } from '../../src/tools/restart';
import { captureRegistration, makeFakeUpdateHandle } from './_helpers';

const TEST_CONFIG: Config = {
  temporalAddress: 'localhost:7233',
  temporalNamespace: 'default',
  taskQueue: 'agent-tempo',
  ensemble: 'pstate-restart-test',
  defaultAgent: 'claude',
};

/**
 * `submitOutbox` returns the entry id; `_helpers.makeFakeUpdateHandle`
 * supplies the shared executeUpdate-recording fake.
 */
const makeFakeOwnHandle = () => makeFakeUpdateHandle('entry-1234');

/**
 * Fake Temporal Client whose `workflow.list` yields nothing — that makes
 * `resolveSession` (used by the yes-steal guard) return null, which the guard
 * treats as "no target — let downstream handle it" and allows the call
 * through. We never need a real attachmentInfo response in these tests.
 */
function makeFakeClient(): Client {
  return {
    workflow: {
      list: async function* () {
        // empty
      },
      getHandle: () => ({
        query: async () => { throw new Error('not found'); },
      }),
    },
  } as unknown as Client;
}

describe('restart tool — loadFromState + transcript Zod schema (#334 PR-2)', () => {
  it('Zod schema accepts loadFromState: true', () => {
    const { schemas } = captureRegistration((server) =>
      renderToMcp(server, [buildRestartTool(makeFakeClient(), TEST_CONFIG, () => 'tempo-eng', makeFakeOwnHandle().handle)]),
    );
    expect(schemas.loadFromState.safeParse(true).success).toBe(true);
    expect(schemas.loadFromState.safeParse(false).success).toBe(true);
  });

  it('Zod schema accepts loadFromState: "valid_-key1"', () => {
    const { schemas } = captureRegistration((server) =>
      renderToMcp(server, [buildRestartTool(makeFakeClient(), TEST_CONFIG, () => 'tempo-eng', makeFakeOwnHandle().handle)]),
    );
    expect(schemas.loadFromState.safeParse('main').success).toBe(true);
    expect(schemas.loadFromState.safeParse('valid_-key1').success).toBe(true);
  });

  it('Zod schema rejects loadFromState slot keys with bad characters', () => {
    const { schemas } = captureRegistration((server) =>
      renderToMcp(server, [buildRestartTool(makeFakeClient(), TEST_CONFIG, () => 'tempo-eng', makeFakeOwnHandle().handle)]),
    );
    expect(schemas.loadFromState.safeParse('has space').success).toBe(false);
    expect(schemas.loadFromState.safeParse('bad/slash').success).toBe(false);
    expect(schemas.loadFromState.safeParse('').success).toBe(false);
  });

  it('Zod schema rejects loadFromState slot keys longer than 32 chars', () => {
    const { schemas } = captureRegistration((server) =>
      renderToMcp(server, [buildRestartTool(makeFakeClient(), TEST_CONFIG, () => 'tempo-eng', makeFakeOwnHandle().handle)]),
    );
    const tooLong = 'a'.repeat(33);
    expect(schemas.loadFromState.safeParse(tooLong).success).toBe(false);
    expect(schemas.loadFromState.safeParse('a'.repeat(32)).success).toBe(true);
  });

  it('Zod schema accepts transcript: "suppress" | "replay" only', () => {
    const { schemas } = captureRegistration((server) =>
      renderToMcp(server, [buildRestartTool(makeFakeClient(), TEST_CONFIG, () => 'tempo-eng', makeFakeOwnHandle().handle)]),
    );
    expect(schemas.transcript.safeParse('suppress').success).toBe(true);
    expect(schemas.transcript.safeParse('replay').success).toBe(true);
    expect(schemas.transcript.safeParse('other').success).toBe(false);
    expect(schemas.transcript.safeParse(true).success).toBe(false);
  });

  it('threads loadFromState + transcript through to the submitOutbox payload', async () => {
    const { handle, calls } = makeFakeOwnHandle();
    const { call } = captureRegistration((server) =>
      renderToMcp(server, [buildRestartTool(makeFakeClient(), TEST_CONFIG, () => 'tempo-eng', handle)]),
    );
    const result = await call({
      playerId: 'peer',
      loadFromState: 'bookmark',
      transcript: 'replay',
    });
    expect(result.isError).toBeFalsy();
    expect(calls).toHaveLength(1);
    expect(calls[0].updateName).toBe('submitOutbox');
    expect(calls[0].payload).toMatchObject({
      type: 'restart',
      targetPlayerId: 'peer',
      invokerPlayerId: 'tempo-eng',
      loadFromState: 'bookmark',
      transcript: 'replay',
    });
  });

  it('omits loadFromState + transcript from the payload when not passed (backward compat)', async () => {
    const { handle, calls } = makeFakeOwnHandle();
    const { call } = captureRegistration((server) =>
      renderToMcp(server, [buildRestartTool(makeFakeClient(), TEST_CONFIG, () => 'tempo-eng', handle)]),
    );
    await call({ playerId: 'peer' });
    expect(calls).toHaveLength(1);
    expect(calls[0].payload).not.toHaveProperty('loadFromState');
    expect(calls[0].payload).not.toHaveProperty('transcript');
  });

  it('handles loadFromState: true (boolean form, not string)', async () => {
    const { handle, calls } = makeFakeOwnHandle();
    const { call } = captureRegistration((server) =>
      renderToMcp(server, [buildRestartTool(makeFakeClient(), TEST_CONFIG, () => 'tempo-eng', handle)]),
    );
    await call({ playerId: 'peer', loadFromState: true });
    expect(calls[0].payload.loadFromState).toBe(true);
  });
});
