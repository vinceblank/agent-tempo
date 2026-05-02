/**
 * ComposerStatus — inline error / info banner anchored to the chat
 * Composer.
 *
 * Part of PR-2 of the chat-notification port (Sonner removal). Replaces
 * the Sonner-based toast surface for composer-scoped feedback (mention
 * parse errors, slash usage errors, slash unsupported, `/help` info).
 * Lives directly above the Composer input so the feedback is attached
 * to the action that produced it rather than buried in a corner toast
 * that scrolls off in 4 s.
 *
 * Parent owns the `(level, message, description?)` state and clears it
 * on the next valid submit (or via the dismiss button). Returns the
 * banner only when the parent supplies a non-null state — otherwise
 * the parent renders nothing, and there's no DOM footprint.
 *
 * Stable testids:
 *   - `composer-status` on the root, with `data-level="error" | "info"`
 *     for filtered queries
 *   - `composer-status-dismiss` on the × button
 */
import type { ReactNode } from 'react';

export type ComposerStatusLevel = 'error' | 'info';

export interface ComposerStatusProps {
  level: ComposerStatusLevel;
  message: string;
  /** Optional sub-line — usage hint, full error detail, list of verbs. */
  description?: ReactNode;
  /** Called when the user clicks ×. Parent clears its state. */
  onDismiss: () => void;
}

export function ComposerStatus({
  level,
  message,
  description,
  onDismiss,
}: ComposerStatusProps) {
  // Inline styles keep this component self-contained — the dashboard's
  // existing CSS doesn't have a banner primitive yet, and adding a
  // one-off `.composer-status` rule to `components.css` for ~5 lines
  // of styling would be premature. If a second screen ever needs the
  // same chrome, lift to a CSS class then.
  return (
    <div
      data-testid="composer-status"
      data-level={level}
      role="alert"
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 12,
        padding: '8px 12px',
        marginBottom: 6,
        background: 'var(--bg-1)',
        border: `1px solid ${
          level === 'error' ? 'var(--accent)' : 'var(--rule-strong)'
        }`,
        borderRadius: 8,
        fontSize: 12.5,
        lineHeight: 1.4,
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ color: 'var(--text)', fontWeight: 500 }}>{message}</div>
        {description !== undefined && (
          <div
            style={{
              marginTop: 3,
              color: 'var(--dim)',
              whiteSpace: 'pre-wrap',
            }}
          >
            {description}
          </div>
        )}
      </div>
      <button
        type="button"
        data-testid="composer-status-dismiss"
        aria-label="Dismiss"
        onClick={onDismiss}
        style={{
          flexShrink: 0,
          width: 22,
          height: 22,
          padding: 0,
          border: 0,
          background: 'transparent',
          color: 'var(--dim)',
          fontSize: 16,
          lineHeight: 1,
          cursor: 'pointer',
          borderRadius: 4,
        }}
      >
        ×
      </button>
    </div>
  );
}
