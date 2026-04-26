/**
 * Lineup picker — text input for a lineup name or path. Validation runs
 * through `resolveLineupPath` → `loadLineup` so schema errors (e.g.
 * missing conductor) render inline with the CLI error text.
 */
import React, { useCallback, useState } from 'react';
import { useInk } from '../ink-context';
import { THEME } from '../utils/theme';
import { loadLineup, resolveLineupPath } from '../../ensemble/loader';

export interface LoadLineupModalProps {
  /** Called with the inferred ensemble name + resolved lineup path after a successful validate. */
  onSubmit: (args: { ensemble: string; lineupPath: string }) => void;
  onCancel: () => void;
  submitting?: boolean;
  /** Error surfaced by the caller's submit handler (e.g. spawn failure). */
  error?: string | null;
}

export function LoadLineupModal({ onSubmit, onCancel, submitting, error }: LoadLineupModalProps): React.ReactElement {
  const { Box, Text, TextInput, useInput } = useInk();
  const [value, setValue] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);

  useInput(useCallback((_input: string, key: { escape?: boolean }) => {
    if (key.escape) onCancel();
  }, [onCancel]));

  const handleSubmit = useCallback((raw: string) => {
    const input = raw.trim();
    if (!input) return;
    try {
      const resolved = resolveLineupPath(input);
      const lineup = loadLineup(resolved.path);
      setValidationError(null);
      onSubmit({ ensemble: lineup.name, lineupPath: resolved.path });
    } catch (err) {
      setValidationError(err instanceof Error ? err.message : String(err));
    }
  }, [onSubmit]);

  const currentError = error ?? validationError;

  return React.createElement(Box, { flexDirection: 'column' },
    React.createElement(Text, { bold: true, color: THEME.accent }, ' Load lineup'),
    React.createElement(Text, { color: THEME.dim }, '  Name (saved or shipped) or path to a .yaml file.'),
    React.createElement(Box, { marginTop: 1 },
      React.createElement(Text, { color: THEME.accent }, ' ? '),
      React.createElement(Text, { bold: true, color: THEME.text }, 'Lineup:'),
    ),
    submitting
      ? React.createElement(Box, { marginLeft: 3, marginTop: 1 },
          React.createElement(Text, { color: THEME.warning }, `\u2026 Starting ensemble from "${value.trim()}"\u2026`),
        )
      : React.createElement(Box, { marginLeft: 3, marginTop: 1 },
          React.createElement(Text, { color: THEME.accent }, '> '),
          React.createElement(TextInput, {
            value,
            onChange: (next: string) => { setValue(next); if (validationError) setValidationError(null); },
            onSubmit: handleSubmit,
          }),
        ),
    currentError
      ? React.createElement(Box, { flexDirection: 'column', marginTop: 1 },
          ...currentError.split('\n').map((line, i) =>
            React.createElement(Text, { key: `err-${i}`, color: THEME.error }, `  \u2717 ${line}`),
          ),
        )
      : null,
    React.createElement(Text, { color: THEME.dim }, '  Enter to load \u00B7 Esc to cancel'),
  );
}
