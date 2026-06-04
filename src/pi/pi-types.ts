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
 *   - `core/agent-session.ts` (sendCustomMessage / steer / followUp)
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
  | 'tool_call'
  | 'tool_execution_start'
  | 'tool_execution_end'
  | 'message_update'
  | 'session_shutdown';

/** Options for `sendCustomMessage` — D10 (FLIPPED): default `steer` + `triggerTurn`. */
export interface PiCustomMessageOptions {
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
 * The live, human-attached agent session. `sendCustomMessage` is bound in the
 * `AgentSession` constructor (no mode gate) — confirmed by the spike — so a
 * cue can be injected into a running interactive session.
 */
export interface PiAgentSession {
  /**
   * Inject a message into the live session. Pi's `AgentSession` exposes this as
   * `sendCustomMessage` (NOT `sendMessage` — verified against the installed SDK's
   * `agent-session.d.ts` during the 3a live smoke). The earlier spike modeled it
   * as `sendMessage`; the real method name is `sendCustomMessage`.
   */
  sendCustomMessage(msg: PiOutboundMessage, opts?: PiCustomMessageOptions): void | Promise<void>;
  /**
   * 3d D14 — wipe the conversation and start a FRESH context (no replay). The
   * reset handler calls this on a clean-wipe reset. Optional in the slice (Pi
   * provides it; older Pi / a fake session in tests may not).
   */
  newSession?(): void | Promise<void>;
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
  /**
   * Discriminator on `session_start` / `session_shutdown`:
   * `{ new | resume | fork | reload | quit }`. Drives Option-C teardown — only
   * `quit` detaches; switch reasons rebind. Unknown/missing → treated as a
   * switch (no detach), so a future Pi value can't cause a flap.
   */
  reason?: string;
  /** Open for forward-compat with Pi event fields we don't consume yet. */
  [key: string]: unknown;
}

/**
 * Pi context-window usage — the PULL-only token signal (3c). There is NO token
 * event in Pi 0.78; usage is queried on demand via `ExtensionContext.getContextUsage()`.
 * Mirrors pi-ai's `ContextUsage` (verified against the installed 0.78 `.d.ts`).
 */
export interface PiContextUsage {
  /** Estimated context tokens in use, or `null` when unknown. */
  tokens: number | null;
  /** Model context-window size. */
  contextWindow: number;
  /** Usage as a fraction/percent of the window, or `null` when unknown. */
  percent: number | null;
}

/**
 * Second argument Pi passes to every `pi.on(event, handler)` callback
 * (`ExtensionHandler<E,R> = (event, ctx) => …`). Minimal structural slice — only
 * the members 3c consumes. `getContextUsage()` is the sole source of token/usage
 * data (pull-only — see {@link PiContextUsage}).
 */
export interface PiExtensionContext {
  getContextUsage(): PiContextUsage | undefined;
  isIdle(): boolean;
  /**
   * 3d — the in-flight turn's AbortSignal (Esc / cancel). Pi passes it to handlers
   * (the shipped `permission-gate.ts` precedent threads it into an awaited gate);
   * the operator-gate await uses it to cancel a pending poll so a cancelled turn
   * never hangs on an unresolved decision (Pi #2381). Optional — absent on older
   * Pi / non-turn handlers.
   */
  signal?: AbortSignal;
}

/**
 * Handlers may take an optional second `ctx` arg (3c — needed for
 * `getContextUsage()`). Optional so existing one-arg handlers (Phase 0-2) still
 * satisfy the type — widening is additive/backward-compatible.
 */
export type PiEventHandler = (
  payload: PiEventPayload,
  ctx?: PiExtensionContext,
) => void | Promise<void>;

/**
 * One streaming delta inside a `message_update` event's `assistantMessageEvent`
 * (a discriminated union in pi-ai). 3c forwards `thinking_delta` / `text_delta`
 * as `inner.thinking` frames; `.delta` is the incremental string.
 */
export interface PiAssistantDelta {
  /** `'text_delta'` | `'thinking_delta'` | `'toolcall_delta'` | … */
  type?: string;
  /** Orders multi-block content within a turn. */
  contentIndex?: number;
  /** The incremental text fragment. */
  delta?: string;
  /** Cumulative `AssistantMessage` so far (unused by 3c). */
  partial?: unknown;
}

/** `message_update` payload — carries the streaming `assistantMessageEvent`. */
export interface PiMessageUpdatePayload extends PiEventPayload {
  assistantMessageEvent?: PiAssistantDelta;
}

/** `tool_execution_start` payload. `toolName` is a bare string (NOT a literal union). */
export interface PiToolExecutionStartPayload extends PiEventPayload {
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
}

/** `tool_execution_end` payload — structured result + error flag. */
export interface PiToolExecutionEndPayload extends PiEventPayload {
  toolCallId?: string;
  toolName?: string;
  result?: unknown;
  isError?: boolean;
}

/** `turn_start` / `turn_end` payload. No phase field, no token counts (3c finding). */
export interface PiTurnPayload extends PiEventPayload {
  turnIndex?: number;
  timestamp?: number;
}

/**
 * `tool_call` pre-execution event — Pi fires this before running a tool, letting
 * an extension allow/deny it. `toolName` is Pi's built-in or registered tool id
 * (`bash` | `read` | `edit` | `write` | `grep` | …). The MD-C headless gate reads
 * it to hard-block the shell/exec class at `toolAccess='restricted'`.
 */
export interface PiToolCallEvent {
  type?: 'tool_call';
  toolCallId?: string;
  toolName: string;
  input?: Record<string, unknown>;
}

/** Result of a `tool_call` handler: `block:true` denies the tool (with a reason). */
export interface PiToolCallResult {
  block?: boolean;
  reason?: string;
}

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
 * `render-tools.ts` (derives it from the zod descriptor via the converter).
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
