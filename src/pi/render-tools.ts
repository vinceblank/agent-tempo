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
 * Map a SUCCESSFUL neutral {@link TempoToolResult} onto Pi's `AgentToolResult`
 * shape (#653, 1.4.2): the text becomes a single text-content block. ERRORS are
 * NOT mapped here — they are thrown from `execute` (Pi's sanctioned error path),
 * so callers must check `r.isError` BEFORE calling this. `details` is an empty
 * object (we surface no structured details); `terminate` is left unset.
 */
export function toPiResult(r: TempoToolResult): PiToolResult {
  return { content: [{ type: 'text', text: r.text }], details: {} };
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
      // Real ToolDefinition REQUIRES `label` (C4, #645 H4) — use the tool name.
      label: d.name,
      description: d.description,
      parameters: zodShapeToTypeBox(d.params, d.name),
      // Pi calls execute POSITIONALLY: (toolCallId, params, signal, onUpdate, ctx).
      // The validated params object is the SECOND positional — ignore the
      // toolCallId string (1st) and hand `params` to the descriptor handler.
      // (Passing the 1st positional was the v1.4.0 arg-order bug: handlers got the
      // toolCallId string instead of params.) See PiToolDefinition.execute.
      execute: async (_toolCallId, params) => {
        const r = await d.handler(params);
        // Pi's sanctioned error path (#653): THROW on failure — the agent loop
        // catches it → createErrorToolResult (message → content) + isError:true.
        // Content-encoding an error WITHOUT throwing would make the model think
        // the tool SUCCEEDED (Pi types.d.ts:327). So errors never reach toPiResult.
        if (r.isError) throw new Error(r.text);
        return toPiResult(r);
      },
    });
  }
}
