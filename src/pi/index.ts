/**
 * agent-tempo Pi integration — barrel.
 *
 * Default export is the Pi extension factory (`export default function(pi)`).
 * Named exports expose the testable units and the client-side wrapper for reuse
 * by the headless Pi runtime (Phase 3).
 *
 * Tool registration: the extension renders the shared transport-neutral tool
 * descriptors (src/tools/descriptor.ts) onto Pi via `renderToPi`, deriving
 * TypeBox param schemas from zod through `zod-to-typebox.ts`. There is no
 * Pi-specific re-implementation of any tool.
 *
 * See src/pi/README.md for the Phase 0/2 findings (abrupt-death / MD-A, D12a)
 * and known limitations.
 */
export { default } from './extension';
export { PhaseDriver } from './phase-driver';
export type { PiPhase, WorkflowAction, PhaseDriverResult } from './phase-driver';
export { PiWorkflowClient } from './workflow-client';
export type { PiWorkflowClientOptions } from './workflow-client';
export { CuePump } from './cue-pump';
export type { CueSource, SessionResolver, CuePumpOptions } from './cue-pump';
export { renderToPi, toPiResult } from './render-tools';
export { createLazyProxy } from './lazy-proxy';
export { zodShapeToTypeBox, UnsupportedZodFeatureError } from './zod-to-typebox';
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
