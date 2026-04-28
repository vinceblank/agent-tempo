/**
 * Field — wizard input row primitive. PR-E of #389.
 *
 * Pairs a `.field-label` (mono uppercase) with arbitrary control
 * markup, plus an optional `· hint` qualifier and an inline error
 * span. The control itself (input/select/textarea/picker/chipset) is
 * the caller's `children`.
 *
 * Error testid follows the convention `${id}-error` so test code can
 * look up by the field's id deterministically.
 */
import type { ReactNode } from 'react';

interface FieldProps {
  id: string;
  label: string;
  hint?: string;
  error?: string | null;
  children: ReactNode;
}

export function Field({ id, label, hint, error, children }: FieldProps) {
  return (
    <div className="field">
      <label htmlFor={id} className="field-label">
        <span>{label}</span>
        {hint && <span className="mono dim">· {hint}</span>}
      </label>
      {children}
      {error && (
        <span
          data-testid={`${id}-error`}
          style={{ fontSize: 11, color: 'var(--err)', fontFamily: 'var(--ff-mono)' }}
        >
          {error}
        </span>
      )}
    </div>
  );
}
