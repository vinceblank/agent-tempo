/** Single-prompt blank-ensemble creation. Enter submits, Esc cancels. */
import React, { useCallback, useState } from 'react';
import { useInk } from '../ink-context';
import { THEME } from '../utils/theme';
import { validateEnsembleName } from '../../utils/validation';

export interface NewEnsembleModalProps {
  onSubmit: (name: string) => void;
  onCancel: () => void;
  submitting?: boolean;
  error?: string | null;
}

export function NewEnsembleModal({ onSubmit, onCancel, submitting, error }: NewEnsembleModalProps): React.ReactElement {
  const { Box, Text, TextInput, useInput } = useInk();
  const [value, setValue] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);

  useInput(useCallback((_input: string, key: { escape?: boolean }) => {
    if (key.escape) onCancel();
  }, [onCancel]));

  const handleSubmit = useCallback((raw: string) => {
    const name = raw.trim();
    if (!name) return;
    const nameError = validateEnsembleName(name);
    if (nameError) {
      setValidationError(nameError);
      return;
    }
    setValidationError(null);
    onSubmit(name);
  }, [onSubmit]);

  const currentError = error ?? validationError;

  return React.createElement(Box, { flexDirection: 'column' },
    React.createElement(Text, { bold: true, color: THEME.accent }, ' New ensemble'),
    React.createElement(Text, { color: THEME.dim }, '  Conductor defaults: name "conductor", agent AGENT_TEMPO_DEFAULT_AGENT.'),
    React.createElement(Box, { marginTop: 1 },
      React.createElement(Text, { color: THEME.accent }, ' ? '),
      React.createElement(Text, { bold: true, color: THEME.text }, 'Ensemble name:'),
    ),
    submitting
      ? React.createElement(Box, { marginLeft: 3, marginTop: 1 },
          React.createElement(Text, { color: THEME.warning }, `\u2026 Creating "${value.trim()}"\u2026`),
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
      ? React.createElement(Text, { color: THEME.error }, `  \u2717 ${currentError}`)
      : null,
    React.createElement(Text, { color: THEME.dim }, '  Enter to create \u00B7 Esc to cancel'),
  );
}
