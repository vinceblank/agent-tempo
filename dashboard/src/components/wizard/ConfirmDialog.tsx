/**
 * ConfirmDialog — small destructive-action confirmation modal.
 * PR-7 of #389.
 *
 * Used by PlayerDetail's `Destroy` button and Settings' `Disband all`
 * danger row. Renders inside a {@link ModalShell}, so esc-to-close +
 * scrim-click-to-cancel come for free.
 *
 * The default Cancel/Confirm button pair carries a `danger` variant on
 * Confirm so the destructive intent reads at a glance. Loading state on
 * the confirm button (via `pending`) blocks double-fires while the
 * underlying mutation is in-flight.
 */
import type { ReactNode } from 'react';
import { ModalShell } from './ModalShell';
import { Dialog } from './Dialog';
import { Btn } from '../Btn';

interface ConfirmDialogProps {
  /** Headline rendered in the dialog `<h>` slot. */
  title: string;
  /** Body content explaining the consequence of the destructive action. */
  children: ReactNode;
  /** Mono badge above the dialog. Defaults to "modal · confirm · esc to close". */
  label?: string;
  /** Label for the destructive button (e.g. "Destroy", "Disband all"). */
  confirmLabel: string;
  /** Optional non-destructive label override (defaults to "Cancel"). */
  cancelLabel?: string;
  /** Called when the user dismisses (esc, scrim, or Cancel). */
  onCancel: () => void;
  /** Called when the user clicks the destructive button. */
  onConfirm: () => void;
  /** Disables the confirm button + shows a "…" spinner suffix. */
  pending?: boolean;
  /** testid prefix; full id is `${testIdPrefix}-{cancel,confirm}`. */
  testIdPrefix: string;
}

export function ConfirmDialog({
  title,
  children,
  label = 'modal · confirm · esc to close',
  confirmLabel,
  cancelLabel = 'Cancel',
  onCancel,
  onConfirm,
  pending = false,
  testIdPrefix,
}: ConfirmDialogProps) {
  return (
    <ModalShell label={label} onClose={onCancel} testId={`${testIdPrefix}-modal`}>
      <Dialog
        title={title}
        testId={`${testIdPrefix}-dialog`}
        footer={
          <div className="row" style={{ marginLeft: 'auto', gap: 8 }}>
            <Btn
              variant="ghost"
              size="md"
              data-testid={`${testIdPrefix}-cancel`}
              onClick={onCancel}
              disabled={pending}
            >
              {cancelLabel}
            </Btn>
            <Btn
              variant="danger"
              size="md"
              data-testid={`${testIdPrefix}-confirm`}
              onClick={onConfirm}
              disabled={pending}
            >
              {pending ? `${confirmLabel}…` : confirmLabel}
            </Btn>
          </div>
        }
      >
        <div style={{ fontSize: 13.5, lineHeight: 1.55, color: 'var(--text)' }}>
          {children}
        </div>
      </Dialog>
    </ModalShell>
  );
}
