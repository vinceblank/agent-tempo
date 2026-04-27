/**
 * DisabledWithTooltip — wraps a CTA (`<button>` typically) so it renders
 * disabled with a hover tooltip explaining *why*. Every disabled action
 * in the dashboard MUST surface a reason — vinceblank should never wonder
 * why a button isn't working (architect's testability addendum).
 *
 * **Tooltip strategy** (PR-6 deviation, documented):
 *
 * The brief said "use shadcn Tooltip primitive" but shadcn isn't yet
 * installed in the dashboard (PR-2 set up the Tailwind/Vite scaffold;
 * shadcn comes in a later PR alongside Dialog/Sheet primitives). For PR-6
 * we use the native `title` attribute — accessible, zero deps, and
 * trivially swappable when shadcn lands. The contract surface
 * (`<DisabledWithTooltip reason="…">`) won't change.
 *
 * Click handler logs `disabled-action.attempted` so the conductor can
 * trace UX confusion via `mcp__claude-in-chrome__read_console_messages`.
 */
import type { ReactNode } from 'react';
import { logEvent } from '../lib/log';

export interface DisabledWithTooltipProps {
  /** Test id, e.g. `recruit-submit`. */
  testId: string;
  /** Action name for telemetry (`recruit-submit`, `create-ensemble`, ...). */
  action: string;
  /** Reason shown to the user on hover + screen readers via `title`. */
  reason: string;
  /** Visible label (typically a button's text). */
  children: ReactNode;
  /** Optional extra class for layout. */
  className?: string;
}

export function DisabledWithTooltip({
  testId,
  action,
  reason,
  children,
  className,
}: DisabledWithTooltipProps) {
  return (
    <button
      type="button"
      data-testid={testId}
      data-disabled-reason={reason}
      aria-disabled="true"
      title={reason}
      className={className}
      onClick={(e) => {
        // Suppress the form-submit / nav side effects but DON'T no-op —
        // the log line is the autonomous-validation breadcrumb.
        e.preventDefault();
        logEvent('disabled-action.attempted', { action, reason });
      }}
      style={{
        background: 'var(--bg-2)',
        border: '1px solid var(--rule)',
        borderRadius: 6,
        padding: '6px 14px',
        fontFamily: 'var(--ff-display)',
        fontSize: 14,
        color: 'var(--dim)',
        cursor: 'not-allowed',
        opacity: 0.7,
      }}
    >
      {children}
    </button>
  );
}
