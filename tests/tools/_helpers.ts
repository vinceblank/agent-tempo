/**
 * Shared vitest harness for direct MCP-tool unit tests (#334 PR-1).
 *
 * Mirrors the `extractHandler` style used by `test/tools.test.ts` over a fake
 * `McpServer`: no Temporal worker, no network, no `defineTool` round-trip
 * through the SDK. The tool registers a handler against a fake server, and we
 * capture both the handler closure and the Zod schema map so tests can call
 * the handler directly and validate the schemas independently.
 */
import { vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { WorkflowHandle } from '@temporalio/client';

export type ToolHandler = (args: Record<string, any>) => Promise<{
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}>;

export interface CapturedRegistration {
  call: ToolHandler;
  schemas: Record<string, any>;
}

/**
 * Run `registerFn` against a fake `McpServer` and return the captured handler
 * + Zod schemas.
 */
export function captureRegistration(
  registerFn: (server: McpServer) => void,
): CapturedRegistration {
  let captured: { handler: Function; schemas: Record<string, any> } | undefined;
  const fakeServer = {
    tool: (_name: unknown, _desc: unknown, schemas: any, handler: Function) => {
      captured = { handler, schemas };
    },
  } as unknown as McpServer;
  registerFn(fakeServer);
  if (!captured) throw new Error('registerFn did not register a handler');
  return {
    call: (args) => captured!.handler(args, {}),
    schemas: captured.schemas,
  };
}

/**
 * Build a fake `WorkflowHandle.executeUpdate(...)` that records every call's
 * payload and returns `defaultResponse` (or the custom `impl` if supplied).
 * Used by `save_state` and `clear_state` tests — both are owner-only update
 * tools that thread a single payload through to the workflow.
 */
export function makeFakeUpdateHandle<T>(
  defaultResponse: T,
  impl?: (...args: any[]) => any,
): { handle: WorkflowHandle; calls: Array<{ updateName: string; payload: any }> } {
  const calls: Array<{ updateName: string; payload: any }> = [];
  const handle = {
    executeUpdate: vi.fn(async (def: any, opts: any) => {
      const updateName = typeof def === 'string' ? def : def?.name ?? 'unknown';
      const payload = opts?.args?.[0];
      calls.push({ updateName, payload });
      if (impl) return impl(def, opts);
      return defaultResponse;
    }),
  } as unknown as WorkflowHandle;
  return { handle, calls };
}
