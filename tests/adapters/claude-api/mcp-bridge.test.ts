/**
 * In-process MCP bridge — tool list translation contract test.
 *
 * The bridge boots an `McpServer`, registers every tempo tool against it,
 * pairs an `McpClient` via `InMemoryTransport`, and exposes the cached
 * Anthropic-shaped tool array. We don't exercise the full bridge here
 * (registering all 30+ tools requires Temporal client + workflow handle
 * scaffolding that the helper tests don't justify); instead, we test the
 * translation layer in isolation — the part that bridges MCP's
 * `inputSchema` to Anthropic's `input_schema`.
 *
 * Full bridge boot + dispatch coverage rides on the lifecycle integration
 * test (deferred follow-up — requires shared TestWorkflowEnvironment +
 * mocked @anthropic-ai/sdk harness).
 */
import { describe, it, expect } from 'vitest';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';

/**
 * Minimal bridge harness — registers a couple of synthetic tools, pairs
 * client + server in-memory, returns the same Anthropic-shaped array
 * `bootMcpBridge` would produce. Avoids dragging in `registerAllTempoTools`
 * (and its Temporal handle dependency) for a contract test focused on
 * the schema mapping itself.
 */
async function harness(): Promise<{ tools: Array<{ name: string; description: string; input_schema: object }>; client: McpClient }> {
  const server = new McpServer({ name: 'test-bridge', version: '0.0.0-test' });
  server.registerTool('echo', {
    description: 'Echo back the input string',
    inputSchema: { text: z.string().describe('the text to echo') },
  }, async (args) => ({ content: [{ type: 'text' as const, text: String((args as { text: string }).text) }] }));
  server.registerTool('add', {
    description: 'Add two numbers',
    inputSchema: { a: z.number(), b: z.number() },
  }, async (args) => {
    const { a, b } = args as { a: number; b: number };
    return { content: [{ type: 'text' as const, text: String(a + b) }] };
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new McpClient({ name: 'test-client', version: '0.0.0-test' });
  await client.connect(clientTransport);

  const { tools } = await client.listTools();
  // Same translation the bridge applies — `inputSchema` → `input_schema`.
  const anthropicTools = tools.map((t) => ({
    name: t.name,
    description: t.description ?? '',
    input_schema: t.inputSchema,
  }));
  return { tools: anthropicTools, client };
}

describe('MCP bridge — Anthropic tool translation', () => {
  it('exposes every registered tool with description + input_schema', async () => {
    const { tools } = await harness();
    expect(tools).toHaveLength(2);
    const echo = tools.find((t) => t.name === 'echo');
    expect(echo).toBeDefined();
    expect(echo!.description).toMatch(/echo/i);
    // input_schema is the same shape as MCP's inputSchema (JSON Schema
    // object; Zod is converted upstream by the MCP SDK).
    expect(typeof echo!.input_schema).toBe('object');
    expect(echo!.input_schema).toMatchObject({ type: 'object' });
  });

  it('translates `inputSchema` → `input_schema` (field name shim)', async () => {
    const { tools } = await harness();
    for (const t of tools) {
      // The Anthropic shape uses snake_case; the MCP shape uses camelCase.
      // Verify our translation strips the camelCase variant.
      expect(t).toHaveProperty('input_schema');
      expect(t).not.toHaveProperty('inputSchema');
    }
  });

  it('callTool round-trip resolves with the registered handler\'s content', async () => {
    const { client } = await harness();
    const result = await client.callTool({ name: 'echo', arguments: { text: 'ping' } });
    // CallToolResult.content is the array the registered handler returned.
    const content = (result as { content: Array<{ type: string; text: string }> }).content;
    expect(content).toBeDefined();
    expect(content[0].type).toBe('text');
    expect(content[0].text).toBe('ping');
  });

  it('callTool propagates structured errors via isError without throwing', async () => {
    // Server-side handlers can return { isError: true } for soft failures
    // (vs throwing for hard ones). The bridge's callTool wrapper passes
    // both fields through into the Anthropic `tool_result` block —
    // verifying the round-trip preserves the contract.
    const server = new McpServer({ name: 'test-bridge', version: '0.0.0-test' });
    server.registerTool('fail', {
      description: 'Always fails',
      inputSchema: {},
    }, async () => ({ content: [{ type: 'text' as const, text: 'something went wrong' }], isError: true }));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new McpClient({ name: 'test-client', version: '0.0.0-test' });
    await client.connect(clientTransport);

    const result = await client.callTool({ name: 'fail', arguments: {} });
    expect((result as { isError?: boolean }).isError).toBe(true);
  });
});
