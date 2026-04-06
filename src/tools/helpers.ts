import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/** Standard MCP tool result type. */
export type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

/** Return a successful tool result. */
export function ok(text: string): ToolResult {
  return { content: [{ type: 'text' as const, text }] };
}

/** Return an error tool result. */
export function fail(text: string): ToolResult {
  return { content: [{ type: 'text' as const, text }], isError: true };
}

/** Extract a human-readable message from an unknown error. */
export function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Wrapper around McpServer.tool() that avoids TS2589 deep type instantiation
 * errors caused by Zod 3.25 + MCP SDK type inference interaction.
 */
export function defineTool(
  server: McpServer,
  name: string,
  description: string,
  paramsSchema: Record<string, z.ZodTypeAny>,
  handler: (args: Record<string, any>, extra: any) => Promise<ToolResult>,
) {
  (server.tool as Function)(name, description, paramsSchema, handler);
}
