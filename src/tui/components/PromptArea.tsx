/**
 * PromptArea — pinned bottom input area for the TUI shell.
 * Top line: command hints in dim text.
 * Bottom line: ">" prompt with text input.
 */
import React from 'react';
import { useInk } from '../ink-context';
import { THEME } from '../utils/theme';

export interface PromptAreaProps {
  /** Hint text displayed above the input (e.g., "/cue /recruit /stop /help /quit"). */
  hints: string;
  /** Current input value (controlled). */
  value: string;
  /** Called when input text changes. */
  onChange: (value: string) => void;
  /** Called when user presses Enter. */
  onSubmit: (value: string) => void;
  /** Disable input (e.g., during splash). */
  disabled?: boolean;
}

export function PromptArea({ hints, value, onChange, onSubmit, disabled }: PromptAreaProps) {
  const { Box, Text, TextInput } = useInk();

  return React.createElement(Box, { flexDirection: 'column', paddingX: 1 },
    // Hint line
    React.createElement(Box, null,
      React.createElement(Text, { color: THEME.dim }, hints),
    ),
    // Input line
    React.createElement(Box, null,
      React.createElement(Text, { bold: true, color: THEME.accent }, '> '),
      disabled
        ? React.createElement(Text, { color: THEME.muted }, '...')
        : React.createElement(TextInput, {
            value,
            onChange,
            onSubmit,
            placeholder: 'Type a command...',
          }),
    ),
  );
}
