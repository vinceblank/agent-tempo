/**
 * PromptArea — pinned bottom input area with tab completion and command history.
 *
 * Uses useInput for raw key handling instead of ink-text-input, giving full
 * control over Tab (completion) and Up/Down arrows (history).
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
}

export function PromptArea({
  hints,
  value,
  onChange,
  onSubmit,
  disabled,
  commandNames = [],
  playerNames = [],
}: PromptAreaProps) {
  const { Box, Text, useInput } = useInk();

  // ── Command history ──
  const [history] = useState<string[]>(() => []);
  const [historyIndex, setHistoryIndex] = useState(-1);
  // Stash the current input when user starts browsing history
  const savedInput = useRef('');

  // ── Tab completion ──
  const [completionHint, setCompletionHint] = useState('');
  const [tabMatches, setTabMatches] = useState<string[]>([]);
  const [tabCycleIndex, setTabCycleIndex] = useState(0);

  // Clear completion hint when input changes from typing
  const handleChange = useCallback((newValue: string) => {
    onChange(newValue);
    setCompletionHint('');
    setTabMatches([]);
    setTabCycleIndex(0);
  }, [onChange]);

  // Compute completions for the current input
  const getCompletions = useCallback((input: string): string[] => {
    const trimmed = input.trimStart();

    // Command completion: /par → /parseCommand, /players
    if (trimmed.startsWith('/') && !trimmed.includes(' ')) {
      const partial = trimmed.slice(1).toLowerCase();
      if (!partial) return commandNames.map(c => `/${c} `);
      return commandNames
        .filter(c => c.startsWith(partial) && c !== partial)
        .map(c => `/${c} `);
    }

    // Argument completion: /cue tem → /cue tempo-eng
    if (trimmed.startsWith('/') && trimmed.includes(' ')) {
      const spaceIdx = trimmed.indexOf(' ');
      const cmdName = trimmed.slice(1, spaceIdx).toLowerCase();

      if (PLAYER_ARG_COMMANDS.has(cmdName)) {
        const afterCmd = trimmed.slice(spaceIdx + 1);
        // Only complete the first argument (player name)
        if (!afterCmd.includes(' ')) {
          const partial = afterCmd.toLowerCase();
          if (!partial) return playerNames.map(p => `/${cmdName} ${p} `);
          return playerNames
            .filter(p => p.toLowerCase().startsWith(partial) && p.toLowerCase() !== partial)
            .map(p => `/${cmdName} ${p} `);
        }
      }
    }

    return [];
  }, [commandNames, playerNames]);

  useInput(useCallback((input: string, key: any) => {
    if (disabled) return;

    // Tab: complete
    if (key.tab) {
      const matches = tabMatches.length > 0 ? tabMatches : getCompletions(value);

      if (matches.length === 0) return;

      if (matches.length === 1) {
        // Single match — apply it
        onChange(matches[0]);
        setCompletionHint('');
        setTabMatches([]);
        setTabCycleIndex(0);
      } else {
        // Multiple matches — cycle through them
        const newMatches = tabMatches.length > 0 ? tabMatches : matches;
        const idx = tabMatches.length > 0 ? (tabCycleIndex + 1) % newMatches.length : 0;
        onChange(newMatches[idx]);
        setTabMatches(newMatches);
        setTabCycleIndex(idx);
        // Show all options as hint
        const options = newMatches.map(m => {
          // Extract the last word (completed part)
          const parts = m.trim().split(/\s+/);
          return parts[parts.length - 1];
        });
        setCompletionHint(options.join('  '));
      }
      return;
    }

    // Up arrow: previous history
    if (key.upArrow) {
      if (history.length === 0) return;
      if (historyIndex === -1) {
        // Start browsing — save current input
        savedInput.current = value;
      }
      const newIdx = Math.min(historyIndex + 1, history.length - 1);
      setHistoryIndex(newIdx);
      onChange(history[history.length - 1 - newIdx]);
      setCompletionHint('');
      setTabMatches([]);
      return;
    }

    // Down arrow: next history (or back to current input)
    if (key.downArrow) {
      if (historyIndex <= 0) {
        setHistoryIndex(-1);
        onChange(savedInput.current);
        return;
      }
      const newIdx = historyIndex - 1;
      setHistoryIndex(newIdx);
      onChange(history[history.length - 1 - newIdx]);
      setCompletionHint('');
      setTabMatches([]);
      return;
    }

    // Enter: submit
    if (key.return) {
      const trimmed = value.trim();
      if (trimmed) {
        // Push to history (avoid duplicates of the last entry)
        if (history.length === 0 || history[history.length - 1] !== trimmed) {
          history.push(trimmed);
          if (history.length > MAX_HISTORY) history.shift();
        }
        setHistoryIndex(-1);
        savedInput.current = '';
        onSubmit(trimmed);
      }
      setCompletionHint('');
      setTabMatches([]);
      return;
    }

    // Backspace
    if (key.backspace || key.delete) {
      if (value.length > 0) {
        handleChange(value.slice(0, -1));
      }
      return;
    }

    // Regular character input
    if (input && !key.ctrl && !key.meta) {
      handleChange(value + input);
    }
  }, [disabled, value, onChange, onSubmit, history, historyIndex, getCompletions, tabMatches, tabCycleIndex, handleChange]));

  // ── Render ──

  // Show cursor as a block character after the text
  const cursorChar = '\u2588'; // █

  return React.createElement(Box, { flexDirection: 'column', paddingX: 1 },
    // Hint line
    React.createElement(Box, null,
      React.createElement(Text, { color: THEME.dim }, hints),
    ),
    // Completion hint (shown when tab cycling)
    completionHint
      ? React.createElement(Box, null,
          React.createElement(Text, { color: THEME.muted }, `  ${completionHint}`),
        )
      : null,
    // Input line
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
}
