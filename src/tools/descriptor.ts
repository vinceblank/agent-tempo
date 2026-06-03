/**
 * Transport-neutral tool descriptor (MD-B seam, Phase 1).
 *
 * agent-tempo tools used to be defined directly against an `McpServer`
 * (`defineTool` → `server.tool(...)`). MD-B splits that into:
 *
 *   1. A neutral **descriptor** — `{ name, description, params, handler }` —
 *      with NO MCP or Pi coupling. zod is the single source of truth for
 *      params; the handler returns neutral `{ text, isError? }`.
 *   2. Per-front-end **renderers** — `renderToMcp` (here) and `renderToPi`
 *      (`src/pi/render-tools.ts`). MCP consumes the zod shape raw; Pi derives
 *      a TypeBox schema from it. No dual-define, no drift.
 *
 * Backward-compat is load-bearing: `renderToMcp` reproduces the EXACT output
 * of the old `defineTool` so `src/server.ts` and the claude-api in-process MCP
 * bridge keep byte-identical behavior. `registerAllTempoTools` stays a thin
 * wrapper over `renderToMcp(server, buildAllTempoTools(opts))` — its callers
 * never change.
 *
 * Determinism note: this module is client-side (src/tools). `src/pi/` imports
 * the descriptor type FROM here; this module never imports `src/pi/`.
 *
 * Design reference: architect's MD-B implementation spec (Phase 1).
 */
import type { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/**
 * Neutral tool result. Every current tool returns a single text block via
 * `ok()` / `fail()`. Richer multi-block / structured output is an ADDITIVE
 * future extension (e.g. an optional `data?`) — intentionally not modeled now.
 */
export interface TempoToolResult {
  text: string;
  isError?: boolean;
}

/**
 * A transport-neutral tool definition. Each tool module exports a
 * `build<X>Tool(...deps): TempoToolDescriptor` factory that closes over its
 * existing dependencies (client, config, handle, getPlayerId, …) exactly as
 * the old `register<X>Tool` did.
 */
export interface TempoToolDescriptor {
  name: string;
  description: string;
  /**
   * zod is the SINGLE SOURCE OF TRUTH for parameters. The MCP renderer passes
   * this shape straight to `server.tool`; the Pi renderer derives a TypeBox
   * schema from it via the zod→TypeBox converter. `z.ZodRawShape` is
   * `Record<string, z.ZodTypeAny>` — the same shape `defineTool` accepted.
   */
  params: z.ZodRawShape;
  /** Neutral handler. No MCP `extra` param (zero tools use it). */
  handler: (args: Record<string, unknown>) => Promise<TempoToolResult>;
}

/** Return a successful tool result. (Neutral replacement for the old MCP `ok`.) */
export function ok(text: string): TempoToolResult {
  return { text };
}

/** Return an error tool result. (Neutral replacement for the old MCP `fail`.) */
export function fail(text: string): TempoToolResult {
  return { text, isError: true };
}

/** Extract a human-readable message from an unknown error. */
export function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Render descriptors onto an MCP server — the backward-compatible path.
 *
 * Reproduces the old `defineTool` EXACTLY (see the removed `helpers.ts`):
 *   - `(server.tool as Function)(name, description, paramsSchema, handler)` —
 *     the `as Function` cast is the TS2589 deep-instantiation workaround for
 *     Zod 3.25 + MCP SDK type inference; preserve it.
 *   - The handler wraps the neutral `{ text, isError? }` back into MCP's
 *     `{ content: [{ type: 'text', text }], isError? }` — byte-identical to
 *     what `ok()` / `fail()` produced before MD-B.
 */
export function renderToMcp(server: McpServer, descriptors: TempoToolDescriptor[]): void {
  for (const d of descriptors) {
    (server.tool as Function)(
      d.name,
      d.description,
      d.params,
      async (args: Record<string, unknown>) => {
        const r = await d.handler(args);
        return r.isError
          ? { content: [{ type: 'text' as const, text: r.text }], isError: true }
          : { content: [{ type: 'text' as const, text: r.text }] };
      },
    );
  }
}
