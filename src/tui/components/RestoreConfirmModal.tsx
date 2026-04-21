/**
 * Single-keypress y/N confirmation before restoring a parked ensemble.
 * Restore is recoverable (operator can `shutdown` again), so no typed
 * confirmation — that's reserved for `destroy`.
 */
import React, { useCallback } from 'react';
import { useInk } from '../ink-context';
import { THEME } from '../utils/theme';

export interface RestoreConfirmModalProps {
  ensemble: string;
  /** Number of parked players in the ensemble (conductor excluded from the count). */
  playerCount: number;
  /** Conductor name if known — falls back to the default "conductor" label. */
  conductorName?: string;
  onConfirm: () => void;
  onCancel: () => void;
  submitting?: boolean;
  error?: string | null;
}

export function RestoreConfirmModal(props: RestoreConfirmModalProps): React.ReactElement {
  const { ensemble, playerCount, conductorName, onConfirm, onCancel, submitting, error } = props;
  const { Box, Text, useInput } = useInk();

  useInput(useCallback((input: string, key: { escape?: boolean; return?: boolean }) => {
    if (submitting) return;
    if (key.escape) { onCancel(); return; }
    const ch = input.toLowerCase();
    if (ch === 'y') { onConfirm(); return; }
    if (ch === 'n' || key.return) { onCancel(); return; }
  }, [submitting, onCancel, onConfirm]));

  const conductorLabel = conductorName ?? 'conductor';

  return React.createElement(Box, { flexDirection: 'column' },
    React.createElement(Text, { bold: true, color: THEME.accent }, ' Restore parked ensemble'),
    React.createElement(Box, { marginTop: 1, flexDirection: 'column' },
      React.createElement(Text, { color: THEME.text }, `  Ensemble: ${ensemble}`),
      React.createElement(Text, { color: THEME.text },
        `  Parked players: ${playerCount}${playerCount === 0 ? ' (conductor only)' : ''}`),
      React.createElement(Text, { color: THEME.text }, `  Conductor: ${conductorLabel}`),
    ),
    error
      ? React.createElement(Text, { color: THEME.error }, `  \u2717 ${error}`)
      : null,
    submitting
      ? React.createElement(Box, { marginTop: 1 },
          React.createElement(Text, { color: THEME.warning }, `\u2026 Restoring "${ensemble}" on this host\u2026`),
        )
      : React.createElement(Box, { marginTop: 1 },
          React.createElement(Text, { bold: true }, '  Restore to this computer? '),
          React.createElement(Text, { color: THEME.dim }, '[y/N] (Esc to cancel)'),
        ),
  );
}
