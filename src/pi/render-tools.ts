/**
 * Pi front-end renderer — registers transport-neutral tool descriptors onto a
 * Pi `ExtensionAPI` (the counterpart to `renderToMcp` in src/tools/descriptor.ts).
 *
 * The MCP renderer passes the zod param shape to `server.tool` raw; here we
 * DERIVE a TypeBox schema from the same zod shape via the converter
 * (`zod-to-typebox.ts`). zod stays the single source of truth — no dual-define,
 * no drift. The CI parity test (test/pi-tool-parity.test.ts) asserts the MCP
 * and Pi front-ends register the identical tool set with identical required
 * params.
 *
 * OUTBOX-COMPLIANCE INVARIANT (load-bearing): `renderToPi` reuses the
 * descriptor's `handler` VERBATIM — it never reimplements tool logic. The
 * handler still routes through `handle.executeUpdate(submitOutboxUpdate, …)` on
 * the player's OWN workflow handle. The Pi extension's WorkflowClient builds
 * only that handle; there is ZERO `.signal()` to peer workflows.
 *
 * Determinism note: client-side only. src/pi imports the descriptor type FROM
 * src/tools; never the reverse.
 */
import { zodShapeToTypeBox } from './zod-to-typebox';
import type { TempoToolDescriptor, TempoToolResult } from '../tools/descriptor';
import type { ExtensionAPI, PiToolResult } from './pi-types';

/**
 * Map a neutral {@link TempoToolResult} onto Pi's `AgentToolResult` shape.
 *
 * Phase 0 confirmed Pi's result is `{ output, isError }` for a non-streaming
 * tool (D12). The neutral `{ text, isError? }` maps directly: `text → output`,
 * `isError` passes through.
 */
export function toPiResult(r: TempoToolResult): PiToolResult {
  return r.isError ? { output: r.text, isError: true } : { output: r.text };
}

/**
 * Register every descriptor onto the Pi extension API. The TypeBox schema is
 * derived per-tool from the zod shape; an unsupported zod construct throws
 * `UnsupportedZodFeatureError` from the converter (fail-loud — D1), surfacing
 * the offending `tool.field` so the parity test points at the exact site.
 */
export function renderToPi(pi: ExtensionAPI, descriptors: TempoToolDescriptor[]): void {
  for (const d of descriptors) {
    pi.registerTool({
      name: d.name,
      description: d.description,
      parameters: zodShapeToTypeBox(d.params, d.name),
      // Pi calls execute POSITIONALLY: (toolCallId, params, signal, onUpdate, ctx).
      // The validated params object is the SECOND positional — ignore the
      // toolCallId string (1st) and hand `params` to the descriptor handler.
      // (Passing the 1st positional was the v1.4.0 arg-order bug: handlers got the
      // toolCallId string instead of params.) See PiToolDefinition.execute.
      execute: async (_toolCallId, params) => toPiResult(await d.handler(params)),
    });
  }
}
