/**
 * agent-tempo Pi integration — Phase 0 PoC barrel.
 *
 * Default export is the Pi extension factory (`export default function(pi)`);
 * named exports expose the testable units and the client-side wrapper for reuse
 * by the headless Pi runtime (Phase 3).
 *
 * See src/pi/README.md for the Phase 0 findings (abrupt-death / MD-A, D12a) and
 * known limitations (hand-written pi-types drift risk).
 */
export { default } from './extension';
export { PhaseDriver } from './phase-driver';
export type { PiPhase, WorkflowAction, PhaseDriverResult } from './phase-driver';
export { PiWorkflowClient } from './workflow-client';
export type { PiWorkflowClientOptions } from './workflow-client';
export { CuePump } from './cue-pump';
export type { CueSource, SessionResolver, CuePumpOptions } from './cue-pump';
export {
  buildReportSchema,
  buildReportToolDefinition,
  createReportHandler,
  registerReportTool,
  REPORT_TYPES,
} from './report-tool';
export type { OutboxSubmitter, ReportType, ReportToolArgs } from './report-tool';
export { probePi, PI_PACKAGE, PI_AI_PACKAGE, TESTED_PI_VERSION, PI_NODE_FLOOR } from './probe';
export type { PiProbeResult } from './probe';
export type {
  ExtensionAPI,
  PiExtension,
  PiAgentSession,
  PiEventPayload,
  PiToolDefinition,
  PiToolResult,
  PiLifecycleEvent,
} from './pi-types';
