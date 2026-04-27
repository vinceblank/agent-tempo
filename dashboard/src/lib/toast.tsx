/**
 * Toast helpers — wraps Sonner's `toast.custom()` so every toast
 * surfaces a stable `data-testid` and `role="alert"`. The conductor's
 * autonomous validator detects toasts via
 * `mcp__claude-in-chrome__find('[data-testid="toast-success"]')` /
 * `read_page`; without these attributes the validator has no
 * deterministic hook into Sonner's internal markup.
 *
 * **Conventions** (architect's testability addendum):
 * - Success toasts auto-dismiss after 4 s; testid `toast-success`.
 * - Error toasts require manual dismiss; testid `toast-error`.
 * - Info toasts auto-dismiss; testid `toast-info`.
 * - All toasts include `role="alert"` for screen-reader semantics.
 */
import { toast as sonner } from 'sonner';

export interface ToastOptions {
  /** Override the default testid (e.g., for action-specific dashboards). */
  testId?: string;
  /** Sub-line under the title. */
  description?: string;
}

type ToastLevel = 'success' | 'error' | 'info';

/** Show a success toast (auto-dismiss). */
export function toastSuccess(message: string, opts: ToastOptions = {}): string | number {
  return showCustom('success', message, opts);
}

/** Show an error toast (manual dismiss). */
export function toastError(message: string, opts: ToastOptions = {}): string | number {
  return showCustom('error', message, opts);
}

/** Generic toast — used for info-level messages (e.g., "release queued"). */
export function toastInfo(message: string, opts: ToastOptions = {}): string | number {
  return showCustom('info', message, opts);
}

function showCustom(level: ToastLevel, message: string, opts: ToastOptions): string | number {
  const testId = opts.testId ?? `toast-${level}`;
  const duration = level === 'error' ? Infinity : 4_000;
  return sonner.custom(
    (id) => (
      <div
        data-testid={testId}
        data-toast-level={level}
        role="alert"
        style={cardStyle(level)}
        onClick={() => sonner.dismiss(id)}
      >
        <div style={titleStyle}>{message}</div>
        {opts.description && <div style={descriptionStyle}>{opts.description}</div>}
      </div>
    ),
    { duration },
  );
}

const titleStyle: React.CSSProperties = {
  fontFamily: 'var(--ff-display)',
  fontSize: 14,
  fontWeight: 500,
};
const descriptionStyle: React.CSSProperties = {
  marginTop: 4,
  fontSize: 12,
  color: 'var(--dim)',
};

function cardStyle(level: ToastLevel): React.CSSProperties {
  const accent =
    level === 'success' ? 'var(--ok)' :
    level === 'error' ? 'var(--accent)' :
    'var(--rule)';
  return {
    background: 'var(--bg-1)',
    border: `1px solid ${accent}`,
    borderRadius: 8,
    padding: '10px 14px',
    color: 'var(--text)',
    minWidth: 240,
    maxWidth: 360,
    cursor: 'pointer',
  };
}
