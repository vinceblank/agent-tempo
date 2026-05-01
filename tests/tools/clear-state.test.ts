/**
 * Direct unit tests for `src/tools/clear-state.ts` (#334 PR-1).
 *
 * Owner-only by structure — no `playerId` arg. The tool always invokes
 * `clearPlayerStateUpdate` against the calling player's own handle. Tests
 * cover the two success messages (`cleared` vs `was already empty`),
 * default-key behaviour, Zod-level rejection of bad keys, and propagation
 * of workflow-side errors into an isError response.
 */
import { describe, it, expect, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { WorkflowHandle } from '@temporalio/client';
import { registerClearStateTool } from '../../src/tools/clear-state';
import { PLAYER_STATE_DEFAULT_KEY } from '../../src/utils/validation';

type ToolHandler = (args: Record<string, any>) => Promise<{
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}>;

interface CapturedRegistration {
  call: ToolHandler;
  schemas: Record<string, any>;
}

function captureRegistration(
  registerFn: (server: McpServer) => void,
): CapturedRegistration {
  let captured: { handler: Function; schemas: Record<string, any> } | undefined;
  const fakeServer = {
    tool: (_name: unknown, _desc: unknown, schemas: any, handler: Function) => {
      captured = { handler, schemas };
    },
  } as unknown as McpServer;
  registerFn(fakeServer);
  if (!captured) throw new Error('clear_state did not register a handler');
  return {
    call: (args) => captured!.handler(args, {}),
    schemas: captured.schemas,
  };
}

function makeFakeHandle(executeUpdateImpl?: (...args: any[]) => any): {
  handle: WorkflowHandle;
  calls: Array<{ payload: any }>;
} {
  const calls: Array<{ payload: any }> = [];
  const handle = {
    executeUpdate: vi.fn(async (_def: any, opts: any) => {
      const payload = opts?.args?.[0];
      calls.push({ payload });
      if (executeUpdateImpl) return executeUpdateImpl(_def, opts);
      return { cleared: true };
    }),
  } as unknown as WorkflowHandle;
  return { handle, calls };
}

describe('clear_state tool (#334 PR-1)', () => {
  it('reports "Cleared slot" when the workflow returns cleared:true', async () => {
    const { handle } = makeFakeHandle(() => ({ cleared: true }));
    const { call } = captureRegistration((server) =>
      registerClearStateTool(server, handle),
    );
    const result = await call({ key: 'bookmark' });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toBe('Cleared slot **"bookmark"**.');
  });

  it('reports "was already empty" when the workflow returns cleared:false', async () => {
    const { handle } = makeFakeHandle(() => ({ cleared: false }));
    const { call } = captureRegistration((server) =>
      registerClearStateTool(server, handle),
    );
    const result = await call({ key: 'main' });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toBe('Slot **"main"** was already empty.');
  });

  it('uses PLAYER_STATE_DEFAULT_KEY when key is omitted', async () => {
    const { handle, calls } = makeFakeHandle();
    const { call } = captureRegistration((server) =>
      registerClearStateTool(server, handle),
    );
    await call({});
    expect(calls).toHaveLength(1);
    expect(calls[0].payload).toEqual({ key: PLAYER_STATE_DEFAULT_KEY });
  });

  it('Zod schema rejects keys that violate PLAYER_STATE_KEY_REGEX', () => {
    const { schemas } = captureRegistration((server) =>
      registerClearStateTool(server, makeFakeHandle().handle),
    );
    expect(schemas.key.safeParse('has space').success).toBe(false);
    expect(schemas.key.safeParse('bad/slash').success).toBe(false);
    expect(schemas.key.safeParse('').success).toBe(false);
    expect(schemas.key.safeParse('valid_-1').success).toBe(true);
  });

  it('surfaces workflow rejections as an isError result', async () => {
    const { handle } = makeFakeHandle(() => {
      throw new Error('PlayerStateInvalidKey: "bad" is not allowed');
    });
    const { call } = captureRegistration((server) =>
      registerClearStateTool(server, handle),
    );
    const result = await call({ key: 'main' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Failed to clear state');
    expect(result.content[0].text).toMatch(/PlayerStateInvalidKey/);
  });
});
