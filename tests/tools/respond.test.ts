/**
 * Direct unit tests for `src/tools/respond.ts` (#700 P2).
 *
 * `respond` answers a planner's correlated `[Q <id>]` question by writing the
 * maestro Q&A mailbox DIRECTLY (`client.workflow.getHandle(maestro).executeUpdate`).
 * Audit identity (`from`) is `getPlayerId()` — there is NO spoofable `from` arg.
 * Tests cover: executeUpdate payload shape (questionId/from/text), from-is-player
 * (not caller-supplied), Zod questionId/text validation, and error propagation.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Client, WorkflowHandle } from '@temporalio/client';
import { renderToMcp } from '../../src/tools/descriptor';
import { buildRespondTool } from '../../src/tools/respond';
import { captureRegistration } from './_helpers';

function makeFakeClient(impl?: (...args: any[]) => any): {
  client: Client;
  calls: Array<{ updateName: string; payload: any; handleId: string }>;
} {
  const calls: Array<{ updateName: string; payload: any; handleId: string }> = [];
  let lastHandleId = '';
  const handle = {
    executeUpdate: vi.fn(async (def: any, opts: any) => {
      calls.push({
        updateName: typeof def === 'string' ? def : def?.name ?? 'unknown',
        payload: opts?.args?.[0],
        handleId: lastHandleId,
      });
      if (impl) return impl(def, opts);
      return { stored: true };
    }),
  } as unknown as WorkflowHandle;
  const client = {
    workflow: { getHandle: (id: string) => { lastHandleId = id; return handle; } },
  } as unknown as Client;
  return { client, calls };
}

const cfg = { ensemble: 'demo' } as any;

describe('respond tool (#700 P2)', () => {
  it('writes the answer to the maestro handle with {questionId, from, text}', async () => {
    const { client, calls } = makeFakeClient();
    const { call } = captureRegistration((server) =>
      renderToMcp(server, [buildRespondTool(client, cfg, () => 'tempo-eng')]),
    );
    const result = await call({ questionId: 'q-1', text: 'migration done' });
    expect(result.isError).toBeFalsy();
    expect(calls).toHaveLength(1);
    expect(calls[0].updateName).toBe('maestroPostAnswer');
    expect(calls[0].payload).toEqual({ questionId: 'q-1', from: 'tempo-eng', text: 'migration done' });
    // Targets the ensemble's maestro workflow.
    expect(calls[0].handleId).toContain('demo');
  });

  it('from is getPlayerId() — not spoofable via args', async () => {
    const { client, calls } = makeFakeClient();
    const { call } = captureRegistration((server) =>
      renderToMcp(server, [buildRespondTool(client, cfg, () => 'real-player')]),
    );
    // Even if a caller smuggles `from`, it's ignored (not in the schema/handler).
    await call({ questionId: 'q-2', text: 'hi', from: 'IMPERSONATOR' } as any);
    expect(calls[0].payload.from).toBe('real-player');
  });

  it('Zod schema validates questionId shape and non-empty text', () => {
    const { schemas } = captureRegistration((server) =>
      renderToMcp(server, [buildRespondTool(makeFakeClient().client, cfg, () => 'p')]),
    );
    expect(schemas.questionId.safeParse('q_-1').success).toBe(true);
    expect(schemas.questionId.safeParse('has space').success).toBe(false);
    expect(schemas.questionId.safeParse('bad/slash').success).toBe(false);
    expect(schemas.questionId.safeParse('').success).toBe(false);
    expect(schemas.text.safeParse('').success).toBe(false);
    expect(schemas.text.safeParse('an answer').success).toBe(true);
  });

  it('surfaces a workflow rejection as an isError result', async () => {
    const { client } = makeFakeClient(() => { throw new Error('MaestroAnswersFull: mailbox full'); });
    const { call } = captureRegistration((server) =>
      renderToMcp(server, [buildRespondTool(client, cfg, () => 'p')]),
    );
    const result = await call({ questionId: 'q-3', text: 'x' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Failed to record answer');
    expect(result.content[0].text).toMatch(/MaestroAnswersFull/);
  });
});
