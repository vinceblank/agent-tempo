/**
 * PromptArea — pinned bottom input area with tab completion and command history.
 *
 * UNCONTROLLED: Input value lives in local useState, NOT in parent state.
 * This prevents parent re-renders on every keystroke, keeping Yoga node
 * recalculation to this subtree only (~4 nodes).
 *
 * Parent communicates via:
 * - inputRef.current.setValue(v) — to set input programmatically (palette select)
 * - inputRef.current.getValue() — to read current value
 * - onInputChange(v) — called on every keystroke (for palette filtering via ref, no dispatch)
 * - onSubmit(v) — called on Enter
 */
import React, { useState, useCallback, useRef, useImperativeHandle } from 'react';
import { useInk } from '../ink-context';
import { THEME } from '../utils/theme';
import { PLAYER_PARAM_COMMANDS, SUBCOMMAND_MAP } from '../commands';

const MAX_HISTORY = 50;

/** Commands that take a player name as their first argument. */

export interface PromptAreaHandle {
  setValue: (v: string) => void;
  getValue: () => string;
}

export interface PromptAreaProps {
  /** Hint text displayed above the input. */
  hints: string;
  /** Called when user presses Enter. */
  onSubmit: (value: string) => void;
  /** Disable input (e.g., during splash or recruit wizard). */
  disabled?: boolean;
  /** Available command names (without '/') for tab completion. */
  commandNames?: string[];
  /** Available player names for argument completion. */
  playerNames?: string[];
  /** Initial command history (loaded from disk). */
  initialHistory?: string[];
  /** Called when history is updated (for persistence). */
  onHistoryUpdate?: (entries: string[]) => void;
  /** Called on every input change (lightweight — caller should use ref, not dispatch). */
  onInputChange?: (value: string) => void;
  /** Whether the command palette is visible. */
  paletteVisible?: boolean;
  /** Called when palette should show/hide. */
  onPaletteToggle?: (visible: boolean) => void;
  /** Called to navigate palette up. */
  onPaletteUp?: () => void;
  /** Called to navigate palette down. */
  onPaletteDown?: () => void;
  /** Called when palette item is selected. */
  onPaletteSelect?: () => void;
  /** Ref for parent to read/set input value. */
  inputRef?: React.Ref<PromptAreaHandle>;
}

export const PromptArea = React.memo(function PromptArea({
  hints,
  onSubmit,
  disabled,
  commandNames = [],
  playerNames = [],
  initialHistory = [],
  onHistoryUpdate,
  onInputChange,
  paletteVisible,
  onPaletteToggle,
  onPaletteUp,
  onPaletteDown,
  onPaletteSelect,
  inputRef,
}: PromptAreaProps) {
  const { Box, Text, useInput } = useInk();

  // ── LOCAL input state (uncontrolled — no parent dispatch per keystroke) ──
  const [value, setValueState] = useState('');
  const valueRef = useRef('');

  const setValue = useCallback((v: string) => {
    valueRef.current = v;
    ref.current.value = v; // Keep ref in sync between renders (prevents stale reads on rapid input)
    setValueState(v);
  }, []);

  // ── Expose handle for parent ──
  useImperativeHandle(inputRef, () => ({
    setValue: (v: string) => setValue(v),
    getValue: () => valueRef.current,
  }), [setValue]);

  // ── Internal state ──
  const [history, setHistory] = useState<string[]>(() => [...initialHistory]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const savedInput = useRef('');
  const [completionHint, setCompletionHint] = useState('');
  const [tabMatches, setTabMatches] = useState<string[]>([]);
  const [tabCycleIndex, setTabCycleIndex] = useState(0);

  // ── Ref for all values the useInput callback reads (stable callback pattern) ──
  const ref = useRef({
    value: '', onSubmit, disabled, commandNames, playerNames,
    history, historyIndex, tabMatches, tabCycleIndex,
    paletteVisible, onPaletteToggle, onPaletteUp, onPaletteDown, onPaletteSelect,
    onHistoryUpdate, onInputChange,
  });
  ref.current = {
    value: valueRef.current, onSubmit, disabled, commandNames, playerNames,
    history, historyIndex, tabMatches, tabCycleIndex,
    paletteVisible, onPaletteToggle, onPaletteUp, onPaletteDown, onPaletteSelect,
    onHistoryUpdate, onInputChange,
  };

  // ── Helpers (read from ref) ──

  const doChange = useCallback((newValue: string) => {
    const r = ref.current;
    setValue(newValue);
    r.onInputChange?.(newValue);
    // Avoid new refs when already in default state — prevents unnecessary re-renders
    setCompletionHint(prev => prev === '' ? prev : '');
    setTabMatches(prev => prev.length === 0 ? prev : []);
    setTabCycleIndex(prev => prev === 0 ? prev : 0);
    // Only toggle palette when visibility actually changes — avoids parent dispatch on every keystroke
    if (r.onPaletteToggle) {
      const trimmed = newValue.trimStart();
      const shouldShow = trimmed.startsWith('/') && !trimmed.includes(' ');
      if (shouldShow !== !!r.paletteVisible) {
        r.onPaletteToggle(shouldShow);
      }
    }
  }, [setValue]);

  // PLAYER_PARAM_COMMANDS and SUBCOMMAND_MAP imported from commands.ts

  const getCompletions = useCallback((input: string): string[] => {
    const r = ref.current;
    const trimmed = input.trimStart();

    // Command name completion: /par → /players
    if (trimmed.startsWith('/') && !trimmed.includes(' ')) {
      const partial = trimmed.slice(1).toLowerCase();
      if (!partial) return r.commandNames.map(c => `/${c} `);
      return r.commandNames
        .filter(c => c.startsWith(partial) && c !== partial)
        .map(c => `/${c} `);
    }

    // Parameter completion: /chat te → /chat tempo-eng
    if (trimmed.startsWith('/') && trimmed.includes(' ')) {
      const spaceIdx = trimmed.indexOf(' ');
      const cmd = trimmed.slice(1, spaceIdx).toLowerCase();
      const afterCmd = trimmed.slice(spaceIdx + 1);
      const parts = afterCmd.split(' ');
      const partial = parts[parts.length - 1].toLowerCase();
      const prefix = trimmed.slice(0, trimmed.length - parts[parts.length - 1].length);

      // First param: player name for player commands (prefix + segment match)
      if (parts.length === 1 && PLAYER_PARAM_COMMANDS.has(cmd)) {
        const names = r.playerNames || [];
        const matches = names.filter(n => {
          const lower = n.toLowerCase();
          if (lower === partial) return false;
          return lower.startsWith(partial) || lower.split('-').some(seg => seg.startsWith(partial));
        });
        if (matches.length > 0) return matches.map(n => `${prefix}${n} `);
      }

      // First param: subcommand for structured commands
      if (parts.length === 1 && SUBCOMMAND_MAP[cmd]) {
        const subs = SUBCOMMAND_MAP[cmd];
        const matches = subs.filter(s => s.startsWith(partial) && s !== partial);
        if (matches.length > 0) return matches.map(s => `${prefix}${s} `);
      }

      // Second param after subcommand: player name for worktree create/remove
      if (parts.length === 2 && cmd === 'worktree' && (parts[0] === 'create' || parts[0] === 'remove')) {
        const names = r.playerNames || [];
        const matches = names.filter(n => n.toLowerCase().startsWith(partial) && n.toLowerCase() !== partial);
        if (matches.length > 0) return matches.map(n => `${prefix}${n} `);
      }

      return [];
    }

    return [];
  }, []);

  // ── Stable useInput callback (never recreated) ──
  useInput(useCallback((input: string, key: any) => {
    const r = ref.current;
    if (r.disabled) return;

    // ── Command palette mode ──
    if (r.paletteVisible) {
      if (key.upArrow) { r.onPaletteUp?.(); return; }
      if (key.downArrow) { r.onPaletteDown?.(); return; }
      if (key.tab) { r.onPaletteSelect?.(); return; }
      if (key.return) {
        const trimmedInput = r.value.trim();
        const cmdName = trimmedInput.startsWith('/') ? trimmedInput.slice(1).toLowerCase() : '';
        if (cmdName && r.commandNames.includes(cmdName)) {
          r.onPaletteToggle?.(false);
          // Fall through to Enter/submit below
        } else {
          r.onPaletteSelect?.();
          return;
        }
      }
      if (key.escape) { r.onPaletteToggle?.(false); return; }
    }

    // Tab: complete
    if (key.tab) {
      const matches = r.tabMatches.length > 0 ? r.tabMatches : getCompletions(r.value);
      if (matches.length === 0) return;
      if (matches.length === 1) {
        setValue(matches[0]);
        r.onInputChange?.(matches[0]);
        setCompletionHint('');
        setTabMatches([]);
        setTabCycleIndex(0);
      } else {
        const newMatches = r.tabMatches.length > 0 ? r.tabMatches : matches;
        const idx = r.tabMatches.length > 0 ? (r.tabCycleIndex + 1) % newMatches.length : 0;
        setValue(newMatches[idx]);
        r.onInputChange?.(newMatches[idx]);
        setTabMatches(newMatches);
        setTabCycleIndex(idx);
        const options = newMatches.map(m => m.trim().split(/\s+/).pop() || '');
        setCompletionHint(options.join('  '));
      }
      return;
    }

    // Up arrow: previous history
    if (key.upArrow && !r.paletteVisible) {
      if (r.history.length === 0) return;
      if (r.historyIndex === -1) savedInput.current = r.value;
      const newIdx = Math.min(r.historyIndex + 1, r.history.length - 1);
      setHistoryIndex(newIdx);
      const histValue = r.history[r.history.length - 1 - newIdx];
      setValue(histValue);
      r.onInputChange?.(histValue);
      setCompletionHint('');
      setTabMatches([]);
      return;
    }

    // Down arrow: next history
    if (key.downArrow && !r.paletteVisible) {
      if (r.historyIndex <= 0) {
        setHistoryIndex(-1);
        setValue(savedInput.current);
        r.onInputChange?.(savedInput.current);
        return;
      }
      const newIdx = r.historyIndex - 1;
      setHistoryIndex(newIdx);
      const histValue = r.history[r.history.length - 1 - newIdx];
      setValue(histValue);
      r.onInputChange?.(histValue);
      setCompletionHint('');
      setTabMatches([]);
      return;
    }

    // Enter: submit
    if (key.return) {
      const trimmed = r.value.trim();
      if (trimmed) {
        if (r.history.length === 0 || r.history[r.history.length - 1] !== trimmed) {
          const updated = [...r.history, trimmed].slice(-MAX_HISTORY);
          setHistory(updated);
          if (r.onHistoryUpdate) r.onHistoryUpdate(updated);
        }
        setHistoryIndex(-1);
        savedInput.current = '';
        r.onSubmit(trimmed);
      }
      setValue('');
      r.onInputChange?.('');
      setCompletionHint('');
      setTabMatches([]);
      return;
    }

    // Backspace
    if (key.backspace || key.delete) {
      if (r.value.length > 0) doChange(r.value.slice(0, -1));
      return;
    }

    // Regular character input
    if (input && !key.ctrl && !key.meta) {
      doChange(r.value + input);
    }
  }, [doChange, getCompletions, setValue])); // Stable — reads ref.current

  // ── Render (minimal nodes: 1 Box + 2-3 Text, nested Text = 0 Yoga nodes) ──

  return React.createElement(Box, { flexDirection: 'column', paddingX: 1 },
    completionHint
      ? React.createElement(Text, { color: THEME.muted }, `  ${completionHint}`)
      : null,
    // Prompt line with inline placeholder hint (like Claude Code)
    React.createElement(Text, null,
      React.createElement(Text, { bold: true, color: THEME.accent }, '\u276F '),
      disabled
        ? React.createElement(Text, { color: THEME.muted }, '...')
        : value
          ? React.createElement(React.Fragment, null,
              React.createElement(Text, { color: THEME.text }, value),
              React.createElement(Text, { color: THEME.accent }, '\u2588'),
            )
          : React.createElement(React.Fragment, null,
              React.createElement(Text, { color: THEME.accent }, '\u2588'),
              React.createElement(Text, { color: THEME.dim }, hints),
            ),
    ),
  );
});
