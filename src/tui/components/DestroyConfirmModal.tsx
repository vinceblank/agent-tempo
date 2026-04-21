/**
 * Typed-name confirmation for `/destroy <ensemble>`. User must type the
 * ensemble name character-for-character before Enter fires the destroy
 * call. Mismatch preserves the input + surfaces an inline error; Esc
 * cancels.
 */
import React, { useCallback } from 'react';
import { useInk } from '../ink-context';
import { THEME } from '../utils/theme';

export interface DestroyConfirmModalProps {
  ensemble: string;
  input: string;
  error?: string;
  submitting?: boolean;
  onInput: (next: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}

export function DestroyConfirmModal(props: DestroyConfirmModalProps): React.ReactElement {
  const { ensemble, input, error, submitting, onInput, onSubmit, onCancel } = props;
  const { Box, Text, TextInput, useInput } = useInk();

  useInput(useCallback((_input: string, key: { escape?: boolean }) => {
    if (!submitting && key.escape) onCancel();
  }, [submitting, onCancel]));

  return React.createElement(Box, { flexDirection: 'column' },
    React.createElement(Text, { bold: true, color: THEME.error }, ' Destroy ensemble'),
    React.createElement(Box, { marginTop: 1, flexDirection: 'column' },
      React.createElement(Text, { color: THEME.text },
        `  Destroying "${ensemble}" will terminate all sessions, the scheduler, and the maestro.`),
      React.createElement(Text, { color: THEME.text },
        `  Type the ensemble name (${ensemble}) to confirm, or Esc to cancel:`),
    ),
    submitting
      ? React.createElement(Box, { marginLeft: 3, marginTop: 1 },
          React.createElement(Text, { color: THEME.warning }, `\u2026 Destroying "${ensemble}"\u2026`),
        )
      : React.createElement(Box, { marginLeft: 3, marginTop: 1 },
          React.createElement(Text, { color: THEME.error }, '> '),
          React.createElement(TextInput, {
            value: input,
            onChange: onInput,
            onSubmit,
          }),
        ),
    error
      ? React.createElement(Text, { color: THEME.error }, `  \u2717 ${error}`)
      : null,
  );
}
