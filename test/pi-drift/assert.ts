/**
 * Pi type-drift gate (#645 H4) — TYPE-LEVEL assertions, compiled with --noEmit
 * via scripts/check-pi-drift.js, NEVER executed.
 *
 * Our Pi `ExtensionAPI`/tool shims (src/pi/pi-types.ts, src/pi/mission-control/
 * pi-ui.ts) are hand-written so the build/test suite stays green WITHOUT the
 * optional `@earendil-works/pi-coding-agent` dep installed. This file imports the
 * REAL Pi 0.78 types and asserts our shims stay ASSIGNABLE in the direction each
 * is actually used. If a Pi upgrade drifts the real types, the rows below stop
 * compiling and the gate goes RED.
 *
 * Variance convention:
 *   - PASS rows  = OUR type must be assignable to the real PARAMETER (we hand the
 *     value TO Pi: sendCustomMessage, setWidget, registerTool inputs).
 *   - RECV rows  = the REAL type must be assignable to OURS (Pi hands us the
 *     value: handler ctx, events, tool-call results).
 *   - Some rows assert BOTH (exact mirror — drift in either direction matters).
 *   - CALL-SHAPE rows assert a representative call COMPILES (used where full
 *     signature identity would over-constrain — e.g. overloaded methods).
 *
 * BLIND-SPOT CLASSES this gate CANNOT cover (B3, #645 H4 — covered elsewhere):
 *   1. Undeclared RUNTIME fields. `PiEventPayload.session` is not in Pi's `.d.ts`
 *      (interactive-only runtime field) → not type-assertable. Covered by the B1
 *      runtime guard (src/pi/extension.ts warnIfInteractiveSessionMissing).
 *   2. Positional arg-ORDER at a call we author. The corrected
 *      PiToolDefinition.execute (#651) is locked by the runtime regression test
 *      (test/pi-render-tools.test.ts), not just by types.
 *   3. (HISTORICAL) The toPiResult → AgentToolResult return-shape mismatch was a
 *      tracked bug this gate originally SURFACED (pinned + flagged, not asserted).
 *      Fixed in #653 / 1.4.2 — PiToolResult is now the real AgentToolResult mirror,
 *      so the `_execReturn` row below asserts it GREEN (no longer a blind spot).
 */
import type {
  AgentSession as RealAgentSession,
  ExtensionContext as RealExtensionContext,
  ExtensionUIContext as RealExtensionUIContext,
  ExtensionAPI as RealExtensionAPI,
  WidgetPlacement as RealWidgetPlacement,
  ToolDefinition as RealToolDefinition,
  ToolCallEventResult as RealToolCallEventResult,
  AgentToolResult as RealAgentToolResult,
  ContextUsage as RealContextUsage,
  CustomToolCallEvent as RealCustomToolCallEvent,
} from '@earendil-works/pi-coding-agent';
import type { TObject } from 'typebox';
import type {
  PiOutboundMessage,
  PiCustomMessageOptions,
  PiContextUsage,
  PiExtensionContext,
  PiToolCallEvent,
  PiToolCallResult,
  PiToolResult,
} from '../../src/pi/pi-types';
import type {
  ExtensionUIContext as OurMcUI,
  McExtensionContext as OurMcCtx,
} from '../../src/pi/mission-control/pi-ui';

/**
 * `A extends B ? true : <error object>`. Used as `const _row: AssertAssignable<A,B>
 * = true;` — when A is assignable to B the type is `true` (assigning `true` is
 * fine); otherwise it's an object type and `= true` fails to compile, naming the
 * offending A/B in the error.
 */
type AssertAssignable<A, B> = A extends B ? true : { __DRIFT__: 'A is not assignable to B'; A: A; B: B };

/* ── PASS rows — OUR type → real parameter (we hand the value to Pi) ───────── */

// Our injected message satisfies sendCustomMessage's message param
// (Pick<CustomMessage, "customType"|"content"|"display"|"details"> — details optional).
export const _passMsg: AssertAssignable<
  PiOutboundMessage,
  Parameters<RealAgentSession['sendCustomMessage']>[0]
> = true;

// Our delivery options are a subset of the real options
// (ours {steer|followUp} ⊂ real {steer|followUp|nextTurn}).
export const _passOpts: AssertAssignable<
  PiCustomMessageOptions,
  NonNullable<Parameters<RealAgentSession['sendCustomMessage']>[1]>
> = true;

// #677 — interactive cue-injection routes through the STABLE `pi` ExtensionAPI
// handle (pi.sendMessage / pi.sendUserMessage) because Pi 0.78.1's
// SessionStartEvent carries no `session` field. Lock our shim's params assignable
// to the REAL ExtensionAPI methods (we hand the values TO Pi → PASS rows).
//   - sendMessage takes the SAME Pick<CustomMessage,…> shape as sendCustomMessage,
//   - sendMessage opts {steer|followUp|triggerTurn} ⊂ real {…|nextTurn},
//   - sendUserMessage takes a plain string (always triggers a turn).
export const _passSendMsg: AssertAssignable<
  PiOutboundMessage,
  Parameters<RealExtensionAPI['sendMessage']>[0]
> = true;
export const _passSendOpts: AssertAssignable<
  PiCustomMessageOptions,
  NonNullable<Parameters<RealExtensionAPI['sendMessage']>[1]>
> = true;
export const _passSendUserContent: AssertAssignable<
  string,
  Parameters<RealExtensionAPI['sendUserMessage']>[0]
> = true;

// Our widget placement union is EXACTLY the real WidgetPlacement (both directions).
export const _placementSubset: AssertAssignable<'aboveEditor' | 'belowEditor', RealWidgetPlacement> = true;
export const _placementSuperset: AssertAssignable<RealWidgetPlacement, 'aboveEditor' | 'belowEditor'> = true;

/* ── RECV rows — real type → ours (Pi hands us the value) ──────────────────── */

// The real handler ctx is usable as our narrowed PiExtensionContext
// (real has getContextUsage()/isIdle()/signal + extras like sessionManager).
export const _recvCtx: AssertAssignable<RealExtensionContext, PiExtensionContext> = true;

// mission-control shims (pi-ui.ts): Pi hands us the real ctx.ui / ctx, which our
// code consumes through the narrower Mc shims — so real must be assignable to ours.
// (Covers setWidget/select/confirm/input/notify on the UI surface, and {ui,hasUI}
// on the ctx. registerCommand/registerShortcut stay loose per the architect ruling
// — see _registerSurfaceExists below.)
export const _recvMcUI: AssertAssignable<RealExtensionUIContext, OurMcUI> = true;
export const _recvMcCtx: AssertAssignable<RealExtensionContext, OurMcCtx> = true;

// ContextUsage is an exact mirror (both directions — tokens/contextWindow/percent).
export const _recvUsage: AssertAssignable<RealContextUsage, PiContextUsage> = true;
export const _passUsage: AssertAssignable<PiContextUsage, RealContextUsage> = true;

// A real custom tool_call event is usable as our PiToolCallEvent.
export const _recvToolCall: AssertAssignable<RealCustomToolCallEvent, PiToolCallEvent> = true;

// The tool_call handler RESULT is an exact mirror (block?/reason?).
export const _recvToolResult: AssertAssignable<RealToolCallEventResult, PiToolCallResult> = true;
export const _passToolResult: AssertAssignable<PiToolCallResult, RealToolCallEventResult> = true;

/* ── ToolDefinition row — adapter output (render-tools.ts, post-C4) ─────────── */

/** The object shape render-tools.ts hands to `pi.registerTool` (post-C4 `label`). */
type AdapterToolOutput = {
  name: string;
  label: string;
  description: string;
  parameters: TObject; // zodShapeToTypeBox(...) → TObject ⊂ TSchema
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: unknown,
    onUpdate?: unknown,
    ctx?: unknown,
  ) => Promise<PiToolResult>;
};

// {name,label,description,parameters} are assignable to the real ToolDefinition's
// (TObject ⊂ TSchema). label is REQUIRED on the real side (C4 adds it).
export const _toolFields: AssertAssignable<
  Pick<AdapterToolOutput, 'name' | 'label' | 'description' | 'parameters'>,
  Pick<RealToolDefinition, 'name' | 'label' | 'description' | 'parameters'>
> = true;

// execute's 1st param is the toolCallId STRING (the corrected #651 positional
// contract). We assert only param0 here: param1 = Static<TParams> ≈ unknown for the
// generic default, so an assertion on it is vacuous — the real positional guard is
// _execParam0 + the #651 runtime test (test/pi-render-tools.test.ts). Return shape
// is asserted by _execReturn below.
export const _execParam0: AssertAssignable<Parameters<RealToolDefinition['execute']>[0], string> = true;

// execute RETURN: our PiToolResult (the AgentToolResult mirror as of 1.4.2/#653 —
// { content: [{type:'text',text}]; details; terminate? }) is assignable to the
// real AgentToolResult that `execute` must return. (This row was a pin+flag while
// the #653 result-shape bug was open; now that toPiResult emits the real shape it
// asserts GREEN — drift in either the content-element or details/terminate shape
// REDs here.)
export const _execReturn: AssertAssignable<PiToolResult, RealAgentToolResult<unknown>> = true;

/* ── CALL-SHAPE rows — representative calls must COMPILE (never executed) ───── */

// Every event name our extension wires STILL EXISTS on real ExtensionAPI.on
// (types.d.ts:787-811). A bare lambda lets tsc infer each overload's (event, ctx)
// types — so if Pi renames/removes an event we handle, the matching line REDs.
// (We assert event EXISTENCE, not our PiEventHandler's full variance — passing a
// broadly-typed handler into Pi's per-event overloads trips overload-resolution
// noise that isn't a real drift signal; the handler ctx shape is locked by the
// _recvCtx row above.)
export function _onEventNamesExist(pi: RealExtensionAPI): void {
  pi.on('session_start', (_e, _ctx) => {});
  pi.on('agent_start', (_e, _ctx) => {});
  pi.on('agent_end', (_e, _ctx) => {});
  pi.on('turn_start', (_e, _ctx) => {});
  pi.on('turn_end', (_e, _ctx) => {});
  pi.on('tool_call', (_e, _ctx) => {});
  pi.on('tool_execution_start', (_e, _ctx) => {});
  pi.on('tool_execution_end', (_e, _ctx) => {});
  pi.on('message_update', (_e, _ctx) => {});
  pi.on('session_shutdown', (_e, _ctx) => {});
}

// Our setWidget call shape compiles against the real ExtensionUIContext
// (string-lines overload + the undefined-clears form).
export function _setWidgetCallShape(ui: RealExtensionUIContext): void {
  ui.setWidget('mission-control', ['line 1', 'line 2'], { placement: 'belowEditor' });
  ui.setWidget('mission-control', undefined);
}

// registerCommand / registerShortcut / registerTool still EXIST on real
// ExtensionAPI (catches removal/rename). LOOSE on purpose — we do not assert the
// full option shape (would ripple McCommandHandler/shortcut types — architect ruling).
export function _registerSurfaceExists(pi: RealExtensionAPI): void {
  const _rc: RealExtensionAPI['registerCommand'] = pi.registerCommand;
  const _rs: RealExtensionAPI['registerShortcut'] = pi.registerShortcut;
  const _rt: RealExtensionAPI['registerTool'] = pi.registerTool;
  void _rc, _rs, _rt;
}

// #677 — our exact cue-injection calls COMPILE against the real ExtensionAPI
// (catches removal/rename + param drift of sendMessage/sendUserMessage in one row).
export function _sendSurfaceCallShape(pi: RealExtensionAPI): void {
  pi.sendMessage({ customType: 'cue', content: 'x', display: true }, { deliverAs: 'followUp', triggerTurn: true });
  pi.sendUserMessage('x', { deliverAs: 'followUp' });
}
