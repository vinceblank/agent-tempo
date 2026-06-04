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

/** The `pi` object passed to the extension's default export — slice we use. */
export interface McExtensionAPI {
  on(event: string, handler: McEventHandler): void;
  registerCommand(name: string, options: { description?: string; handler: McCommandHandler }): void;
  registerShortcut(shortcut: unknown, options: { description?: string; handler: McShortcutHandler }): void;
}
