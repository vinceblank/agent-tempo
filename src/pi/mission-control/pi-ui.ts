/**
 * Hand-written structural slice of Pi's extension UI + command API that
 * mission-control consumes (3f). Kept LOCAL (not in the shared `src/pi/pi-types.ts`)
 * so this feature is self-contained and `tsc` stays green WITHOUT the optional
 * `@earendil-works/pi-coding-agent` dep installed. Mirrors the installed SDK's
 * `dist/core/extensions/types.d.ts` (verified 0.78.0): `ctx.ui.setWidget` /
 * `select` / `confirm` / `input` / `notify`, `registerCommand`, `registerShortcut`.
 */

export interface ExtensionUIDialogOptions {
  signal?: AbortSignal;
  timeout?: number;
}

/** The `ctx.ui` surface (present only when `ctx.hasUI`). */
export interface ExtensionUIContext {
  /** Persistent widget: re-call with new lines to update; `undefined` clears it. */
  setWidget(
    key: string,
    content: string[] | undefined,
    options?: { placement?: 'aboveEditor' | 'belowEditor' },
  ): void;
  select(title: string, options: string[], opts?: ExtensionUIDialogOptions): Promise<string | undefined>;
  confirm(title: string, message: string, opts?: ExtensionUIDialogOptions): Promise<boolean>;
  input(title: string, placeholder?: string, opts?: ExtensionUIDialogOptions): Promise<string | undefined>;
  notify(message: string): void;
}

/** Context passed to every handler. `ui` is only safe to use when `hasUI`. */
export interface McExtensionContext {
  ui: ExtensionUIContext;
  hasUI: boolean;
}

export type McEventHandler = (event: unknown, ctx: McExtensionContext) => void | Promise<void>;
export type McCommandHandler = (args: string, ctx: McExtensionContext) => void | Promise<void>;
export type McShortcutHandler = (ctx: McExtensionContext) => void | Promise<void>;

/**
 * A message injected into the live planner session via
 * {@link McExtensionAPI.sendMessage}. Mirrors Pi's `PiOutboundMessage` slice
 * (`Pick<CustomMessage, "customType"|"content"|"display">`); kept local so this
 * feature stays self-contained without the optional Pi dep. (#700 P2)
 */
export interface McOutboundMessage {
  customType: string;
  content: string;
  display: boolean;
}

/** Options for {@link McExtensionAPI.sendMessage}. Mirrors Pi's `PiCustomMessageOptions`. */
export interface McMessageOptions {
  triggerTurn?: boolean;
  deliverAs?: 'steer' | 'followUp';
}

/** Result of a planner LLM tool — mirrors Pi's `PiToolResult`. (#700 P2) */
export interface McToolResult {
  content: Array<{ type: 'text'; text: string }>;
  details: Record<string, unknown>;
  terminate?: boolean;
}

/**
 * A planner LLM tool registered via {@link McExtensionAPI.registerTool} — mirrors
 * Pi's `PiToolDefinition` slice. `parameters` is a TypeBox schema (derived from a
 * zod shape via the shared converter). `execute` is called POSITIONALLY by Pi:
 * `(toolCallId, params, signal?, onUpdate?, ctx?)`. (#700 P2)
 */
export interface McToolDefinition {
  name: string;
  label: string;
  description?: string;
  parameters: unknown;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: unknown,
    onUpdate?: unknown,
    ctx?: unknown,
  ) => Promise<McToolResult> | McToolResult;
}

/** The `pi` object passed to the extension's default export — slice we use. */
export interface McExtensionAPI {
  on(event: string, handler: McEventHandler): void;
  registerCommand(name: string, options: { description?: string; handler: McCommandHandler }): void;
  registerShortcut(shortcut: unknown, options: { description?: string; handler: McShortcutHandler }): void;
  /**
   * Register a planner LLM tool (#700 P2 — the "planner thinks with tools" half).
   * Optional in the slice: only the interactive Pi CLI exposes a tool surface to
   * its own LLM. Mirrors Pi's `ExtensionAPI.registerTool`.
   */
  registerTool?(def: McToolDefinition): void;
  /**
   * Inject a message into the live planner session — the #700 P2 answer-wake
   * path (the planner has no Temporal inbox; its inbound channel is the SSE
   * stream, so an `answer` event is turned into a `triggerTurn` injection here,
   * the planner-side mirror of the cue-pump). Optional in the slice (Pi
   * provides it; a fake/older Pi may not — callers feature-detect with `typeof`).
   * Mirrors Pi's `ExtensionAPI.sendMessage`.
   */
  sendMessage?(message: McOutboundMessage, options?: McMessageOptions): void;
}
