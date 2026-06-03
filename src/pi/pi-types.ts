/**
 * Local, hand-written structural declarations of the slice of Pi's
 * `ExtensionAPI` surface that the agent-tempo Phase 0 PoC consumes.
 *
 * WHY HAND-WRITTEN (Phase 0 shortcut — see src/pi/README.md "Known limitations"):
 *   The real types live in `@earendil-works/pi-coding-agent`, which is an
 *   OPTIONAL dependency requiring Node 22.19+. Declaring these locally keeps
 *   `tsc` (root build + test build) green WITHOUT Pi installed, so the unit
 *   suite runs on any CI node. The cost is drift risk: if Pi's real
 *   `ExtensionAPI` changes, these decls won't catch it at compile time.
 *
 *   Phase 1 should switch to importing the real Pi types at type-check time
 *   (Pi as a true optional/peer dep) so we get compile-time API-drift
 *   detection. These decls are a temporary stand-in, NOT the end state.
 *
 * Surface mirrored against `badlogic/pi-mono` @ 564ad70 (packages 0.78.0):
 *   - `core/extensions/types.ts` (ExtensionAPI, ToolDefinition, events)
 *   - `core/agent-session.ts` (sendMessage / steer / followUp)
 */

/**
 * Pi lifecycle events. Phase 0 only wires the lifecycle-relevant subset; the
 * real `ExtensionAPI.on` accepts many more event names.
 *
 * IMPORTANT (architect's phase spec): `turn_start` / `turn_end` /
 * `tool_execution_start` / `tool_execution_end` fire MULTIPLE times within a
 * single agent run and therefore MUST NOT drive the attachment phase — they
 * only stamp a last-activity timestamp. See `phase-driver.ts`.
 */
export type PiLifecycleEvent =
  | 'session_start'
  | 'agent_start'
  | 'agent_end'
  | 'turn_start'
  | 'turn_end'
  | 'tool_execution_start'
  | 'tool_execution_end'
  | 'session_shutdown';

/** Options for `sendMessage` — D10 (FLIPPED): default `steer` + `triggerTurn`. */
export interface PiSendMessageOptions {
  /** Start a new agent turn after delivery. */
  triggerTurn?: boolean;
  /**
   * `steer`  — interrupt an in-flight turn and inject immediately (priority).
   * `followUp` — queue behind the current turn.
   */
  deliverAs?: 'steer' | 'followUp';
}

/** A message injected into a live Pi session. */
export interface PiOutboundMessage {
  /** Free-form tag Pi surfaces to the agent (we use `'cue'`). */
  customType?: string;
  content: string;
  /** Render the injected content in the human-visible transcript. */
  display?: boolean;
}

/**
 * The live, human-attached agent session. `sendMessage` is bound in the
 * `AgentSession` constructor (no mode gate) — confirmed by the spike — so a
 * cue can be injected into a running interactive session.
 */
export interface PiAgentSession {
  sendMessage(msg: PiOutboundMessage, opts?: PiSendMessageOptions): void | Promise<void>;
  /** Pi's stable session identifier (reconciled with workflow metadata — D11). */
  readonly id?: string;
}

/**
 * Payload delivered to a `pi.on(event, handler)` callback. Kept structural and
 * open: Pi passes an event-specific object; we read only what Phase 0 needs and
 * RE-ACQUIRE the session from each payload (never cache across switches — D11).
 */
export interface PiEventPayload {
  /** The live session, present on most lifecycle events. */
  session?: PiAgentSession;
  /** A per-message/per-turn identifier when the event carries one. */
  messageId?: string;
  /** Open for forward-compat with Pi event fields we don't consume yet. */
  [key: string]: unknown;
}

export type PiEventHandler = (payload: PiEventPayload) => void | Promise<void>;

/**
 * Pi tool result (`AgentToolResult`). The exact streaming shape is UNCONFIRMED
 * (spike gap D12b) — Phase 0 uses the minimal `{ output, isError }` form, which
 * is sufficient for a non-streaming tool like `report`.
 */
export interface PiToolResult {
  output?: string;
  isError?: boolean;
  [key: string]: unknown;
}

/**
 * Pi native tool definition. `parameters` is a TypeBox schema (NOT zod) — see
 * `report-tool.ts` for construction.
 */
export interface PiToolDefinition {
  name: string;
  description?: string;
  /** TypeBox schema object. Typed `unknown` to avoid coupling pi-types to typebox. */
  parameters: unknown;
  execute: (args: Record<string, unknown>) => Promise<PiToolResult> | PiToolResult;
}

/** The `pi` object passed to `export default function(pi: ExtensionAPI) {}`. */
export interface ExtensionAPI {
  on(event: PiLifecycleEvent | string, handler: PiEventHandler): void;
  registerTool(def: PiToolDefinition): void;
}

/** An extension is a default-exported function receiving the `ExtensionAPI`. */
export type PiExtension = (pi: ExtensionAPI) => void | Promise<void>;
