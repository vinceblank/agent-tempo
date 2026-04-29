/**
 * useAutofill — chat-input autocomplete state machine for the dashboard
 * Composer (#471/#472).
 *
 * Mirrors the TUI's PromptArea palette logic (src/tui/components/PromptArea.tsx +
 * src/tui/store.ts PALETTE_* actions) using the same shared helpers
 * (src/palette). Surfaces a small reactive contract the Composer can
 * wire keyboard handlers + popup rendering against.
 *
 * Hook contract:
 *   const a = useAutofill({ value, commands, players, onApply });
 *   a.visible      // boolean — popup should render
 *   a.items        // string[] — filtered + ordered names
 *   a.selectedIndex // number — current highlight (0-based)
 *   a.up()         // ↑ — move selection up (clamped at 0)
 *   a.down()       // ↓ — move selection down (clamped at items.length - 1)
 *   a.accept()     // Tab / Enter (when popup visible) — invoke onApply
 *                  // with the replacement text. Returns false if no
 *                  // selection to apply.
 *   a.close()      // Esc — force-close the popup until value changes again
 *   a.reset()      // Submit — close + clear cached selection
 *
 * The hook NEVER calls setState during render and never reads DOM. Pure
 * React state derived from `value` + the shared palette helpers.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  classifyPaletteInput,
  filterPaletteCommands,
  filterPlayerNames,
  type PaletteContext,
} from 'claude-tempo/palette';
import type { DashboardCommandMeta } from './dashboard-commands';

export interface AutofillItem {
  /** The token to insert (command name or player name). */
  name: string;
  /** Optional description shown next to the name in the popup. */
  description?: string;
}

export interface UseAutofillOptions {
  /** Current input value. */
  value: string;
  /** Command metadata, used for `/` mode. Empty disables command autofill. */
  commands?: readonly DashboardCommandMeta[];
  /** Player names, used for `@` and player-arg modes. Empty disables. */
  players?: readonly string[];
  /**
   * Called when the user accepts a selection. Receives the new input
   * value (with prefix preserved + selected name appended + trailing
   * space) so the parent can update the controlled input.
   */
  onApply: (next: string) => void;
}

export interface AutofillState {
  visible: boolean;
  items: AutofillItem[];
  selectedIndex: number;
  /** Active palette mode (only meaningful when `visible` is true). */
  mode: PaletteContext['mode'] | null;
  up: () => void;
  down: () => void;
  /**
   * Apply the current selection. Returns true when a replacement was
   * dispatched, false when there's nothing selected (caller should fall
   * through to default keyboard behaviour).
   */
  accept: () => boolean;
  /**
   * Apply the item at a specific index — used by mouse-click handlers
   * where the clicked row may differ from the keyboard-highlighted one.
   * Returns false if the index is out of range or the popup is hidden.
   */
  acceptAt: (index: number) => boolean;
  close: () => void;
  reset: () => void;
}

/**
 * Build the items list for a given palette context. Pure helper, exported
 * for unit tests so the hook's behaviour can be pinned without rendering.
 */
export function buildAutofillItems(
  ctx: PaletteContext,
  commands: readonly DashboardCommandMeta[],
  players: readonly string[],
): AutofillItem[] {
  if (ctx.mode === 'command') {
    if (commands.length === 0) return [];
    return filterPaletteCommands(commands, ctx.partial).map((c) => ({
      name: c.name,
      description: c.description,
    }));
  }
  // Both 'player' and 'player-arg' modes match against player names.
  if (players.length === 0) return [];
  return filterPlayerNames(players, ctx.partial).map((name) => ({ name }));
}

export function useAutofill(opts: UseAutofillOptions): AutofillState {
  const { value, commands = [], players = [], onApply } = opts;

  // Forced-closed flag: when the user hits Escape we hide the popup until
  // the value changes (so a fresh "/r" keystroke re-opens it without
  // having to backspace + retype).
  const [forcedClosed, setForcedClosed] = useState(false);
  const lastValueRef = useRef(value);
  useEffect(() => {
    if (lastValueRef.current !== value) {
      setForcedClosed(false);
      lastValueRef.current = value;
    }
  }, [value]);

  const ctx = useMemo(() => classifyPaletteInput(value), [value]);
  const items = useMemo(() => {
    if (!ctx) return [];
    return buildAutofillItems(ctx, commands, players);
  }, [ctx, commands, players]);

  const visible = !forcedClosed && ctx !== null && items.length > 0;

  const [selectedIndex, setSelectedIndex] = useState(0);
  // Clamp the index back into range whenever the items list shrinks (e.g.
  // user typed another character and three options collapsed to one).
  useEffect(() => {
    if (selectedIndex >= items.length) setSelectedIndex(0);
  }, [items.length, selectedIndex]);
  // Reset to the top whenever the palette re-opens or the mode flips.
  const lastModeRef = useRef<string | null>(null);
  useEffect(() => {
    const m = ctx?.mode ?? null;
    if (lastModeRef.current !== m) {
      setSelectedIndex(0);
      lastModeRef.current = m;
    }
  }, [ctx?.mode]);

  const up = useCallback(() => {
    setSelectedIndex((i) => Math.max(0, i - 1));
  }, []);
  const down = useCallback(() => {
    setSelectedIndex((i) => {
      // The hook reads items.length via closure capture — fine because
      // items is stable per render and this callback fires on key events
      // that always trigger a render after the state update.
      return Math.min(items.length - 1, i + 1);
    });
  }, [items.length]);

  const acceptAt = useCallback(
    (index: number): boolean => {
      if (!visible || !ctx) return false;
      const item = items[index];
      if (!item) return false;
      const next = `${ctx.replacePrefix}${item.name} `;
      onApply(next);
      return true;
    },
    [visible, ctx, items, onApply],
  );

  const accept = useCallback((): boolean => acceptAt(selectedIndex), [acceptAt, selectedIndex]);

  const close = useCallback(() => {
    setForcedClosed(true);
  }, []);

  const reset = useCallback(() => {
    setForcedClosed(false);
    setSelectedIndex(0);
  }, []);

  return {
    visible,
    items,
    selectedIndex,
    mode: ctx?.mode ?? null,
    up,
    down,
    accept,
    acceptAt,
    close,
    reset,
  };
}
