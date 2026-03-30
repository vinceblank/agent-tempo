import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/**
 * Wrapper around McpServer.tool() that avoids TS2589 deep type instantiation
 * errors caused by Zod 3.25 + MCP SDK type inference interaction.
 */
export function defineTool(
  server: McpServer,
  name: string,
  description: string,
  paramsSchema: Record<string, z.ZodTypeAny>,
  handler: (args: Record<string, any>, extra: any) => Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }>,
) {
  (server.tool as Function)(name, description, paramsSchema, handler);
}
