/**
 * In-process MCP bridge for the claude-api adapter.
 *
 * Boots an MCP `Server` (the same `McpServer` class `src/server.ts` uses),
 * registers every tempo tool onto it via the shared `registerAllTempoTools`
 * helper, and pairs an MCP `Client` to it via
 * `InMemoryTransport.createLinkedPair()` — no subprocess, no stdio buffering,
 * direct in-process JS calls under the hood.
 *
 * Why in-process (vs stdio sidecar):
 *   - No second process to manage / lifecycle / clean up
 *   - Zero stdio buffering edge cases
 *   - ~50 LoC of glue vs 200+ for a sidecar
 *   - MCP boundary preserved — adding a new tempo tool lights up
 *     automatically with no adapter change
 *
 * The bridge owns the schema translation (MCP `inputSchema` → Anthropic
 * Messages API `input_schema`) so the adapter's tool-use loop can hand
 * the converted list straight to `messages.create({ tools })`.
 *
 * Design reference: `docs/design/131-claude-api-adapter.md` §4 (in-process
 * MCP).
 */
import * as fs from 'fs';
import { dirname, join } from 'path';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { registerAllTempoTools, type RegisterAllTempoToolsOpts } from '../../server-tools';

/**
 * Resolve claude-tempo's `version` from its own `package.json`. Walks up
 * from `__dirname` searching for a `package.json` whose `name` matches —
 * robust across all build contexts:
 *   - `src/adapters/claude-api/mcp-bridge.ts` (ts-node dev)
 *   - `dist/adapters/claude-api/mcp-bridge.js` (production)
 *   - `dist-test/src/adapters/claude-api/mcp-bridge.js` (mocha integration build)
 *
 * The naive `require('../../../package.json')` worked for the first two
 * but hit ENOENT in the third because `dist-test/` adds an extra `src/`
 * layer that shifts the relative anchor (caught by CI on PR #455).
 *
 * Cached after first resolve so repeated `bootMcpBridge` calls don't re-walk.
 * Falls back to `'0.0.0-unknown'` if the walk fails — only used as a
 * diagnostic-grade `version` field on the MCP server/client identity, not
 * for any version-gating behaviour.
 */
let cachedPackageVersion: string | null = null;
function packageVersion(): string {
  if (cachedPackageVersion !== null) return cachedPackageVersion;
  let resolved = '0.0.0-unknown';
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    try {
      const pkg = JSON.parse(fs.readFileSync(join(dir, 'package.json'), 'utf8'));
      if (pkg && pkg.name === 'claude-tempo' && typeof pkg.version === 'string') {
        resolved = pkg.version;
        break;
      }
    } catch { /* not here, walk up */ }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  cachedPackageVersion = resolved;
  return resolved;
}

/**
 * Anthropic Messages API tool shape — the JSON contract `messages.create`
 * accepts in its `tools` array. Mirrors the MCP tool shape exactly except
 * for the field name (`inputSchema` → `input_schema`). Declared here
 * (rather than imported from `@anthropic-ai/sdk`) so this module can ship
 * without the optional Anthropic dep — only the adapter's spawn-time entry
 * point requires the SDK to be installed.
 */
export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: object;
}

/**
 * Live in-process MCP bridge — server + client + cached tool list. Returned
 * from {@link bootMcpBridge} and held by `DirectApiAttachment` for the
 * duration of the session.
 */
export interface McpBridge {
  /** MCP client — call `bridge.client.callTool({ name, arguments })` from the tool-use loop. */
  client: McpClient;
  /**
   * Cached Anthropic-shaped tool list (translated from MCP `listTools()` once
   * at session start). Tools don't change mid-session in v1, so the cache is
   * safe; if a Phase 2 adds dynamic tool registration, refresh on a signal.
   */
  tools: AnthropicTool[];
  /**
   * Dispatch a tool call from the adapter's streaming loop. Returns the MCP
   * `CallToolResult` content + isError shape, ready to slot into a
   * Messages API `tool_result` block (`content`, `is_error`).
   */
  callTool: (name: string, args: Record<string, unknown>) => Promise<CallToolResult>;
  /** Tear down both halves of the in-memory transport on shutdown. */
  close: () => Promise<void>;
}

/**
 * Boot the in-process MCP bridge for the claude-api adapter. Registers the
 * full tempo tool surface against an `McpServer`, pairs an `McpClient` via
 * `InMemoryTransport.createLinkedPair()`, calls `client.listTools()` once
 * to populate the cached Anthropic-shaped tool array.
 *
 * @param opts Same option struct `registerAllTempoTools` consumes —
 *             identity + workflow handle + conductor flag. The adapter
 *             builds it from its env-var contract.
 */
export async function bootMcpBridge(opts: RegisterAllTempoToolsOpts): Promise<McpBridge> {
  const server = new McpServer({
    name: 'agent-tempo',
    version: packageVersion(),
  });

  registerAllTempoTools(server, opts);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const client = new McpClient({
    name: 'claude-api-adapter',
    version: packageVersion(),
  });
  await client.connect(clientTransport);

  const { tools: mcpTools } = await client.listTools();
  const tools: AnthropicTool[] = mcpTools.map((t) => ({
    name: t.name,
    description: t.description ?? '',
    input_schema: t.inputSchema,
  }));

  return {
    client,
    tools,
    callTool: async (name, args) => {
      const result = await client.callTool({ name, arguments: args });
      return result as CallToolResult;
    },
    close: async () => {
      // Closing the client transport drains both halves of the linked pair.
      // McpServer/McpClient close methods are best-effort; swallow per-half
      // errors so a partial teardown doesn't mask the original shutdown
      // cause from upstream callers.
      try { await client.close(); } catch { /* ignore */ }
      try { await server.close(); } catch { /* ignore */ }
    },
  };
}
