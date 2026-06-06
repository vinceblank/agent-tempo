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

/** The `pi` object passed to the extension's default export — slice we use. */
export interface McExtensionAPI {
  on(event: string, handler: McEventHandler): void;
  registerCommand(name: string, options: { description?: string; handler: McCommandHandler }): void;
  registerShortcut(shortcut: unknown, options: { description?: string; handler: McShortcutHandler }): void;
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
