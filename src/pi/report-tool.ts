/**
 * Pi-native `report` tool — the single tool hand-wired for Phase 0.
 *
 * Proves three things the headless path later reuses:
 *   1. A TypeBox schema (NOT zod) can be built for a Pi tool. (typebox is a
 *      real dependency — schema construction is unit-tested.)
 *   2. The handler routes through the EXISTING outbox seam — it calls
 *      `submitOutbox` on the player's OWN workflow handle, exactly like the
 *      MCP `report` tool (src/tools/report.ts). ZERO direct `.signal()` to peer
 *      workflows (outbox compliance — QA enforces).
 *   3. The MCP `{ content, isError }` result shape maps onto Pi's
 *      `AgentToolResult` (`{ output, isError }`).
 *
 * The full zod→TypeBox port of all ~30 tools (D1 / MD-B) is Phase 1, NOT here.
 */
import { Type, type TSchema } from 'typebox';
import type { OutboxEntryInput } from '../types';
import type { PiToolDefinition, PiToolResult } from './pi-types';

/** Report severities — mirrors the MCP report tool's enum (src/tools/report.ts). */
export type ReportType = 'result' | 'blocker' | 'question' | 'update';

export const REPORT_TYPES: readonly ReportType[] = ['result', 'blocker', 'question', 'update'];

/** Validated args after Pi parses the inbound tool call against the schema. */
export interface ReportToolArgs {
  text: string;
  type?: ReportType;
}

/**
 * Minimal outbox seam. The production impl (PiWorkflowClient) submits via
 * `handle.executeUpdate(submitOutboxUpdate, { args: [entry] })`. Injecting this
 * interface keeps the handler unit-testable WITHOUT Temporal — and structurally
 * GUARANTEES the handler has no other way to reach peer workflows (no `.signal`).
 */
export interface OutboxSubmitter {
  submitOutbox(entry: OutboxEntryInput): Promise<string>;
}

/**
 * Build the TypeBox parameter schema for the `report` tool.
 *
 * NOTE on enums: the spike recommends `StringEnum` from `@earendil-works/pi-ai`
 * for Pi's preferred enum rendering. pi-ai is declarative-only in Phase 0 (not
 * installed), so we use a TypeBox union-of-literals here — the standard JSON
 * Schema `enum` representation, fully testable. Phase 1 may swap to pi-ai's
 * `StringEnum` if Pi requires that specific helper. (Acceptable narrow gap —
 * see src/pi/README.md.)
 */
export function buildReportSchema(): TSchema {
  return Type.Object({
    text: Type.String({ description: 'The report content' }),
    type: Type.Optional(
      Type.Union(
        REPORT_TYPES.map((t) => Type.Literal(t)),
        {
          description:
            'Type of report: "result" (default, task done), "blocker" (stuck), ' +
            '"question" (need input), "update" (progress update, still working)',
        },
      ),
    ),
  });
}

/**
 * Create the `report` execute handler. Routes through the outbox ONLY.
 *
 * Mirrors src/tools/report.ts semantics: default type `result`, success message
 * echoes the outbox entry id, errors surface as an `isError` tool result.
 */
export function createReportHandler(
  submitter: OutboxSubmitter,
): (args: ReportToolArgs) => Promise<PiToolResult> {
  return async (args: ReportToolArgs): Promise<PiToolResult> => {
    const text = args.text;
    const reportType: ReportType = args.type ?? 'result';
    try {
      const entry: OutboxEntryInput = {
        type: 'report',
        text,
        reportType,
      };
      const entryId = await submitter.submitOutbox(entry);
      return {
        output: `Report sent to conductor: [${reportType}] ${text} (outbox: ${entryId})`,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { output: `Failed to send report: ${message}`, isError: true };
    }
  };
}

/**
 * Assemble the full Pi tool definition (schema + handler + metadata) for
 * `pi.registerTool(...)`. The `execute` shim narrows Pi's untyped args bag to
 * `ReportToolArgs` before delegating to the typed handler.
 */
export function buildReportToolDefinition(submitter: OutboxSubmitter): PiToolDefinition {
  const handler = createReportHandler(submitter);
  return {
    name: 'report',
    description:
      'Send an update to the conductor. Use this to report task completion, ' +
      'blockers, or questions. No-op if no conductor is running.',
    parameters: buildReportSchema(),
    execute: (args: Record<string, unknown>) =>
      handler({ text: String(args.text ?? ''), type: args.type as ReportType | undefined }),
  };
}

/** Register the `report` tool on the Pi extension API. */
export function registerReportTool(
  pi: { registerTool(def: PiToolDefinition): void },
  submitter: OutboxSubmitter,
): void {
  pi.registerTool(buildReportToolDefinition(submitter));
}
