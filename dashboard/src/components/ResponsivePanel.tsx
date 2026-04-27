/**
 * ResponsivePanel — overlay that switches between a side-Sheet on
 * mobile and a Dialog on desktop. The shadcn Dialog/Sheet primitives
 * (Radix-based) aren't installed yet (they land in PR-7 with the
 * destructive-write confirmations); this is a minimal, dependency-free
 * substitute that exposes the same testid surface so the upgrade can
 * be a swap-in.
 *
 * Behaviour:
 *   - Backdrop click closes the panel (parent passes `onClose`).
 *   - Escape key closes the panel.
 *   - On desktop (>= 768px): renders as a right-slide panel,
 *     `data-variant="dialog"`.
 *   - On mobile (< 768px): renders as a bottom-sheet,
 *     `data-variant="sheet"`.
 *   - `role="dialog"` + `aria-modal="true"` regardless of variant so
 *     assistive-tech surfaces it consistently.
 *
 * **Important**: native `<dialog>` is banned by ESLint
 * (`no-restricted-syntax`) because it pauses `claude-in-chrome`. This
 * component uses a `<div role="dialog">` instead — same a11y semantics,
 * MCP-tool-friendly.
 */
import { useEffect, type ReactNode } from 'react';
import { useMediaQuery } from '../lib/use-media-query';

interface ResponsivePanelProps {
  open: boolean;
  onClose: () => void;
  /** Stable test id; appended onto the root element. */
  testId: string;
  /** ARIA-labelled-by target — usually the heading inside `children`. */
  ariaLabel?: string;
  children: ReactNode;
}

const DESKTOP_QUERY = '(min-width: 768px)';

export function ResponsivePanel({
  open,
  onClose,
  testId,
  ariaLabel,
  children,
}: ResponsivePanelProps) {
  const isDesktop = useMediaQuery(DESKTOP_QUERY);
  const variant = isDesktop ? 'dialog' : 'sheet';

  useEffect(() => {
    if (!open) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const panelStyle = isDesktop
    ? {
        position: 'fixed' as const,
        top: 0,
        right: 0,
        bottom: 0,
        width: 'min(480px, 100vw)',
        maxWidth: '100vw',
        background: 'var(--bg-1)',
        borderLeft: '1px solid var(--rule)',
        boxShadow: 'var(--shadow-2)',
      }
    : {
        position: 'fixed' as const,
        left: 0,
        right: 0,
        bottom: 0,
        top: 'auto' as const,
        maxHeight: '85vh',
        background: 'var(--bg-1)',
        borderTop: '1px solid var(--rule)',
        borderTopLeftRadius: 14,
        borderTopRightRadius: 14,
        boxShadow: 'var(--shadow-2)',
      };

  return (
    <div
      data-testid={`${testId}-backdrop`}
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.45)',
        zIndex: 50,
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        data-testid={testId}
        data-variant={variant}
        onClick={(ev) => ev.stopPropagation()}
        style={{
          ...panelStyle,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          zIndex: 51,
        }}
      >
        {children}
      </div>
    </div>
  );
}
