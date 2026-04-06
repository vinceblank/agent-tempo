/**
 * PromptArea — pinned bottom input area with tab completion and command history.
 *
 * Uses useInput for raw key handling instead of ink-text-input, giving full
 * control over Tab (completion) and Up/Down arrows (history).
 *
 * All mutable state accessed via refs to keep useInput callback stable
 * and avoid input lag from callback recreation on every keystroke.
 */
import React, { useState, useCallback, useRef } from 'react';
import { useInk } from '../ink-context';
import { THEME } from '../utils/theme';

const MAX_HISTORY = 50;

/** Commands that take a player name as their first argument. */
const PLAYER_ARG_COMMANDS = new Set(['cue', 'stop', 'encore', 'recall']);

export interface PromptAreaProps {
  /** Hint text displayed above the input. */
  hints: string;
  /** Current input value (controlled). */
  value: string;
  /** Called when input text changes. */
  onChange: (value: string) => void;
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
}

export const PromptArea = React.memo(function PromptArea({
  hints,
  value,
  onChange,
  onSubmit,
  disabled,
  commandNames = [],
  playerNames = [],
  initialHistory = [],
  onHistoryUpdate,
  paletteVisible,
  onPaletteToggle,
  onPaletteUp,
  onPaletteDown,
  onPaletteSelect,
}: PromptAreaProps) {
  const { Box, Text, useInput } = useInk();

  // ── Internal state ──
  const [history, setHistory] = useState<string[]>(() => [...initialHistory]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const savedInput = useRef('');
  const [completionHint, setCompletionHint] = useState('');
  const [tabMatches, setTabMatches] = useState<string[]>([]);
  const [tabCycleIndex, setTabCycleIndex] = useState(0);

  // ── Ref for all values the useInput callback reads (stable callback pattern) ──
  const ref = useRef({
    value, onChange, onSubmit, disabled, commandNames, playerNames,
    history, historyIndex, tabMatches, tabCycleIndex,
    paletteVisible, onPaletteToggle, onPaletteUp, onPaletteDown, onPaletteSelect,
    onHistoryUpdate,
  });
  ref.current = {
    value, onChange, onSubmit, disabled, commandNames, playerNames,
    history, historyIndex, tabMatches, tabCycleIndex,
    paletteVisible, onPaletteToggle, onPaletteUp, onPaletteDown, onPaletteSelect,
    onHistoryUpdate,
  };

  // ── Helpers (read from ref) ──

  const doChange = useCallback((newValue: string) => {
    const r = ref.current;
    r.onChange(newValue);
    setCompletionHint('');
    setTabMatches([]);
    setTabCycleIndex(0);
    if (r.onPaletteToggle) {
      const trimmed = newValue.trimStart();
      r.onPaletteToggle(trimmed.startsWith('/') && !trimmed.includes(' '));
    }
  }, []);

  const getCompletions = useCallback((input: string): string[] => {
    const r = ref.current;
    const trimmed = input.trimStart();

    if (trimmed.startsWith('/') && !trimmed.includes(' ')) {
      const partial = trimmed.slice(1).toLowerCase();
      if (!partial) return r.commandNames.map(c => `/${c} `);
      return r.commandNames
        .filter(c => c.startsWith(partial) && c !== partial)
        .map(c => `/${c} `);
    }

    if (trimmed.startsWith('/') && trimmed.includes(' ')) {
      const spaceIdx = trimmed.indexOf(' ');
      const cmdName = trimmed.slice(1, spaceIdx).toLowerCase();
      if (PLAYER_ARG_COMMANDS.has(cmdName)) {
        const afterCmd = trimmed.slice(spaceIdx + 1);
        if (!afterCmd.includes(' ')) {
          const partial = afterCmd.toLowerCase();
          if (!partial) return r.playerNames.map(p => `/${cmdName} ${p} `);
          return r.playerNames
            .filter(p => p.toLowerCase().startsWith(partial) && p.toLowerCase() !== partial)
            .map(p => `/${cmdName} ${p} `);
        }
      }
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
        r.onChange(matches[0]);
        setCompletionHint('');
        setTabMatches([]);
        setTabCycleIndex(0);
      } else {
        const newMatches = r.tabMatches.length > 0 ? r.tabMatches : matches;
        const idx = r.tabMatches.length > 0 ? (r.tabCycleIndex + 1) % newMatches.length : 0;
        r.onChange(newMatches[idx]);
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
      r.onChange(r.history[r.history.length - 1 - newIdx]);
      setCompletionHint('');
      setTabMatches([]);
      return;
    }

    // Down arrow: next history
    if (key.downArrow && !r.paletteVisible) {
      if (r.historyIndex <= 0) {
        setHistoryIndex(-1);
        r.onChange(savedInput.current);
        return;
      }
      const newIdx = r.historyIndex - 1;
      setHistoryIndex(newIdx);
      r.onChange(r.history[r.history.length - 1 - newIdx]);
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
  }, [doChange, getCompletions])); // Stable — reads ref.current

  // ── Render ──
  const cursorChar = '\u2588'; // █

  return React.createElement(Box, { flexDirection: 'column', paddingX: 1 },
    React.createElement(Box, null,
      React.createElement(Text, { color: THEME.dim }, hints),
    ),
    completionHint
      ? React.createElement(Box, null,
          React.createElement(Text, { color: THEME.muted }, `  ${completionHint}`),
        )
      : null,
    React.createElement(Box, null,
      React.createElement(Text, { bold: true, color: THEME.accent }, '> '),
      disabled
        ? React.createElement(Text, { color: THEME.muted }, '...')
        : React.createElement(React.Fragment, null,
            React.createElement(Text, { color: THEME.text }, value),
            React.createElement(Text, { color: THEME.accent }, cursorChar),
          ),
    ),
  );
});
