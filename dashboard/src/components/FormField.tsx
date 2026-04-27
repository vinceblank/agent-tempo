/**
 * FormField — shared label + input/textarea + inline error display.
 * Extracted from `CreateEnsemble.tsx` and `Recruit.tsx` (PR-6) to keep
 * the `aria-invalid` / `aria-describedby` wiring in one place; future
 * forms (PR-7+ safe-write flows) can lean on the same primitive.
 */
import type { ReactNode } from 'react';

export interface FormFieldProps {
  /** DOM id used for `<label htmlFor>` and `aria-describedby`. */
  id: string;
  /** Visible label text. */
  label: string;
  /** Stable test id, e.g. `recruit-input-name`. The error span gets `<testId>-error`. */
  testId: string;
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  /** Inline error message; `null`/`undefined` hides the error span. */
  error?: string | null;
  /** When `true`, render `<textarea>` instead of `<input type="text">`. */
  multiline?: boolean;
  /** Trailing slot — e.g. for an inline hint, kept for forward compatibility. */
  hint?: ReactNode;
}

export function FormField({
  id,
  label,
  testId,
  value,
  onChange,
  placeholder,
  error,
  multiline,
  hint,
}: FormFieldProps) {
  const errorId = `${id}-error`;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <label htmlFor={id} style={labelStyle}>
        {label}
      </label>
      {multiline ? (
        <textarea
          id={id}
          data-testid={testId}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          aria-invalid={!!error}
          aria-describedby={error ? errorId : undefined}
          rows={3}
          style={{ ...inputStyle, resize: 'vertical' }}
        />
      ) : (
        <input
          id={id}
          data-testid={testId}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          aria-invalid={!!error}
          aria-describedby={error ? errorId : undefined}
          style={inputStyle}
        />
      )}
      {error && (
        <span
          id={errorId}
          data-testid={`${testId}-error`}
          role="alert"
          style={errorTextStyle}
        >
          {error}
        </span>
      )}
      {hint && <span className="dim" style={{ fontSize: 12 }}>{hint}</span>}
    </div>
  );
}

const labelStyle: React.CSSProperties = {
  fontFamily: 'var(--ff-display)',
  fontSize: 14,
};
const inputStyle: React.CSSProperties = {
  background: 'var(--bg-2)',
  color: 'var(--text)',
  border: '1px solid var(--rule)',
  borderRadius: 6,
  padding: '8px 10px',
  fontFamily: 'var(--ff-mono)',
  fontSize: 14,
};
const errorTextStyle: React.CSSProperties = {
  color: 'var(--accent)',
  fontSize: 12,
};
